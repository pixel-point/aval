import { expect, test } from "@playwright/test";
import { SOURCE_CODEC_PRIORITY } from "@pixel-point/aval-element";

import { QUALIFIED_FIXTURE_PREFIX } from
  "../../apps/playground/fixture-routes.js";

const CODEC_ORDER = SOURCE_CODEC_PRIORITY;

interface BrowserOutcome {
  readonly readiness: string;
  readonly selectedCodec: string | null;
  readonly selectedRendition: string | null;
  readonly sourceGeneration: number;
  readonly error: string | null;
}

interface FixtureMetrics {
  readonly requests: readonly Readonly<{
    readonly path: string;
    readonly range: string | null;
    readonly status: number;
  }>[];
}

interface StartupFailoverProbe {
  readonly attempts: readonly Readonly<{
    readonly codec: string;
    readonly commands: readonly string[];
    readonly configuredSupported: boolean;
    readonly delegated: boolean;
    readonly invalidOutput: boolean;
    readonly terminated: boolean;
  }>[];
  readonly publicEvents: readonly Readonly<{
    readonly type: string;
    readonly from: string | null;
    readonly to: string | null;
    readonly fatal: boolean | null;
  }>[];
  readonly animatedReveals: number;
}

test("uses the highest-priority supported source and never probes a lower-priority file", async ({
  browserName,
  page,
  request
}) => {
  test.setTimeout(90_000);
  const session = uniqueSession("selection");
  await page.goto(`/?session=${session}&integrity=0`);
  const outcome = await page.evaluate(async (): Promise<BrowserOutcome> => {
    const api = (window as unknown as {
      avalSourcePlayground: {
        readonly ready: Promise<void>;
        readonly player: HTMLElement & {
          readonly readiness?: string;
          getDiagnostics?(): Readonly<{
            sourceGeneration: number;
            runtime: Readonly<{
              selectedCodec: string | null;
              selectedRendition: string | null;
            }>;
          }>;
        };
      };
    }).avalSourcePlayground;
    let error: string | null = null;
    try {
      await api.ready;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "unknown initialization failure";
    }
    const diagnostics = api.player.getDiagnostics?.();
    return {
      readiness: api.player.readiness ?? "unavailable",
      selectedCodec: diagnostics?.runtime.selectedCodec ?? null,
      selectedRendition: diagnostics?.runtime.selectedRendition ?? null,
      sourceGeneration: diagnostics?.sourceGeneration ?? 0,
      error
    };
  });

  const metricsResponse = await request.get(
    `${QUALIFIED_FIXTURE_PREFIX}metrics?session=${session}`
  );
  expect(metricsResponse.ok()).toBe(true);
  const metrics = await metricsResponse.json() as FixtureMetrics;
  const assetRequests = metrics.requests.filter(({ path }) => path.endsWith(".avl"));
  const distinctPaths = assetRequests
    .map(({ path }) => path)
    .filter((path, index, paths) => index === 0 || path !== paths[index - 1]);
  const authoredIndices = distinctPaths.map((path) =>
    CODEC_ORDER.indexOf(path.slice(0, -4) as typeof CODEC_ORDER[number])
  );
  expect(authoredIndices.length).toBeGreaterThan(0);
  expect(authoredIndices).toEqual([...authoredIndices].sort((left, right) => left - right));

  if (browserName === "chromium") {
    expect(outcome).toMatchObject({
      readiness: "interactiveReady",
      error: null
    });
  }
  if (outcome.readiness === "interactiveReady") {
    expect(outcome.error).toBeNull();
    expect(outcome.selectedCodec).not.toBeNull();
    expect(outcome.selectedRendition).not.toBeNull();
    expect(outcome.sourceGeneration).toBeGreaterThan(0);
    const selectedFamily = familyForCodec(outcome.selectedCodec!);
    expect(distinctPaths.at(-1)).toBe(`${selectedFamily}.avl`);
    const selectedIndex = CODEC_ORDER.indexOf(selectedFamily);
    expect(authoredIndices.every((index) => index <= selectedIndex)).toBe(true);
  } else {
    expect(outcome.readiness).toBe("error");
    expect(outcome.error).not.toBeNull();
    expect(outcome.selectedCodec).toBeNull();
    await expect(page.locator(".fallback")).toBeVisible();
  }
});

