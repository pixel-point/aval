import type { AvalDiagnostics } from "@pixel-point/aval-element";

import { BrowserResourceLedger } from "./resource-ledger.js";
import {
  createPublicMotionElement,
  preparePublicMotion,
  replacePublicMotionSource,
  retirePublicMotion
} from "./public-element-host.js";
import { RouteLedger } from "./route-ledger.js";

export interface LifecycleStressReport {
  readonly requestedCycles: number;
  readonly completedCycles: number;
  readonly sourceReplacements: number;
  readonly adoptionCycles: number;
  readonly status: "passed" | "failed" | "inconclusive";
  readonly failures: readonly string[];
  readonly peakCounters: Readonly<Record<string, number>>;
  readonly terminalCounters: Readonly<Record<string, number>>;
  readonly routeEvents: number;
}

export async function runLifecycleStress(options: Readonly<{
  parent: HTMLElement;
  sourceUrl: string;
  sourceIntegrity: string;
  alternateSourceUrl?: string;
  alternateSourceIntegrity?: string;
  cycles: number;
  signal?: AbortSignal;
}>): Promise<LifecycleStressReport> {
  const cycles = boundedCount(options.cycles, 1, 100, "lifecycle cycles");
  const resources = new BrowserResourceLedger(cycles * 4 + 1);
  const routes = new RouteLedger(cycles * 64 + 1);
  const failures: string[] = [];
  let completedCycles = 0;
  let sourceReplacements = 0;
  let adoptionCycles = 0;
  let final: Readonly<AvalDiagnostics> | null = null;
  for (let cycle = 0; cycle < cycles; cycle += 1) {
    if (options.signal?.aborted === true) break;
    const element = createPublicMotionElement(
      sourceGenerationUrl(options.sourceUrl, "cycle", cycle),
      options.parent,
      routes,
      options.sourceIntegrity
    );
    try {
      resources.append(`cycle-${String(cycle)}-connected`, await preparePublicMotion(element, 20_000, options.signal));
      element.pause();
      await element.resume();
      if (options.alternateSourceUrl !== undefined) {
        if (options.alternateSourceIntegrity === undefined) throw new Error("alternate lifecycle source requires exact integrity");
        replacePublicMotionSource(
          element,
          sourceGenerationUrl(options.alternateSourceUrl, "replace", cycle),
          options.alternateSourceIntegrity
        );
        resources.append(`cycle-${String(cycle)}-replaced`, await preparePublicMotion(element, 20_000, options.signal));
        sourceReplacements += 1;
      }
      const adoptedHost = document.createElement("section");
      options.parent.append(adoptedHost);
      adoptedHost.append(element);
      await nextAnimationFrame();
      options.parent.append(element);
      adoptedHost.remove();
      adoptionCycles += 1;
      final = await retirePublicMotion(element);
      resources.append(`cycle-${String(cycle)}-terminal`, final);
      const unsettled = Object.entries(final.outstanding).filter(([, value]) => value !== 0);
      if (unsettled.length > 0) failures.push(`cycle-${String(cycle)}-unsettled:${unsettled.map(([name]) => name).join(",")}`);
      completedCycles += 1;
    } catch (error) {
      failures.push(`cycle-${String(cycle)}:${error instanceof Error ? error.message : "unknown failure"}`);
      final = await retirePublicMotion(element).catch(() => null);
      break;
    }
  }
  const terminalCounters = final === null
    ? Object.freeze({})
    : Object.freeze({
        player: final.outstanding.player ?? 0,
        decoder: final.outstanding.decoder ?? 0,
        bytes: final.outstanding.bytes ?? 0
      });
  return Object.freeze({
    requestedCycles: cycles,
    completedCycles,
    sourceReplacements,
    adoptionCycles,
    status: options.signal?.aborted === true
      ? "inconclusive"
      : failures.length === 0 && completedCycles === cycles ? "passed" : "failed",
    failures: Object.freeze(failures),
    peakCounters: resources.peakCounters(),
    terminalCounters,
    routeEvents: routes.snapshot().length
  });
}

function sourceGenerationUrl(sourceUrl: string, operation: "cycle" | "replace", cycle: number): string {
  const url = new URL(sourceUrl, location.href);
  url.hash = `aval-certification-${operation}-${String(cycle)}`;
  return `${url.pathname}${url.search}${url.hash}`;
}

function boundedCount(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be in ${String(minimum)}..${String(maximum)}`);
  return value;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
