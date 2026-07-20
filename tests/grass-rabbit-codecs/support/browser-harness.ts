import {
  expect,
  type JSHandle,
  type Page
} from "@playwright/test";

export const CODECS = Object.freeze(["av1", "vp9", "h265", "h264"] as const);
export type Codec = typeof CODECS[number];
export type SupportState = "supported" | "unsupported" | "unavailable";

export const CODEC_LABELS = Object.freeze({
  av1: "AV1",
  vp9: "VP9",
  h265: "H.265 / HEVC",
  h264: "H.264 / AVC"
} as const satisfies Readonly<Record<Codec, string>>);

export const CODEC_PATTERNS = Object.freeze({
  av1: /^av01\./u,
  vp9: /^vp09\./u,
  h265: /^hvc1\./u,
  h264: /^avc1\./u
} as const satisfies Readonly<Record<Codec, RegExp>>);

export const SUPPORT_MESSAGES = Object.freeze({
  unsupported: "This codec is not supported in your browser.",
  unavailable: "Codec support could not be checked in your browser."
} as const satisfies Readonly<
  Record<Exclude<SupportState, "supported">, string>
>);

interface CleanupDiagnostics {
  readonly completed: boolean;
  readonly failureCount: number;
  readonly participantLogicalBytes: number;
  readonly participantActiveLeaseCount: number;
  readonly workerCount: number;
  readonly openFrames: number;
  readonly pagePhysicalBytes: number;
  readonly pageParticipantCount: number;
}

interface ElementOwnershipDiagnostics {
  readonly listenerCount: number;
  readonly observerCount: number;
  readonly brokerSubscriptionCount: number;
  readonly timerCount: number;
  readonly pendingCommandCount: number;
  readonly failedReleaseCount: number;
  readonly retainedRetryCount: number;
  readonly releaseFailureCount: number;
  readonly completed: boolean;
}

interface TerminalCleanupDiagnostics {
  readonly completed: boolean;
  readonly sourceCleanupCompleted: boolean;
  readonly elementOwnership: Readonly<ElementOwnershipDiagnostics>;
}

interface RuntimeTraceRecord {
  readonly index: number;
  readonly graph?: Readonly<{
    readonly presentation?: Readonly<{
      readonly kind?: string;
      readonly state?: string;
      readonly unitId?: string;
      readonly frameIndex?: number;
    }> | null;
  }> | null;
  readonly media?: Readonly<{
    readonly kind?: string;
    readonly frame?: Readonly<{
      readonly unit?: string;
      readonly localFrame?: number;
    }>;
  }> | null;
}

interface PlayerDiagnostics {
  readonly sourceGeneration: number;
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly isTransitioning: boolean;
  readonly lastFailure: unknown;
  readonly counters: Readonly<{ readonly underflow: number }>;
  readonly cleanup: Readonly<CleanupDiagnostics> | null;
  readonly terminalCleanup: Readonly<TerminalCleanupDiagnostics> | null;
  readonly runtime: Readonly<{ readonly selectedCodec: string | null }>;
  readonly runtimeTrace?: readonly Readonly<RuntimeTraceRecord>[];
}

interface GrassRabbitPlayer extends HTMLElement {
  readonly readiness: string;
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly isTransitioning: boolean;
  dispose(): Promise<unknown>;
  getDiagnostics(
    options?: Readonly<{ trace?: boolean }>
  ): Readonly<PlayerDiagnostics>;
}

interface GrassRabbitCodecsApi {
  readonly ready: Promise<void>;
  readonly activePlayer: GrassRabbitPlayer | null;
  activate(codec: Codec): Promise<void>;
  supportSnapshot(): Readonly<Record<Codec, SupportState>>;
}

declare global {
  interface Window {
    readonly grassRabbitCodecs: GrassRabbitCodecsApi;
  }
}

interface BrowserFailures {
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
}

