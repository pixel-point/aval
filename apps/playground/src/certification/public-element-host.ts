import type {
  AvalDiagnostics,
  AvalElement,
  AvalElementEventMap
} from "@pixel-point/aval-element";

import type { RouteLedger } from "./route-ledger.js";
import { FUNCTIONAL_SOURCE_TYPE } from "./functional-fixture.js";

export const PUBLIC_EVENT_NAMES = Object.freeze([
  "requestedstatechange",
  "transitionstart",
  "visualstatechange",
  "transitionend",
  "underflow",
  "error"
] as const);

const consumerAlternates = new WeakMap<AvalElement, HTMLElement>();

export function createPublicMotionElement(
  sourceUrl: string,
  parent: HTMLElement,
  routeLedger?: RouteLedger,
  integrity?: string,
  errorObserver?: EventListener
): AvalElement {
  const element = document.createElement("aval-player");
  element.className = "certification-motion";
  element.autoplay = "visible";
  element.motion = "full";
  const source = document.createElement("source");
  source.src = sourceUrl;
  source.type = FUNCTIONAL_SOURCE_TYPE;
  if (integrity !== undefined) source.setAttribute("integrity", integrity);
  const alternate = document.createElement("span");
  alternate.className = "certification-motion-unavailable";
  alternate.textContent = "Motion unavailable";
  alternate.hidden = true;
  element.append(source);
  element.addEventListener("error", ((event: AvalElementEventMap["error"]) => {
    if (!event.detail.fatal) return;
    alternate.hidden = false;
  }) as EventListener);
  element.addEventListener("readinesschange", () => {
    if (element.readiness !== "interactiveReady") return;
    alternate.hidden = true;
  });
  if (errorObserver !== undefined) element.addEventListener("error", errorObserver);
  consumerAlternates.set(element, alternate);
  if (routeLedger !== undefined) attachRouteLedger(element, routeLedger);
  parent.append(element, alternate);
  return element;
}

export function replacePublicMotionSource(
  element: AvalElement,
  sourceUrl: string,
  integrity?: string
): void {
  const source = element.querySelector(":scope > source");
  if (!(source instanceof HTMLSourceElement)) {
    throw new Error("public motion source is unavailable");
  }
  // Source replacement is an explicit consumer recovery attempt. The host is
  // deliberately kept laid out while the consumer-owned alternate is shown,
  // so this cannot create a visibility-suspended replacement generation.
  const alternate = consumerAlternates.get(element);
  if (alternate !== undefined) alternate.hidden = false;
  source.src = sourceUrl;
  if (integrity === undefined) source.removeAttribute("integrity");
  else source.setAttribute("integrity", integrity);
}

export async function preparePublicMotion(
  element: AvalElement,
  timeoutMs = 20_000,
  signal?: AbortSignal
): Promise<Readonly<AvalDiagnostics>> {
  await waitForEffectiveVisibility(element, Math.min(timeoutMs, 2_000), signal);
  await element.prepare({ timeoutMs, ...(signal === undefined ? {} : { signal }) });
  let diagnostics = element.getDiagnostics({ trace: true });
  if (diagnostics.readiness === "staticReady") {
    diagnostics = await waitForInteractiveRecovery(
      element,
      Math.min(timeoutMs, 5_000),
      signal
    );
  }
  if (diagnostics.readiness !== "interactiveReady") {
    throw new Error(`unexpected public readiness ${diagnostics.readiness}`);
  }
  return diagnostics;
}

async function waitForInteractiveRecovery(
  element: AvalElement,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Readonly<AvalDiagnostics>> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const diagnostics = element.getDiagnostics({ trace: true });
    if (diagnostics.readiness !== "staticReady") return diagnostics;
    if (performance.now() >= deadline) {
      throw new Error("public element did not become interactive after nonfatal static policy");
    }
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

async function waitForEffectiveVisibility(
  element: AvalElement,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const rectangle = element.getBoundingClientRect();
    if (
      rectangle.width > 0 && rectangle.height > 0 &&
      element.getDiagnostics().effectivelyVisible
    ) return;
    if (performance.now() >= deadline) {
      throw new Error("public element did not become effectively visible before preparation");
    }
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
}

export async function retirePublicMotion(element: AvalElement): Promise<Readonly<AvalDiagnostics>> {
  element.remove();
  consumerAlternates.get(element)?.remove();
  consumerAlternates.delete(element);
  await element.dispose();
  const diagnostics = element.getDiagnostics({ trace: true });
  if (!diagnostics.finalDisposed || diagnostics.readiness !== "disposed") {
    throw new Error("public element did not enter terminal disposal");
  }
  return diagnostics;
}

function attachRouteLedger(element: AvalElement, ledger: RouteLedger): void {
  for (const type of PUBLIC_EVENT_NAMES) {
    element.addEventListener(type, ((event: AvalElementEventMap[typeof type]) => {
      const detail = event.detail as unknown as Record<string, unknown>;
      ledger.append({
        event: type,
        timestampMicroseconds: nowMicroseconds(),
        generation: number(detail.generation),
        from: nullableText(detail.from),
        to: nullableText(detail.to),
        edge: nullableText(detail.edge),
        requestedState: element.requestedState,
        visualState: element.visualState,
        transitioning: element.isTransitioning
      });
    }) as EventListener);
  }
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value.slice(0, 128) : null;
}

function number(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function nowMicroseconds(): number {
  return Math.max(0, Math.floor(performance.timeOrigin * 1_000 + performance.now() * 1_000));
}