test("retires a positively configured AV1 startup failure before selecting VP9", async ({
  browserName,
  page,
  request
}) => {
  test.skip(browserName !== "chromium", "the deterministic worker delegate targets Chromium");
  test.setTimeout(90_000);
  await page.addInitScript(installStartupFailoverWorker);
  const session = uniqueSession("startup_failover");
  await page.goto(`/?session=${session}&integrity=0`);

  const outcome = await page.evaluate(async () => {
    const api = (window as unknown as {
      avalSourcePlayground: {
        readonly ready: Promise<void>;
        readonly player: HTMLElement & {
          readonly readiness?: string;
          getDiagnostics?(): Readonly<{
            lastFailure: unknown;
            runtime: Readonly<{
              selectedCodec: string | null;
              selectedRendition: string | null;
              decoderDiagnostics: readonly Readonly<{
                sourceIndex: number;
                rendition: string;
              codec: string;
              lane: number;
              phase: string;
              code: string;
              firstFrame: Readonly<{
                  displayWidth: number;
                  displayHeight: number;
                }> | null;
                lastGoodFrame: Readonly<{
                  displayWidth: number;
                  displayHeight: number;
                }> | null;
                outputFailure: unknown;
              }>[];
            }>;
          }>;
        };
      };
      __avalStartupFailoverProbe: StartupFailoverProbe;
    }).avalSourcePlayground;
    let error: string | null = null;
    try {
      await api.ready;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "unknown initialization failure";
    }
    const diagnostics = api.player.getDiagnostics?.();
    const probe = (window as unknown as {
      __avalStartupFailoverProbe: StartupFailoverProbe;
    }).__avalStartupFailoverProbe;
    return {
      readiness: api.player.readiness ?? "unavailable",
      selectedCodec: diagnostics?.runtime.selectedCodec ?? null,
      selectedRendition: diagnostics?.runtime.selectedRendition ?? null,
      decoderDiagnostics: diagnostics?.runtime.decoderDiagnostics ?? [],
      lastFailure: diagnostics?.lastFailure ?? null,
      error,
      probe
    };
  });

  expect(outcome).toMatchObject({
    readiness: "interactiveReady",
    selectedCodec: expect.stringMatching(/^vp09\./u),
    selectedRendition: expect.any(String),
    lastFailure: null,
    error: null
  });
  expect(outcome.decoderDiagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      sourceIndex: 0,
      codec: expect.stringMatching(/^av01\./u),
      phase: "output-validation",
      code: "invalid-output",
      firstFrame: expect.objectContaining({
        displayWidth: expect.any(Number),
        displayHeight: expect.any(Number)
      }),
      lastGoodFrame: null,
      outputFailure: expect.objectContaining({
        kind: "display-aspect",
        validationLayer: "host-expectation",
        field: "display-aspect",
        expected: expect.objectContaining({
          displayAspectWidth: expect.any(Number),
          displayAspectHeight: expect.any(Number)
        }),
        actual: expect.objectContaining({
          displayWidth: expect.any(Number),
          displayHeight: expect.any(Number)
        })
      })
    })
  ]));

  const attemptedFamilies = [...new Set(outcome.probe.attempts.map(({ codec }) =>
    familyForCodec(codec)
  ))];
  expect(attemptedFamilies).toEqual(["av1", "vp9"]);
  const av1Attempts = outcome.probe.attempts.filter(({ codec }) =>
    codec.startsWith("av01.")
  );
  expect(av1Attempts.length).toBeGreaterThan(0);
  expect(av1Attempts.every(({ configuredSupported }) => configuredSupported)).toBe(true);
  expect(av1Attempts.some(({ invalidOutput }) => invalidOutput)).toBe(true);
  expect(av1Attempts.every(({ delegated }) => !delegated)).toBe(true);
  expect(av1Attempts.every(({ terminated }) => terminated)).toBe(true);
  expect(outcome.probe.attempts.filter(({ codec }) => codec.startsWith("vp09.")))
    .not.toHaveLength(0);

  const readinessTransitions = outcome.probe.publicEvents
    .filter(({ type }) => type === "readinesschange")
    .map(({ to }) => to);
  expect(readinessTransitions.filter((value) => value === "metadataReady")).toHaveLength(1);
  expect(readinessTransitions.at(-1)).toBe("interactiveReady");
  expect(readinessTransitions).not.toContain("error");
  expect(outcome.probe.publicEvents.filter(({ type, fatal }) =>
    type === "error" && fatal === true
  )).toEqual([]);
  expect(outcome.probe.animatedReveals).toBe(1);

  const metricsResponse = await request.get(
    `${QUALIFIED_FIXTURE_PREFIX}metrics?session=${session}`
  );
  expect(metricsResponse.ok()).toBe(true);
  const metrics = await metricsResponse.json() as FixtureMetrics;
  const requestedAssets = [...new Set(metrics.requests
    .map(({ path }) => path)
    .filter((path) => path.endsWith(".avl")))];
  expect(requestedAssets).toEqual(["av1.avl", "vp9.avl"]);
});