interface PreviousPlayer {
  readonly handle: JSHandle<GrassRabbitPlayer | null>;
  readonly codec: Codec | null;
}

export function codecTab(page: Page, codec: Codec) {
  return page.locator(`[role="tab"][data-codec="${codec}"]`);
}

export function codecPanel(page: Page, codec: Codec) {
  return page.locator(`[role="tabpanel"][data-codec="${codec}"]`);
}

export async function requireId(
  locator: ReturnType<Page["locator"]>
): Promise<string> {
  const id = await locator.getAttribute("id");
  expect(id).toMatch(/\S/u);
  return id!;
}

export async function openExample(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(async () => {
    if (window.grassRabbitCodecs === undefined) {
      throw new Error("grassRabbitCodecs example API is unavailable");
    }
    await window.grassRabbitCodecs.ready;
  });
}

export async function supportSnapshot(
  page: Page
): Promise<Readonly<Record<Codec, SupportState>>> {
  const snapshot = await page.evaluate(() =>
    window.grassRabbitCodecs.supportSnapshot()
  );
  expect(Object.keys(snapshot).sort()).toEqual([...CODECS].sort());
  for (const codec of CODECS) {
    expect(["supported", "unsupported", "unavailable"])
      .toContain(snapshot[codec]);
  }
  return snapshot;
}

export async function activateFirstInteractiveCodec(
  page: Page,
  support: Readonly<Record<Codec, SupportState>>
): Promise<Codec | undefined> {
  for (const codec of CODECS) {
    if (support[codec] !== "supported") continue;
    await codecTab(page, codec).click();
    await codecPanel(page, codec).scrollIntoViewIfNeeded();
    await page.evaluate(async (requested) => {
      await window.grassRabbitCodecs.activate(requested);
    }, codec);
    const snapshot = await activePlayerSnapshot(page);
    if (snapshot.readiness === "interactiveReady" && snapshot.lastFailure === null) {
      return codec;
    }
  }
  return undefined;
}

export async function selectedCodec(page: Page): Promise<Codec> {
  const selected = page.locator('[role="tab"][aria-selected="true"]');
  await expect(selected).toHaveCount(1);
  const value = await selected.getAttribute("data-codec");
  expect(CODECS).toContain(value);
  return value as Codec;
}

export async function expectSelectedPanel(
  page: Page,
  selected: Codec,
  tabbable: Codec = selected
): Promise<void> {
  for (const codec of CODECS) {
    const isSelected = codec === selected;
    await expect(codecTab(page, codec)).toHaveAttribute(
      "aria-selected",
      String(isSelected)
    );
    await expect(codecTab(page, codec)).toHaveAttribute(
      "tabindex",
      codec === tabbable ? "0" : "-1"
    );
    await expect.poll(() => codecPanel(page, codec).evaluate((panel) => (
      panel as HTMLElement
    ).hidden)).toBe(!isSelected);
  }
}

export function captureBrowserFailures(page: Page): BrowserFailures {
  const failures: BrowserFailures = { consoleErrors: [], pageErrors: [] };
  page.on("console", (message) => {
    if (message.type() === "error") failures.consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => failures.pageErrors.push(error.message));
  return failures;
}

export async function gateBuildReport(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/grass-rabbit/build.json", async (route) => {
    await gate;
    await route.continue();
  });
  return release;
}

