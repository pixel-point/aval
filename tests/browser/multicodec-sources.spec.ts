import { expect, test } from "@playwright/test";

const CODEC_ORDER = ["av1", "vp9", "h265", "h264"] as const;

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

test("publishes four ordered direct-child sources and no host source authority", async ({ page }) => {
  const session = uniqueSession("markup");
  await page.goto(`/?session=${session}&integrity=0`);

  await expect.poll(() => page.evaluate(() => {
    const api = (window as unknown as {
      avalSourcePlayground?: {
        sourceSnapshot(): readonly Readonly<{ src: string | null }>[];
      };
    }).avalSourcePlayground;
    return api?.sourceSnapshot().every(({ src }) => src !== null) ?? false;
  })).toBe(true);

  const snapshot = await page.evaluate(() => {
    const api = (window as unknown as {
      avalSourcePlayground: {
        readonly player: HTMLElement;
        sourceSnapshot(): readonly Readonly<{
          codec: string | null;
          src: string | null;
          type: string | null;
          integrity: string | null;
        }>[];
      };
    }).avalSourcePlayground;
    return {
      hostSrc: api.player.getAttribute("src"),
      hostIntegrity: api.player.getAttribute("integrity"),
      sources: api.sourceSnapshot()
    };
  });

  expect(snapshot.hostSrc).toBeNull();
  expect(snapshot.hostIntegrity).toBeNull();
  expect(snapshot.sources.map(({ codec }) => codec)).toEqual(CODEC_ORDER);
  for (const [index, source] of snapshot.sources.entries()) {
    const codec = CODEC_ORDER[index]!;
    expect(new URL(source.src!).pathname).toBe(`/__aval_v1__/${codec}.avl`);
    expect(source.type).toMatch(/^application\/vnd\.aval; codecs="[A-Za-z0-9.]+"$/u);
    expect(source.integrity).toBeNull();
  }
});

test("uses the first exact supported source and never probes a later file", async ({
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
    `/__aval_v1__/metrics?session=${session}`
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
    expect(["staticReady", "error"]).toContain(outcome.readiness);
    expect(outcome.selectedCodec).toBeNull();
    await expect(page.locator(".fallback")).toBeVisible();
  }
});

test("lets the user move a codec to the front of the source list", async ({
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
            runtime: Readonly<{ selectedCodec: string | null }>;
          }>;
        };
        sourceSnapshot(): readonly Readonly<{ codec: string | null }>[];
      };
    }).avalSourcePlayground;
    const diagnostics = api.player.getDiagnostics?.();
    return {
      firstSource: api.sourceSnapshot()[0]?.codec ?? null,
      readiness: api.player.readiness ?? "unavailable",
      selectedCodec: diagnostics?.runtime.selectedCodec ?? null,
      sourceGeneration: diagnostics?.sourceGeneration ?? 0
    };
  }), { timeout: 30_000 }).toMatchObject({
    firstSource: "vp9",
    ...(browserName === "chromium"
      ? {
          readiness: "interactiveReady",
          selectedCodec: expect.stringMatching(/^vp09\./u)
        }
      : {
          readiness: expect.stringMatching(/^(?:interactiveReady|staticReady|error)$/u)
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

  generation = await selectCodec(
    page,
    "H.265 / HEVC",
    "h265",
    /^(?:hvc1|av01)\./u,
    generation
  );
  await expect(page.getByRole("button", { name: "H.265 / HEVC", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  const selectedH265 = await selectedCodec(page);
  if (selectedH265.startsWith("hvc1.")) {
    await expect(page.getByRole("button", { name: "H.265 / HEVC", exact: true }))
      .toHaveAttribute("aria-current", "true");
    await expect(page.locator("#status")).toContainText("selected H.265 / HEVC");
  } else {
    await expect(page.getByRole("button", { name: "AV1", exact: true }))
      .toHaveAttribute("aria-current", "true");
    await expect(page.locator("#status"))
      .toContainText("Requested H.265 / HEVC first · browser selected AV1");
  }

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

  const response = await request.get(`/__aval_v1__/metrics?session=${session}`);
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

async function selectedCodec(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(() => {
    const codec = (window as unknown as {
      avalSourcePlayground: {
        readonly player: HTMLElement & {
          getDiagnostics?(): Readonly<{
            runtime: Readonly<{ selectedCodec: string | null }>;
          }>;
        };
      };
    }).avalSourcePlayground.player.getDiagnostics?.().runtime.selectedCodec;
    if (codec === null || codec === undefined) throw new Error("no selected codec");
    return codec;
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
      generation: diagnostics?.sourceGeneration ?? 0,
      readiness: api.player.readiness ?? "unavailable",
      selectedCodec: diagnostics?.runtime.selectedCodec ?? null,
      cleanup: diagnostics?.cleanup ?? null
    };
  }), { timeout: 30_000 }).toMatchObject({
    firstSource: family,
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