test("recovers a failed ladder by explicitly isolating another codec", async ({
  browserName,
  page
}) => {
  test.setTimeout(90_000);
  const session = uniqueSession("switch");
  await page.goto(`/?session=${session}&integrity=0`);
  await page.evaluate(async () => {
    const api = (window as unknown as {
      avalSourcePlayground: { readonly ready: Promise<void> };
    }).avalSourcePlayground;
    await api.ready;
  });

  const initialGeneration = await page.evaluate(() => {
    const api = (window as unknown as {
      avalSourcePlayground: {
        readonly player: HTMLElement & {
          getDiagnostics?(): Readonly<{ sourceGeneration: number }>;
        };
      };
    }).avalSourcePlayground;
    return api.player.getDiagnostics?.().sourceGeneration ?? 0;
  });

  const fatalReadiness = await page.evaluate(async (qualifiedPrefix) => {
    const player = (window as unknown as {
      avalSourcePlayground: {
        readonly player: HTMLElement & {
          readonly readiness?: string;
          prepare?(options?: Readonly<{ timeoutMs?: number }>): Promise<unknown>;
        };
      };
    }).avalSourcePlayground.player;
    const source = player.querySelector<HTMLSourceElement>(
      ':scope > source[data-codec="av1"]'
    );
    if (source === null) throw new Error("AV1 source is unavailable");
    source.src = `${qualifiedPrefix}missing.avl?failure=${String(Date.now())}`;
    try {
      await player.prepare?.({ timeoutMs: 10_000 });
    } catch {
      // The retained public state and consumer alternate are asserted below.
    }
    return player.readiness ?? "unavailable";
  }, QUALIFIED_FIXTURE_PREFIX);
  expect(fatalReadiness).toBe("error");
  await expect(page.locator("aval-player")).toBeVisible();
  await expect(page.locator(".fallback")).toBeVisible();

  const vp9 = page.getByRole("button", { name: "VP9", exact: true });
  await expect(vp9).toHaveAttribute("aria-pressed", "false");
  await vp9.click();

  await expect.poll(() => page.evaluate(() => {
    const api = (window as unknown as {
      avalSourcePlayground: {
        readonly player: HTMLElement & {
          readonly readiness?: string;
          getDiagnostics?(): Readonly<{
            sourceGeneration: number;
            staticReason: string | null;
            effectivelyVisible: boolean;
            runtime: Readonly<{ selectedCodec: string | null }>;
          }>;
        };
        sourceSnapshot(): readonly Readonly<{ codec: string | null }>[];
      };
    }).avalSourcePlayground;
    const diagnostics = api.player.getDiagnostics?.();
    return {
      firstSource: api.sourceSnapshot()[0]?.codec ?? null,
      sourceCount: api.sourceSnapshot().length,
      readiness: api.player.readiness ?? "unavailable",
      selectedCodec: diagnostics?.runtime.selectedCodec ?? null,
      sourceGeneration: diagnostics?.sourceGeneration ?? 0,
      staticReason: diagnostics?.staticReason ?? null,
      effectivelyVisible: diagnostics?.effectivelyVisible ?? false
    };
  }), { timeout: 30_000 }).toMatchObject({
    firstSource: "vp9",
    sourceCount: 1,
    ...(browserName === "chromium"
      ? {
          readiness: "interactiveReady",
          selectedCodec: expect.stringMatching(/^vp09\./u),
          staticReason: null,
          effectivelyVisible: true
        }
      : {
          readiness: expect.stringMatching(/^(?:interactiveReady|error)$/u)
        }),
    sourceGeneration: expect.any(Number)
  });

  const switchedGeneration = await page.evaluate(() => {
    const player = (window as unknown as {
      avalSourcePlayground: {
        readonly player: HTMLElement & {
          getDiagnostics?(): Readonly<{ sourceGeneration: number }>;
        };
      };
    }).avalSourcePlayground.player;
    return player.getDiagnostics?.().sourceGeneration ?? 0;
  });
  expect(switchedGeneration).toBeGreaterThan(initialGeneration);
  if (browserName === "chromium") {
    await expect(vp9).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("#status")).toContainText("selected VP9");
    await expect(page.locator("aval-player")).toBeVisible();
    await expect(page.locator(".fallback")).toBeHidden();
  }
});