export async function installStaticPreparationOutcome(
  page: Page,
  input: Readonly<{
    reason: string;
    failure: Readonly<{
      code: string;
      message: string;
      operation: string;
    }> | null;
  }>
): Promise<void> {
  await page.evaluate(async ({ reason, failure }) => {
    await customElements.whenDefined("aval-player");
    const constructor = customElements.get("aval-player");
    if (constructor === undefined) throw new Error("aval-player is undefined");
    const prototype = constructor.prototype;
    const originalDiagnostics = prototype.getDiagnostics as (
      options?: Readonly<{ trace?: boolean }>
    ) => Readonly<Record<string, unknown>>;
    Object.defineProperty(prototype, "prepare", {
      configurable: true,
      value: async () => Object.freeze({
        mode: "static",
        reason,
        report: Object.freeze({
          readiness: "staticReady",
          selectedRendition: null,
          candidates: Object.freeze([])
        })
      })
    });
    Object.defineProperty(prototype, "readiness", {
      configurable: true,
      get: () => "staticReady"
    });
    Object.defineProperty(prototype, "staticReason", {
      configurable: true,
      get: () => reason
    });
    if (failure === null) return;
    Object.defineProperty(prototype, "getDiagnostics", {
      configurable: true,
      value(this: HTMLElement, options?: Readonly<{ trace?: boolean }>) {
        return Object.freeze({
          ...originalDiagnostics.call(this, options),
          lastFailure: failure
        });
      }
    });
  }, input);
}

export async function installRetainedNonfatalDiagnostic(
  page: Page,
  failure: Readonly<{
    code: string;
    message: string;
    operation: string;
  }>
): Promise<void> {
  await page.evaluate(async (retainedFailure) => {
    await customElements.whenDefined("aval-player");
    const constructor = customElements.get("aval-player");
    if (constructor === undefined) throw new Error("aval-player is undefined");
    const prototype = constructor.prototype;
    const originalDiagnostics = prototype.getDiagnostics as (
      options?: Readonly<{ trace?: boolean }>
    ) => Readonly<Record<string, unknown>>;
    Object.defineProperty(prototype, "getDiagnostics", {
      configurable: true,
      value(this: HTMLElement, options?: Readonly<{ trace?: boolean }>) {
        return Object.freeze({
          ...originalDiagnostics.call(this, options),
          lastFailure: retainedFailure
        });
      }
    });
  }, failure);
}

export function expectNoBrowserFailures(failures: BrowserFailures): void {
  expect(failures.consoleErrors).toEqual([]);
  expect(failures.pageErrors).toEqual([]);
}

export async function capturePreviousPlayer(
  page: Page
): Promise<PreviousPlayer> {
  const handle = await page.evaluateHandle(() =>
    window.grassRabbitCodecs.activePlayer
  );
  const snapshot = await page.evaluate((player) => {
    if (player === null) return null;
    const codec = player.closest<HTMLElement>(
      '[role="tabpanel"][data-codec]'
    )?.dataset.codec ?? null;
    return { codec };
  }, handle);
  return {
    handle,
    codec: snapshot?.codec as Codec | null ?? null
  };
}

export async function expectPreviousPlayerCleanup(
  page: Page,
  previous: PreviousPlayer,
  activatedCodec: Codec
): Promise<boolean> {
  const relationship = await page.evaluate((player) => ({
    existed: player !== null,
    stillActive:
      player !== null && window.grassRabbitCodecs.activePlayer === player
  }), previous.handle);
  if (!relationship.existed) {
    await previous.handle.dispose();
    return false;
  }
  if (relationship.stillActive && previous.codec === activatedCodec) {
    await previous.handle.dispose();
    return false;
  }
  expect(relationship.stillActive).toBe(false);

  await expect.poll(() => page.evaluate((player) => {
    if (player === null) return null;
    const diagnostics = player.getDiagnostics();
    return {
      cleanup: diagnostics.cleanup,
      terminalCleanup: diagnostics.terminalCleanup
    };
  }, previous.handle), { timeout: 30_000 }).toMatchObject({
    cleanup: {
      completed: true,
      failureCount: 0,
      participantLogicalBytes: 0,
      participantActiveLeaseCount: 0,
      workerCount: 0,
      openFrames: 0,
      pagePhysicalBytes: 0,
      pageParticipantCount: 0
    },
    terminalCleanup: {
      completed: true,
      sourceCleanupCompleted: true,
      elementOwnership: {
        listenerCount: 0,
        observerCount: 0,
        brokerSubscriptionCount: 0,
        timerCount: 0,
        pendingCommandCount: 0,
        failedReleaseCount: 0,
        retainedRetryCount: 0,
        releaseFailureCount: 0,
        completed: true
      }
    }
  });
  await previous.handle.dispose();
  return true;
}

