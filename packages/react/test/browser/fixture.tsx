import type { AvalSources } from "@pixel-point/aval-react";
import { useAval } from "@pixel-point/aval-react";
import { StrictMode, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

import type { FakeAvalElementHandle } from "./fake-aval-element.js";

export interface AvalReactBrowserHarness {
  replaceSource(): Promise<Readonly<{
    sameHost: boolean;
    replacementSrc: string | null;
    resolvedOldPreparations: number;
    staleReadyCount: number;
  }>>;
  replaceTarget(): Promise<Readonly<{
    initialTargetApplied: boolean;
    replacementTargetApplied: boolean;
    sameHost: boolean;
  }>>;
  resolveCurrentPreparation(): Promise<Readonly<{
    resolvedPreparations: number;
    readyCount: number;
  }>>;
  callbackCounts(): Readonly<{
    requested: number;
    visual: number;
    transitionStart: number;
    transitionEnd: number;
  }>;
  preparationCount(source: string): number;
  remount(): Promise<Readonly<{
    detachedElementHandledFatal: boolean;
    automaticDisposeCount: number;
    snapshotSubscriberCount: number;
    interactionTargetCleared: boolean;
  }>>;
}

declare global {
  interface Window {
    avalReactHarness: AvalReactBrowserHarness;
  }
}

const INITIAL_SOURCE = "/forced-early-fatal.avl";
const REPLACEMENT_SOURCE = "/forced-replacement.avl";
const rootElement = requireElement<HTMLElement>("#root");
const fatalCountElement = requireElement<HTMLOutputElement>("#fatal-count");

const root = createRoot(rootElement);
let fatalCount = 0;
let readyCount = 0;
let requestedCount = 0;
let visualCount = 0;
let transitionStartCount = 0;
let transitionEndCount = 0;
let instance = 0;
let targetVersion = 0;
let forcedSources: AvalSources = Object.freeze({ h264: INITIAL_SOURCE });

function renderInstance(): void {
  root.render(
    <StrictMode>
      <ListenerTimingTree />
    </StrictMode>
  );
}

function ListenerTimingTree() {
  const targetRef = useRef<HTMLDivElement>(null);
  return <>
    <div
      ref={targetVersion === 0 ? targetRef : null}
      data-target-version={targetVersion === 0 ? "0" : undefined}
    >
      <ListenerTimingMotion
        key={`motion-${String(instance)}`}
        sources={forcedSources}
        bindTo={targetRef}
        state={`instance-${String(instance)}`}
      />
    </div>
    {targetVersion > 0 && (
      <div ref={targetRef} data-target-version={String(targetVersion)} />
    )}
  </>;
}

function ListenerTimingMotion({
  sources,
  bindTo,
  state
}: Readonly<{
  readonly sources: AvalSources;
  readonly bindTo: React.RefObject<Element | null>;
  readonly state: string;
}>) {
  const [failed, setFailed] = useState(false);
  const { aval, AvalComponent } = useAval({
    sources,
    state,
    onReady: (result) => {
      if (result.report.readiness === "interactiveReady") setFailed(false);
      readyCount += 1;
    },
    onRequestedStateChange: () => { requestedCount += 1; },
    onVisualStateChange: () => { visualCount += 1; },
    onTransitionStart: () => { transitionStartCount += 1; },
    onTransitionEnd: () => { transitionEndCount += 1; },
    onError: (detail) => {
      if (!detail.fatal) return;
      setFailed(true);
      fatalCount += 1;
      fatalCountElement.value = String(fatalCount);
    }
  });

  return <>
    <AvalComponent
      width={160}
      height={160}
      bindTo={bindTo}
      data-mounted={aval.mounted ? "true" : "false"}
      aria-hidden
    />
    {(failed || aval.lastError?.fatal === true) && (
      <span className="motion-fallback" aria-hidden="true">{state}</span>
    )}
  </>;
}

function currentElement(): FakeAvalElementHandle | null {
  return rootElement.querySelector("aval-player") as FakeAvalElementHandle | null;
}

window.avalReactHarness = Object.freeze({
  async replaceSource() {
    const before = currentElement();
    const readyCountBeforeReplacement = readyCount;
    forcedSources = Object.freeze({ h264: REPLACEMENT_SOURCE });
    flushSync(renderInstance);
    const after = currentElement();
    const resolvedOldPreparations = after?.resolvePreparationsForSource(
      INITIAL_SOURCE
    ) ?? -1;
    await Promise.resolve();
    return Object.freeze({
      sameHost: before !== null && before === after,
      replacementSrc: after?.querySelector("source")?.getAttribute("src") ?? null,
      resolvedOldPreparations,
      staleReadyCount: readyCount - readyCountBeforeReplacement
    });
  },

  async replaceTarget() {
    const before = currentElement();
    const initialTargetApplied = before?.interactionTarget?.getAttribute(
      "data-target-version"
    ) === "0";
    targetVersion += 1;
    flushSync(renderInstance);
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const after = currentElement();
    return Object.freeze({
      initialTargetApplied,
      replacementTargetApplied: after?.interactionTarget?.getAttribute(
        "data-target-version"
      ) === "1",
      sameHost: before !== null && before === after
    });
  },

  async resolveCurrentPreparation() {
    const element = currentElement();
    const readyCountBeforeResolution = readyCount;
    const resolvedPreparations = element?.resolvePreparationsForSource(
      REPLACEMENT_SOURCE
    ) ?? -1;
    await Promise.resolve();
    return Object.freeze({
      resolvedPreparations,
      readyCount: readyCount - readyCountBeforeResolution
    });
  },

  callbackCounts() {
    return Object.freeze({
      requested: requestedCount,
      visual: visualCount,
      transitionStart: transitionStartCount,
      transitionEnd: transitionEndCount
    });
  },

  preparationCount(source: string) {
    return currentElement()?.preparationCountForSource(source) ?? -1;
  },

  async remount() {
    const detachedElement = currentElement();
    flushSync(() => root.render(null));
    const beforeDetachedDispatch = fatalCount;
    detachedElement?.dispatchEvent(new CustomEvent("error", {
      detail: {
        generation: 1,
        fatal: true,
        failure: {
          code: "detached-fatal",
          message: "detached fatal",
          operation: "listener-timing"
        }
      }
    }));
    const result = Object.freeze({
      detachedElementHandledFatal: fatalCount !== beforeDetachedDispatch,
      automaticDisposeCount: detachedElement?.automaticDisposeCount ?? -1,
      snapshotSubscriberCount: detachedElement?.snapshotSubscriberCount ?? -1,
      interactionTargetCleared: detachedElement?.interactionTarget === null
    });
    instance += 1;
    renderInstance();
    return result;
  }
}) satisfies AvalReactBrowserHarness;

renderInstance();

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) {
    throw new Error(`listener timing test markup is missing ${selector}`);
  }
  return element;
}