test("switches every codec control and reports the browser's actual selection", async ({
  browserName,
  page
}) => {
  test.skip(browserName !== "chromium", "the fixture codec expectations target Chromium");
  test.setTimeout(90_000);
  const session = uniqueSession("switch_matrix");
  await page.goto(`/?session=${session}&integrity=0`);
  await page.evaluate(async () => {
    await (window as unknown as {
      avalSourcePlayground: { readonly ready: Promise<void> };
    }).avalSourcePlayground.ready;
  });

  let generation = await sourceGeneration(page);
  generation = await selectCodec(page, "VP9", "vp9", /^vp09\./u, generation);
  generation = await selectCodec(
    page,
    "H.264 / AVC",
    "h264",
    /^avc1\./u,
    generation
  );

  await page.locator(".motion-frame").hover();
  await expect.poll(() => playerState(page)).toMatchObject({
    readiness: "interactiveReady",
    requestedState: "engaged",
    visualState: "engaged",
    lastFailure: null,
    underflows: 0
  });
  // The reversible edge's authored portal is body frame zero. Leaving on a
  // later resident endpoint frame verifies that playback keeps presenting the
  // body until the next legal portal instead of handing off media too early.
  await waitForBodyFrame(page, "engaged", 4);
  await page.mouse.move(1, 1);
  try {
    await expect.poll(() => playerState(page)).toMatchObject({
      readiness: "interactiveReady",
      requestedState: "idle",
      visualState: "idle",
      lastFailure: null,
      underflows: 0
    });
  } catch (error) {
    const evidence = await page.evaluate(() => ({
      diagnostics: (window as unknown as {
        avalSourcePlayground: {
          readonly player: HTMLElement & {
            getDiagnostics(options?: Readonly<{ trace?: boolean }>): unknown;
          };
        };
      }).avalSourcePlayground.player.getDiagnostics({ trace: true })
    }));
    throw new Error(`codec switch failed: ${JSON.stringify(evidence)}`, {
      cause: error
    });
  }
  const trace = await contentPresentationTrace(page);
  const departure = trace.findLastIndex((presentation) =>
    presentation.kind === "body" &&
    presentation.state === "engaged" &&
    presentation.frameIndex === 4
  );
  expect(departure).toBeGreaterThanOrEqual(0);
  const afterDeparture = trace.slice(departure + 1);
  expect(afterDeparture[0]).toMatchObject({
    kind: "body",
    state: "engaged",
    frameIndex: 5
  });
  expect(afterDeparture.findIndex((presentation) =>
    presentation.kind === "reversible" &&
    presentation.edgeId === "engaged.idle" &&
    presentation.frameIndex === 5
  )).toBeGreaterThan(0);

  const h265 = page.getByRole("button", { name: "H.265 / HEVC", exact: true });
  await h265.click();
  const expectedH265Generation = generation + 1;
  await expect.poll(() => isolatedCodecState(page), { timeout: 30_000 })
    .toMatchObject({
      codecs: ["h265"],
      generation: expectedH265Generation,
      readiness: expect.stringMatching(/^(?:interactiveReady|error)$/u)
    });
  await expect(h265).toHaveAttribute("aria-pressed", "true");
  const h265Outcome = await isolatedCodecState(page);
  if (h265Outcome.readiness === "interactiveReady") {
    expect(h265Outcome.selectedCodec).toMatch(/^hvc1\./u);
    await expect(h265).toHaveAttribute("aria-current", "true");
    await expect(page.locator("#status")).toContainText("selected H.265 / HEVC");
  } else {
    expect(h265Outcome.selectedCodec).toBeNull();
    await expect(page.locator(".fallback")).toBeVisible();
    await expect(page.locator("#status")).toContainText(
      "Could not play H.265 / HEVC by itself"
    );
  }
  generation = expectedH265Generation;

  await selectCodec(page, "AV1", "av1", /^av01\./u, generation);
});