export async function expectActiveCodecPlayer(
  page: Page,
  codec: Codec
): Promise<void> {
  await expect(codecPanel(page, codec).locator("aval-player")).toHaveCount(1);
  await expect.poll(() => page.evaluate((requested) => {
    const player = window.grassRabbitCodecs.activePlayer;
    return player?.closest<HTMLElement>(
      '[role="tabpanel"][data-codec]'
    )?.dataset.codec === requested;
  }, codec)).toBe(true);
}

export async function activePlayerSources(page: Page): Promise<Codec[]> {
  const codecStrings = await page.evaluate(() => {
    const player = window.grassRabbitCodecs.activePlayer;
    if (player === null) return [];
    return [...player.querySelectorAll("source")].map((source) => {
      const match = /^application\/vnd\.aval; codecs="([^"]+)"$/u.exec(
        source.type
      );
      if (match === null) throw new Error("active player source type is invalid");
      return match[1]!;
    });
  });
  return codecStrings.map((codecString) => {
    const codec = CODECS.find((candidate) =>
      CODEC_PATTERNS[candidate].test(codecString)
    );
    if (codec === undefined) throw new Error("active player codec is unknown");
    return codec;
  });
}

export async function activePlayerSnapshot(page: Page): Promise<Readonly<{
  readiness: string | null;
  requestedState: string | null;
  visualState: string | null;
  isTransitioning: boolean | null;
  selectedCodec: string | null;
  lastFailure: unknown;
  underflow: number | null;
}>> {
  return page.evaluate(() => {
    const player = window.grassRabbitCodecs.activePlayer;
    if (player === null) return {
      readiness: null,
      requestedState: null,
      visualState: null,
      isTransitioning: null,
      selectedCodec: null,
      lastFailure: null,
      underflow: null
    };
    const diagnostics = player.getDiagnostics();
    return {
      readiness: player.readiness,
      requestedState: player.requestedState,
      visualState: player.visualState,
      isTransitioning: player.isTransitioning,
      selectedCodec: diagnostics.runtime.selectedCodec,
      lastFailure: diagnostics.lastFailure,
      underflow: diagnostics.counters.underflow
    };
  });
}

export async function expectVisualState(
  page: Page,
  state: string
): Promise<void> {
  await expect.poll(() => page.evaluate(() =>
    window.grassRabbitCodecs.activePlayer?.visualState ?? null
  ), { timeout: 30_000 }).toBe(state);
}

export async function traceContainsUnit(
  page: Page,
  unit: string
): Promise<boolean> {
  return page.evaluate((expectedUnit) => {
    const trace = window.grassRabbitCodecs.activePlayer
      ?.getDiagnostics({ trace: true }).runtimeTrace ?? [];
    return trace.some((record) =>
      record.graph?.presentation?.unitId === expectedUnit
    );
  }, unit);
}

export async function activeTraceUnits(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const trace = window.grassRabbitCodecs.activePlayer
      ?.getDiagnostics({ trace: true }).runtimeTrace ?? [];
    const units: string[] = [];
    for (const record of trace) {
      const unit = record.graph?.presentation?.unitId;
      if (typeof unit === "string" && units.at(-1) !== unit) units.push(unit);
    }
    return units;
  });
}

export function expectOrderedSubsequence(
  actual: readonly string[],
  expected: readonly string[]
): void {
  let cursor = 0;
  for (const value of actual) {
    if (value === expected[cursor]) cursor += 1;
    if (cursor === expected.length) break;
  }
  expect(
    cursor,
    `expected ordered units ${expected.join(" -> ")}; got ${actual.join(" -> ")}`
  ).toBe(expected.length);
}
