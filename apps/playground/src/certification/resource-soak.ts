import {
  DEFAULT_MAXIMUM_DECODER_LEASES,
  DEFAULT_MAXIMUM_PAGE_PHYSICAL_BYTES,
  DEFAULT_MAXIMUM_PLAYER_LOGICAL_BYTES,
  createRuntimePageResourcePolicy
} from "@pixel-point/aval-player-web";

import { BrowserResourceLedger } from "./resource-ledger.js";
import { createPublicMotionElement, preparePublicMotion, retirePublicMotion } from "./public-element-host.js";

const MAX_SOAK_MS = 30 * 60 * 1_000;

export interface ResourceSoakReport {
  readonly status: "passed" | "failed" | "inconclusive";
  readonly requestedDurationMs: number;
  readonly elapsedMs: number;
  readonly playerCount: number;
  readonly samples: number;
  readonly defaultPolicy: Readonly<{
    maximumDecoderLeases: number;
    maximumPagePhysicalBytes: number;
    maximumPlayerLogicalBytes: number;
  }>;
  readonly peakCounters: Readonly<Record<string, number>>;
  readonly terminalCounters: readonly Readonly<Record<string, number>>[];
  readonly failures: readonly string[];
}

export async function runResourceSoak(options: Readonly<{
  parent: HTMLElement;
  sourceUrl: string;
  sourceIntegrity: string;
  durationMs: number;
  players: number;
  sampleIntervalMs?: number;
  signal?: AbortSignal;
}>): Promise<ResourceSoakReport> {
  const durationMs = boundedInteger(options.durationMs, 0, MAX_SOAK_MS, "soak duration");
  const playerCount = boundedInteger(options.players, 1, 16, "soak player count");
  const sampleIntervalMs = boundedInteger(options.sampleIntervalMs ?? 1_000, 16, 60_000, "soak sample interval");
  const policy = createRuntimePageResourcePolicy();
  if (
    policy.maximumDecoderLeases !== DEFAULT_MAXIMUM_DECODER_LEASES ||
    policy.maximumPagePhysicalBytes !== DEFAULT_MAXIMUM_PAGE_PHYSICAL_BYTES ||
    policy.maximumPlayerLogicalBytes !== DEFAULT_MAXIMUM_PLAYER_LOGICAL_BYTES ||
    !policy.referenceProfile
  ) throw new Error("public default resource policy does not match the reference profile");
  const ledger = new BrowserResourceLedger(Math.min(100_000, playerCount * (Math.ceil(durationMs / sampleIntervalMs) + 4)));
  const batches = playerBatches(playerCount, policy.maximumDecoderLeases);
  const failures: string[] = [];
  const terminalCounters: Readonly<Record<string, number>>[] = Array.from(
    { length: playerCount },
    () => Object.freeze({ player: 0, decoder: 0, bytes: 0 })
  );
  const started = performance.now();
  for (const [batchIndex, indexes] of batches.entries()) {
    if (isAborted(options.signal) || failures.length > 0) break;
    // Connected autoplay elements acquire decoder leases before an explicit
    // prepare() call. Never connect more than the public decoder capacity at
    // once, otherwise Promise.all waits for a lease that no live peer can
    // release until the same Promise.all settles.
    const elements = indexes.map((index) => createPublicMotionElement(
      sourceGenerationUrl(options.sourceUrl, index),
      options.parent,
      undefined,
      options.sourceIntegrity
    ));
    try {
      const initial = await Promise.all(elements.map((element) =>
        preparePublicMotion(element, 20_000, options.signal)
      ));
      initial.forEach((diagnostics, localIndex) => {
        const playerIndex = indexes[localIndex]!;
        ledger.append(`player-${String(playerIndex)}-ready`, diagnostics);
      });
      const batchDurationMs = distributedDuration(
        durationMs,
        batches.length,
        batchIndex
      );
      const batchStarted = performance.now();
      while (
        performance.now() - batchStarted < batchDurationMs &&
        !isAborted(options.signal)
      ) {
        await delay(Math.min(
          sampleIntervalMs,
          Math.max(0, batchDurationMs - (performance.now() - batchStarted))
        ), options.signal);
        elements.forEach((element, localIndex) => {
          const playerIndex = indexes[localIndex]!;
          ledger.append(`player-${String(playerIndex)}-sample`, element.getDiagnostics());
        });
      }
    } catch (error) {
      if (!isAborted(options.signal)) failures.push(error instanceof Error ? error.message : "unknown soak failure");
    } finally {
      const terminal = await Promise.all(elements.map((element, localIndex) =>
        retirePublicMotion(element).catch((error: unknown) => {
          const playerIndex = indexes[localIndex]!;
          failures.push(`player-${String(playerIndex)}:${error instanceof Error ? error.message : "unknown soak cleanup failure"}`);
          return null;
        })
      ));
      terminal.forEach((diagnostics, localIndex) => {
        const playerIndex = indexes[localIndex]!;
        terminalCounters[playerIndex] = Object.freeze(diagnostics === null
          ? { player: 1, decoder: 1, bytes: 1 }
          : {
              player: diagnostics.outstanding.player ?? 0,
              decoder: diagnostics.outstanding.decoder ?? 0,
              bytes: diagnostics.outstanding.bytes ?? 0
            });
      });
    }
  }
  for (const [index, counters] of terminalCounters.entries()) {
    if (Object.values(counters).some((value) => value !== 0)) failures.push(`player-${String(index)}-unsettled`);
  }
  return Object.freeze({
    status: isAborted(options.signal) ? "inconclusive" : failures.length === 0 ? "passed" : "failed",
    requestedDurationMs: durationMs,
    elapsedMs: Math.max(0, Math.floor(performance.now() - started)),
    playerCount,
    samples: ledger.snapshot().length,
    defaultPolicy: Object.freeze({
      maximumDecoderLeases: policy.maximumDecoderLeases,
      maximumPagePhysicalBytes: policy.maximumPagePhysicalBytes,
      maximumPlayerLogicalBytes: policy.maximumPlayerLogicalBytes
    }),
    peakCounters: ledger.peakCounters(),
    terminalCounters: Object.freeze(terminalCounters),
    failures: Object.freeze(failures)
  });
}

function sourceGenerationUrl(sourceUrl: string, index: number): string {
  const url = new URL(sourceUrl, location.href);
  url.hash = `aval-certification-soak-${String(index)}`;
  return `${url.pathname}${url.search}${url.hash}`;
}

function playerBatches(playerCount: number, capacity: number): readonly (readonly number[])[] {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError("decoder lease capacity must be positive");
  }
  const batches: number[][] = [];
  for (let index = 0; index < playerCount; index += capacity) {
    batches.push(Array.from(
      { length: Math.min(capacity, playerCount - index) },
      (_unused, offset) => index + offset
    ));
  }
  return Object.freeze(batches.map((batch) => Object.freeze(batch)));
}

function distributedDuration(totalMs: number, batchCount: number, batchIndex: number): number {
  const base = Math.floor(totalMs / batchCount);
  return base + (batchIndex < totalMs % batchCount ? 1 : 0);
}

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be in ${String(minimum)}..${String(maximum)}`);
  return value;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, milliseconds);
    const abort = (): void => done();
    signal?.addEventListener("abort", abort, { once: true });
    function done(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      resolve();
    }
  });
}