test("per-source integrity uses full-file requests", async ({ page, request }) => {
  test.setTimeout(90_000);
  const session = uniqueSession("integrity");
  await page.goto(`/?session=${session}`);
  await page.evaluate(async () => {
    const api = (window as unknown as {
      avalSourcePlayground: { readonly ready: Promise<void> };
    }).avalSourcePlayground;
    await api.ready.catch(() => undefined);
  });

  const response = await request.get(
    `${QUALIFIED_FIXTURE_PREFIX}metrics?session=${session}`
  );
  const metrics = await response.json() as FixtureMetrics;
  const assetRequests = metrics.requests.filter(({ path }) => path.endsWith(".avl"));
  expect(assetRequests.length).toBeGreaterThan(0);
  expect(assetRequests.every(({ range }) => range === null)).toBe(true);
});

function familyForCodec(codec: string): typeof CODEC_ORDER[number] {
  if (codec.startsWith("av01.")) return "av1";
  if (codec.startsWith("vp09.")) return "vp9";
  if (codec.startsWith("hvc1.")) return "h265";
  if (codec.startsWith("avc1.")) return "h264";
  throw new Error(`unexpected selected codec: ${codec}`);
}

function uniqueSession(prefix: string): string {
  return `${prefix}_${process.pid.toString(36)}_${Date.now().toString(36)}`;
}

function installStartupFailoverWorker(): void {
  type Attempt = {
    codec: string;
    commands: string[];
    configuredSupported: boolean;
    delegated: boolean;
    invalidOutput: boolean;
    terminated: boolean;
  };
  type Probe = {
    attempts: Attempt[];
    publicEvents: Array<{
      type: string;
      from: string | null;
      to: string | null;
      fatal: boolean | null;
    }>;
    animatedReveals: number;
  };
  type DecoderConfigure = Readonly<{
    t: "configure";
    config: Readonly<{
      codec: string;
      codedWidth?: number;
      codedHeight?: number;
      displayAspectWidth?: number;
      displayAspectHeight?: number;
    }>;
  }>;
  type DecoderCommand = Readonly<{
    t: string;
    run?: number;
    chunks?: readonly Readonly<{
      timestamp: number;
      duration: number;
    }>[];
  }>;

  const NativeWorker = globalThis.Worker;
  const probe: Probe = {
    attempts: [],
    publicEvents: [],
    animatedReveals: 0
  };
  Object.defineProperty(globalThis, "__avalStartupFailoverProbe", {
    value: probe,
    configurable: false,
    enumerable: false,
    writable: false
  });

  const dispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function(event: Event): boolean {
    if (this instanceof HTMLElement && this.localName === "aval-player" &&
      (event.type === "readinesschange" || event.type === "error")) {
      const detail = (event as CustomEvent<{
        from?: unknown;
        to?: unknown;
        fatal?: unknown;
      }>).detail;
      probe.publicEvents.push({
        type: event.type,
        from: typeof detail?.from === "string" ? detail.from : null,
        to: typeof detail?.to === "string" ? detail.to : null,
        fatal: typeof detail?.fatal === "boolean" ? detail.fatal : null
      });
    }
    return dispatch.call(this, event);
  };

  const hidden = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "hidden");
  if (hidden?.get !== undefined && hidden.set !== undefined) {
    Object.defineProperty(HTMLElement.prototype, "hidden", {
      ...hidden,
      get: hidden.get,
      set(value: boolean) {
        if (this instanceof HTMLCanvasElement &&
          this.dataset.avalLayer === "animated" && value === false) {
          probe.animatedReveals += 1;
        }
        hidden.set!.call(this, value);
      }
    });
  }

  // Preserve the real worker for every non-AV1 candidate. For AV1, acknowledge
  // configuration and then emit the same bounded invalid-output shape that a
  // browser decoder can report after a successful capability probe.
  function StartupFailoverWorker(url: string | URL, options?: WorkerOptions): Worker {
    const worker = new NativeWorker(url, options);
    const post = worker.postMessage.bind(worker);
    const terminate = worker.terminate.bind(worker);
    let attempt: Attempt | null = null;
    let configuration: DecoderConfigure["config"] | null = null;
    let synthetic = false;
    let terminated = false;
    const emit = (data: unknown): void => {
      queueMicrotask(() => {
        if (!terminated) worker.dispatchEvent(new MessageEvent("message", { data }));
      });
    };
    Object.defineProperties(worker, {
      postMessage: {
        configurable: true,
        value: (
          value: unknown,
          transferOrOptions?: StructuredSerializeOptions | Transferable[]
        ): void => {
          const command = value as DecoderCommand;
          if (attempt === null) {
            const configure = value as DecoderConfigure;
            if (configure?.t !== "configure" ||
              typeof configure.config?.codec !== "string") {
              throw new TypeError("decoder worker must be configured first");
            }
            configuration = configure.config;
            synthetic = configure.config.codec.startsWith("av01.");
            attempt = {
              codec: configure.config.codec,
              commands: [configure.t],
              configuredSupported: synthetic,
              delegated: !synthetic,
              invalidOutput: false,
              terminated: false
            };
            probe.attempts.push(attempt);
            if (synthetic) {
              terminate();
              emit({ t: "configured", supported: true });
              return;
            }
          } else {
            attempt.commands.push(command.t);
          }
          if (!synthetic) {
            if (transferOrOptions === undefined) post(value);
            else if (Array.isArray(transferOrOptions)) post(value, transferOrOptions);
            else post(value, transferOrOptions);
            return;
          }
          if (command.t === "start" && command.run !== undefined) {
            emit({ t: "started", run: command.run });
            return;
          }
          if (command.t === "close" && command.run !== undefined) {
            emit({ t: "closed", run: command.run });
            return;
          }
          if (command.t !== "decode" || command.run === undefined ||
            command.chunks === undefined || attempt.invalidOutput) return;
          attempt.invalidOutput = true;
          const first = command.chunks[0]!;
          const codedWidth = positiveInteger(configuration!.codedWidth, 640);
          const codedHeight = positiveInteger(configuration!.codedHeight, 360);
          const expectedWidth = positiveInteger(
            configuration!.displayAspectWidth,
            codedWidth
          );
          const expectedHeight = positiveInteger(
            configuration!.displayAspectHeight,
            codedHeight
          );
          const width = Math.max(1, expectedWidth - 1);
          const height = Math.max(1, expectedHeight - 1);
          const visibleRect = { x: 0, y: 0, width: codedWidth, height: codedHeight };
          const colorSpace = ["bt709", "bt709", "bt709", false] as const;
          emit({ t: "accepted", run: command.run });
          emit({
            t: "error",
            diagnostic: {
              phase: "output-validation",
              code: "invalid-output",
              run: command.run,
              decodeOrdinal: 0,
              exception: {
                name: "EncodingError",
                message: "synthetic AV1 output dimensions do not match the manifest"
              },
              firstFrame: {
                timestamp: first.timestamp,
                duration: first.duration,
                codedWidth,
                codedHeight,
                displayWidth: width,
                displayHeight: height,
                visibleRect,
                colorSpace
              },
              lastGoodFrame: null,
              outputFailure: {
                kind: "display-aspect",
                validationLayer: "host-expectation",
                field: "display-aspect",
                expected: {
                  timestamp: first.timestamp,
                  duration: first.duration,
                  codedWidth,
                  codedHeight,
                  displayAspectWidth: expectedWidth,
                  displayAspectHeight: expectedHeight,
                  visibleRect,
                  colorSpace,
                  frameCount: null
                },
                actual: {
                  timestamp: first.timestamp,
                  duration: first.duration,
                  codedWidth,
                  codedHeight,
                  displayWidth: width,
                  displayHeight: height,
                  visibleRect,
                  colorSpace,
                  receivedFrameCount: null
                }
              }
            }
          });
        }
      },
      terminate: {
        configurable: true,
        value: (): void => {
          if (terminated) return;
          terminated = true;
          if (attempt !== null) attempt.terminated = true;
          terminate();
        }
      }
    });
    return worker;
  }

  Object.defineProperty(globalThis, "Worker", {
    value: StartupFailoverWorker,
    configurable: true,
    enumerable: false,
    writable: true
  });

  function positiveInteger(value: number | undefined, fallback: number): number {
    return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
  }
}

async function sourceGeneration(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const player = (window as unknown as {
      avalSourcePlayground: {
        readonly player: HTMLElement & {
          getDiagnostics?(): Readonly<{ sourceGeneration: number }>;
        };
      };
    }).avalSourcePlayground.player;
    return player.getDiagnostics?.().sourceGeneration ?? 0;
  });
}

async function waitForBodyFrame(
  page: import("@playwright/test").Page,
  state: string,
  frameIndex: number
): Promise<void> {
  await page.waitForFunction(({ expectedState, expectedFrame }) => {
    const diagnostics = (window as unknown as {
      avalSourcePlayground: {
        readonly player: HTMLElement & {
          getDiagnostics?(options?: Readonly<{ trace?: boolean }>): Readonly<{
            runtimeTrace?: readonly Readonly<{
              graph?: Readonly<{
                presentation?: Readonly<{
                  kind?: string;
                  state?: string;
                  frameIndex?: number;
                }> | null;
              }>;
            }>[];
          }>;
        };
      };
    }).avalSourcePlayground.player.getDiagnostics?.({ trace: true });
    const presentation = diagnostics?.runtimeTrace?.at(-1)?.graph?.presentation;
    return presentation?.kind === "body" &&
      presentation.state === expectedState &&
      presentation.frameIndex === expectedFrame;
  }, { expectedState: state, expectedFrame: frameIndex }, {
    polling: "raf",
    timeout: 15_000
  });
}

async function contentPresentationTrace(
  page: import("@playwright/test").Page
): Promise<readonly Readonly<{
  kind: string;
  state?: string;
  edgeId?: string;
  frameIndex?: number;
}>[]> {
  return page.evaluate(() => {
    const diagnostics = (window as unknown as {
      avalSourcePlayground: {
        readonly player: HTMLElement & {
          getDiagnostics(options?: Readonly<{ trace?: boolean }>): Readonly<{
            runtimeTrace?: readonly Readonly<{
              kind: string;
              graph?: Readonly<{
                presentation?: Readonly<{
                  kind: string;
                  state?: string;
                  edgeId?: string;
                  frameIndex?: number;
                }> | null;
              }>;
            }>[];
          }>;
        };
      };
    }).avalSourcePlayground.player.getDiagnostics({ trace: true });
    return (diagnostics.runtimeTrace ?? []).flatMap((record) => {
      const presentation = record.graph?.presentation;
      return record.kind === "content-tick" && presentation !== null &&
          presentation !== undefined
        ? [presentation]
        : [];
    });
  });
}

async function isolatedCodecState(
  page: import("@playwright/test").Page
): Promise<{
  readonly codecs: readonly (string | null)[];
  readonly generation: number;
  readonly readiness: string;
  readonly selectedCodec: string | null;
}> {
  return page.evaluate(() => {
    const api = (window as unknown as {
      avalSourcePlayground: {
        readonly player: HTMLElement & {
          readonly readiness?: string;
          getDiagnostics?(): Readonly<{
            sourceGeneration: number;
            runtime: Readonly<{ selectedCodec: string | null }>;
          }>;
        };
        sourceSnapshot(): readonly Readonly<{ codec: string | null }>[];
      };
    }).avalSourcePlayground;
    const diagnostics = api.player.getDiagnostics?.();
    return {
      codecs: api.sourceSnapshot().map(({ codec }) => codec),
      generation: diagnostics?.sourceGeneration ?? 0,
      readiness: api.player.readiness ?? "unavailable",
      selectedCodec: diagnostics?.runtime.selectedCodec ?? null
    };
  });
}

async function selectCodec(
  page: import("@playwright/test").Page,
  accessibleName: string,
  family: typeof CODEC_ORDER[number],
  selectedCodec: RegExp,
  previousGeneration: number
): Promise<number> {
  const button = page.getByRole("button", { name: accessibleName, exact: true });
  await button.click();
  const expectedGeneration = previousGeneration + 1;
  await expect.poll(() => page.evaluate(() => {
    const api = (window as unknown as {
      avalSourcePlayground: {
        readonly player: HTMLElement & {
          readonly readiness?: string;
          getDiagnostics?(): Readonly<{
            sourceGeneration: number;
            runtime: Readonly<{ selectedCodec: string | null }>;
            cleanup: Readonly<{
              completed: boolean;
              failureCount: number;
              participantLogicalBytes: number;
              participantActiveLeaseCount: number;
              workerCount: number;
              openFrames: number;
              pagePhysicalBytes: number;
              pageParticipantCount: number;
            }> | null;
          }>;
        };
        sourceSnapshot(): readonly Readonly<{ codec: string | null }>[];
      };
    }).avalSourcePlayground;
    const diagnostics = api.player.getDiagnostics?.();
    return {
      firstSource: api.sourceSnapshot()[0]?.codec ?? null,
      sourceCount: api.sourceSnapshot().length,
      generation: diagnostics?.sourceGeneration ?? 0,
      readiness: api.player.readiness ?? "unavailable",
      selectedCodec: diagnostics?.runtime.selectedCodec ?? null,
      cleanup: diagnostics?.cleanup ?? null
    };
  }), { timeout: 30_000 }).toMatchObject({
    firstSource: family,
    sourceCount: 1,
    generation: expectedGeneration,
    readiness: "interactiveReady",
    selectedCodec: expect.stringMatching(selectedCodec),
    cleanup: {
      completed: true,
      failureCount: 0,
      participantLogicalBytes: 0,
      participantActiveLeaseCount: 0,
      workerCount: 0,
      openFrames: 0,
      pagePhysicalBytes: 0,
      pageParticipantCount: 0
    }
  });
  await expect(button).toHaveAttribute("aria-pressed", "true");
  return expectedGeneration;
}

async function playerState(page: import("@playwright/test").Page): Promise<{
  readonly readiness: string;
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly lastFailure: unknown;
  readonly underflows: number;
}> {
  return page.evaluate(() => {
    const player = (window as unknown as {
      avalSourcePlayground: {
        readonly player: HTMLElement & {
          readonly readiness?: string;
          getDiagnostics?(): Readonly<{
            requestedState: string | null;
            visualState: string | null;
            lastFailure: unknown;
            counters: Readonly<{ underflow: number }>;
          }>;
        };
      };
    }).avalSourcePlayground.player;
    const diagnostics = player.getDiagnostics?.();
    return {
      readiness: player.readiness ?? "unavailable",
      requestedState: diagnostics?.requestedState ?? null,
      visualState: diagnostics?.visualState ?? null,
      lastFailure: diagnostics?.lastFailure ?? null,
      underflows: diagnostics?.counters.underflow ?? -1
    };
  });
}
