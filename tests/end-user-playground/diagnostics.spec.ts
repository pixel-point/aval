import { expect, test, type Page } from "@playwright/test";

import {
  assertBrowserDiagnosticReport,
  BROWSER_DIAGNOSTIC_LIMITS,
  type BrowserDiagnosticEvidenceCheckpointArtifacts,
  browserDiagnosticCertificationModeFromEnvironment,
  browserDiagnosticEvidenceTargetFromEnvironment,
  browserDiagnosticExpectedOutcomeFromEnvironment,
  browserDiagnosticInteractionProfileFromEnvironment,
  captureBrowserDiagnosticArtifacts,
  captureBrowserDiagnosticPlaybackSoak,
  captureDeterministicUnsupportedBrowserEvidence,
  captureOperation,
  finalizeBrowserDiagnosticEvidenceFromEnvironment,
  openWithDiagnostics,
  readReport
} from "../support/browser-diagnostic-capture.js";

test("captures bounded query-only browser diagnostics", async ({
  page
}, testInfo) => {
  const certificationMode = browserDiagnosticCertificationModeFromEnvironment();
  const expectedOutcome = browserDiagnosticExpectedOutcomeFromEnvironment();
  const interactionProfile = browserDiagnosticInteractionProfileFromEnvironment();
  const evidenceCheckpoints: BrowserDiagnosticEvidenceCheckpointArtifacts[] = [];
  if (process.env.AVAL_BROWSER_EVIDENCE_RUN_ROOT !== undefined) {
    testInfo.setTimeout(Math.max(testInfo.timeout, 150_000));
  }
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("[data-aval-browser-diagnostics]"))
    .toHaveCount(0);
  expect(await page.evaluate(() => "avalBrowserDiagnostics" in window)).toBe(false);

  await openWithDiagnostics(
    page,
    "/?secret=top#https://secret.example/session-token"
  );
  const diagnosticUrl = new URL(page.url());
  expect(diagnosticUrl.pathname).toBe("/");
  expect(diagnosticUrl.search).toBe("?avalDiagnostics=1");
  expect(diagnosticUrl.hash).toBe("");
  const overlay = page.locator("[data-aval-browser-diagnostics]");
  await expect(overlay).not.toHaveAttribute("open", "");
  await expect(overlay.locator("summary")).toHaveText("AVAL diagnostics");
  await expect(overlay.locator("button")).toHaveText([
    "Capture",
    "Copy JSON",
    "Clear"
  ]);
  if (expectedOutcome === "deterministic-error") {
    await captureDeterministicUnsupportedBrowserEvidence(page, testInfo, {
      demoId: "end-user-playground",
      playerSelector: "#favorite-motion",
      artifactName: "end-user-playground"
    });
    return;
  }
  const ready = await captureOperation(
    page,
    "playground-ready",
    () => page.waitForFunction(() =>
      (document.querySelector("#favorite-motion") as HTMLElement & {
        readonly readiness?: string;
      } | null)?.readiness === "interactiveReady"
    ),
    { playerSelector: "#favorite-motion" }
  );
  await captureBrowserDiagnosticArtifacts(
    page,
    testInfo,
    "end-user-playground-ready",
    {
      evidence: browserDiagnosticEvidenceTargetFromEnvironment({
        demoId: "end-user-playground",
        checkpoint: "idle"
      }),
      advancingFrame: ready.outcome === "completed",
      onEvidenceWritten: (artifacts) => evidenceCheckpoints.push(artifacts)
    }
  );

  let toggled = null;
  if (ready.outcome === "completed") {
    toggled = await captureOperation(
      page,
      "toggle-favorite",
      async () => {
        await toggleFavorite(page, interactionProfile);
        await page.waitForFunction(() =>
          (document.querySelector("#favorite-motion") as HTMLElement & {
            readonly visualState?: string | null;
          } | null)?.visualState === "engaged"
        );
      },
      { playerSelector: "#favorite-motion" }
    );
  }
  const failed = await captureOperation(
    page,
    "synthetic-error",
    () => Promise.reject(new Error("Synthetic diagnostic capture failure")),
    { playerSelector: "#favorite-motion" }
  );
  const timedOut = await captureOperation(
    page,
    "synthetic-timeout",
    () => new Promise<never>(() => undefined),
    { playerSelector: "#favorite-motion", timeoutMilliseconds: 25 }
  );
  const report = await captureBrowserDiagnosticArtifacts(
    page,
    testInfo,
    "end-user-playground-interacted",
    {
      evidence: browserDiagnosticEvidenceTargetFromEnvironment({
        demoId: "end-user-playground",
        checkpoint: "engaged"
      }),
      advancingFrame: ready.outcome === "completed",
      onEvidenceWritten: (artifacts) => evidenceCheckpoints.push(artifacts)
    }
  );
  if (ready.outcome === "completed") {
    await toggleFavorite(page, interactionProfile);
    await waitForFavoriteState(page, "idle", true);
    if (interactionProfile === "desktop") {
      const target = page.locator("#favorite-control");
      await target.hover();
      await waitForFavoriteState(page, "engaged", true);
      await page.mouse.move(1, 1);
      await waitForFavoriteState(page, "idle", true);
      await target.focus();
      await waitForFavoriteState(page, "engaged", true);
      await target.evaluate((element) => (element as HTMLElement).blur());
      await waitForFavoriteState(page, "idle", true);
    }
  }
  const measuredRun = await captureBrowserDiagnosticPlaybackSoak(
    page,
    "#favorite-motion",
    async () => {
      await waitForFavoriteState(page, "idle", true);
      await toggleFavorite(page, interactionProfile);
      await waitForFavoriteState(page, "engaged", true);
      await toggleFavorite(page, interactionProfile);
      await waitForFavoriteState(page, "idle", true);
    }
  );
  await finalizeBrowserDiagnosticEvidenceFromEnvironment({
    demoId: "end-user-playground",
    checkpoints: evidenceCheckpoints,
    measuredRun
  });

  expect(ready.outcome).toBe("completed");
  expect(toggled?.outcome).toBe("completed");
  expect(failed).toMatchObject({
    outcome: "error",
    error: "Synthetic diagnostic capture failure"
  });
  expect(timedOut.outcome).toBe("timeout");
  expect(report.authoredSources.map(({ codec }) => codec)).toEqual(
    certificationMode === "forced-h264"
      ? ["avc1.42E00B"]
      : [
          "av01.0.00M.10.0.110.01.01.01.0",
          "vp09.00.10.08.01.01.01.01.00",
          "hvc1.1.6.L30.90",
          "avc1.42E00B"
        ]
  );
  expect(report.checkpoints.map(({ label }) => label)).toEqual(
    expect.arrayContaining([
      "before:playground-ready",
      "after:playground-ready",
      "before:toggle-favorite",
      "after:toggle-favorite",
      "error:synthetic-error",
      "timeout:synthetic-timeout"
    ])
  );

  await page.evaluate(() => {
    const api = (window as Window & {
      readonly avalBrowserDiagnostics?: {
        attach(player: HTMLElement, context?: unknown): unknown;
        checkpoint(label: string, player?: HTMLElement): unknown;
      };
    }).avalBrowserDiagnostics;
    if (api === undefined) throw new Error("Browser diagnostics are unavailable");
    const probe = document.createElement("div") as HTMLElement & {
      getDiagnostics?: () => Readonly<Record<string, unknown>>;
    };
    probe.id = "overlay-failure-probe";
    probe.getDiagnostics = () => ({
      lastFailure: { code: "renderer-failure" },
      runtime: {
        selectedCodec: null,
        rendererBackend: null,
        decoderDiagnostics: [{
          sourceIndex: 2,
          unit: "body-01",
          lane: 1,
          logicalRunId: 9,
          phase: "output-validation",
          code: "invalid-output",
          run: 7,
          outputFailure: {
            kind: "display-aspect",
            validationLayer: "host-expectation",
            field: "display-aspect"
          },
          sourceUrl: "https://overlay-secret.example/private.avl",
          accessToken: "OVERLAY_TOKEN_SECRET",
          stack: "OVERLAY_STACK_SECRET",
          sourceBytes: "OVERLAY_SOURCE_BYTES_SECRET"
        }],
        rendererDiagnostics: [{
          sourceIndex: 2,
          backend: "webgl2",
          phase: "native-upload",
          glError: 0x0502,
          contextLost: false,
          sourceUrl: "https://renderer-secret.example/private.avl",
          accessToken: "RENDERER_TOKEN_SECRET",
          stack: "RENDERER_STACK_SECRET",
          sourceBytes: "RENDERER_SOURCE_BYTES_SECRET"
        }]
      }
    });
    api.attach(probe, { role: "overlay-failure-probe" });
    api.checkpoint("overlay:failure-summary", probe);
  });
  const overlayStatus = overlay.locator("output");
  await expect(overlayStatus).toContainText(
    "decoder[2] invalid-output@output-validation lane=1 run=7 " +
    "logical=9 unit=body-01 " +
    "mismatch=display-aspect/display-aspect/host-expectation"
  );
  await expect(overlayStatus).toContainText(
    "renderer[2] backend=webgl2 phase=native-upload " +
    "gl=INVALID_OPERATION(0x0502) context=available"
  );
  const safeOverlayStatus = await overlayStatus.textContent();
  expect(safeOverlayStatus).not.toContain("https://");
  expect(safeOverlayStatus).not.toContain("OVERLAY_TOKEN_SECRET");
  expect(safeOverlayStatus).not.toContain("OVERLAY_STACK_SECRET");
  expect(safeOverlayStatus).not.toContain("OVERLAY_SOURCE_BYTES_SECRET");
  expect(safeOverlayStatus).not.toContain("RENDERER_TOKEN_SECRET");
  expect(safeOverlayStatus).not.toContain("RENDERER_STACK_SECRET");
  expect(safeOverlayStatus).not.toContain("RENDERER_SOURCE_BYTES_SECRET");
  const overlayReport = await readReport(page);
  const overlayRuntime = overlayReport.latest?.element.diagnostics?.runtime;
  expect(overlayRuntime).toMatchObject({
    decoderDiagnostics: [{
      lane: 1,
      run: 7,
      logicalRunId: 9,
      unit: "body-01",
      outputFailure: {
        kind: "display-aspect",
        field: "display-aspect",
        validationLayer: "host-expectation"
      },
      sourceBytes: "[redacted-sensitive]"
    }],
    rendererDiagnostics: [{
      backend: "webgl2",
      phase: "native-upload",
      glError: 0x0502,
      contextLost: false,
      sourceBytes: "[redacted-sensitive]"
    }]
  });

  await page.evaluate(() => {
    const api = (window as Window & {
      readonly avalBrowserDiagnostics?: {
        _setOverlayStatus(callback: () => void): void;
        attach(player: HTMLElement, context?: unknown): unknown;
        checkpoint(label: string, player?: HTMLElement): unknown;
      };
    }).avalBrowserDiagnostics;
    if (api === undefined) throw new Error("Browser diagnostics are unavailable");
    api._setOverlayStatus(() => undefined);
    const wideObject = Object.fromEntries(
      Array.from({ length: 160 }, (_, index) => [`key-${String(index)}`, index])
    );
    const deepObject: Record<string, unknown> = {};
    let cursor = deepObject;
    for (let depth = 0; depth < 24; depth += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    const diagnosticError = new Error(
      "Failure at (/secret), (/Users/alex/Private Folder/file.avl:12:3), " +
      "(C:\\secret), (C:\\Users\\Alex Doe\\Private Files\\file.avl:12:3), " +
      "(\\\\server\\share), and " +
      "(\\\\server\\shared folder\\Private File.avl)"
    );
    diagnosticError.name =
      "assets/private.avl?token=ERROR_NAME_TOKEN";
    const privateValues = {
      headers: { authorization: "Bearer HEADER_SECRET" },
      authorization: "Bearer AUTHORIZATION_SECRET",
      cookie: "session=COOKIE_SECRET",
      integrity: "sha384-INTEGRITY_SECRET",
      etag: "ETAG_SECRET",
      responseText: "RESPONSE_TEXT_SECRET",
      token: "TOKEN_SECRET",
      secret: "SECRET_VALUE",
      apiKey: "API_KEY_SECRET",
      credentials: "CREDENTIAL_SECRET",
      sourceBytes: "SOURCE_BYTES_SECRET",
      bytes: "RAW_BYTES_SECRET",
      body: "BODY_SECRET",
      payload: "PAYLOAD_SECRET",
      sourceBuffer: new Uint8Array([83, 79, 85, 82, 67, 69])
    };
    const diagnostics = {
      stack: "SECRET_STACK",
      uploadPath: "rgba-copy",
      rendererByteAccounting: {
        bytes: { expected: 7_372_800, actual: 7_372_800 }
      },
      sourceUrl: "https://secret.example/source.avl",
      relativeReference: "assets/private.avl?token=RELATIVE_PATH_TOKEN",
      rootedReference: "/private.avl?token=ROOTED_PATH_TOKEN",
      queryReferences: [
        "assets/private.avl?access_token=ACCESS_TOKEN_QUERY_SECRET",
        "assets/private.avl?api_key=API_KEY_QUERY_SECRET",
        "assets/private.avl?client_secret=CLIENT_SECRET_QUERY_SECRET"
      ],
      propertyNameProbe: {
        "token=KEY_LEAK": "ordinary-value"
      },
      pathValues: [
        "/secret",
        "/Users/alex/Private Folder/file.avl:12:3",
        "C:\\secret",
        "C:\\Users\\Alex Doe\\Private Files\\file.avl:12:3",
        "\\\\server\\share",
        "\\\\server\\shared folder\\Private File.avl"
      ],
      diagnosticError,
      privateValues,
      generalArray: Array.from({ length: 160 }, (_, index) => index),
      wideObject,
      deepObject,
      longText: "x".repeat(5_000),
      elementTrace: Array.from({ length: 80 }, (_, index) => ({ index })),
      runtimeTrace: Array.from({ length: 96 }, (_, index) => ({ index }))
    };
    let boundedProbe: HTMLElement & {
      getDiagnostics?: () => Readonly<Record<string, unknown>>;
    } | null = null;
    for (let playerIndex = 0; playerIndex < 40; playerIndex += 1) {
      const probe = document.createElement("div") as HTMLElement & {
        getDiagnostics?: () => Readonly<Record<string, unknown>>;
      };
      probe.id = playerIndex === 39
        ? `/Users/alex/private/${"i".repeat(5_000)}`
        : `bounds-probe-${String(playerIndex)}`;
      for (let sourceIndex = 0; sourceIndex < 4; sourceIndex += 1) {
        const source = document.createElement("source");
        source.type = playerIndex === 39 && sourceIndex === 0
          ? `video/mp4; codecs="${"c".repeat(5_000)}"`
          : `video/mp4; codecs="avc1.6400${String(sourceIndex)}"`;
        probe.append(source);
      }
      probe.getDiagnostics = () => ({ playerIndex });
      api.attach(probe, {
        role: "bounds-probe",
        privateValues,
        relativeReference: "assets/context.avl?token=CONTEXT_TOKEN"
      });
      boundedProbe = probe;
    }
    if (boundedProbe === null) throw new Error("Bounded probe was not created");
    boundedProbe.getDiagnostics = () => diagnostics;
    api.checkpoint(
      `bounds:adversarial:${"l".repeat(5_000)}`,
      boundedProbe
    );
  });
  const bounded = await readReport(page);
  expect(bounded.players).toHaveLength(BROWSER_DIAGNOSTIC_LIMITS.players);
  expect(bounded.authoredSources).toHaveLength(
    BROWSER_DIAGNOSTIC_LIMITS.authoredSources
  );
  expect(bounded.checkpoints).toHaveLength(
    BROWSER_DIAGNOSTIC_LIMITS.checkpoints
  );
  const latestDiagnostics = bounded.latest?.element.diagnostics;
  expect(latestDiagnostics?.elementTrace).toHaveLength(
    BROWSER_DIAGNOSTIC_LIMITS.elementTrace
  );
  expect(latestDiagnostics?.runtimeTrace).toHaveLength(
    BROWSER_DIAGNOSTIC_LIMITS.runtimeTrace
  );
  expect(latestDiagnostics?.generalArray).toHaveLength(
    BROWSER_DIAGNOSTIC_LIMITS.generalArray
  );
  const wideObject = latestDiagnostics?.wideObject;
  expect(Object.keys(
    typeof wideObject === "object" && wideObject !== null ? wideObject : {}
  )).toHaveLength(
    BROWSER_DIAGNOSTIC_LIMITS.generalObjectKeys
  );
  expect(String(latestDiagnostics?.longText).length).toBeLessThanOrEqual(
    BROWSER_DIAGNOSTIC_LIMITS.stringLength
  );
  expect(bounded.checkpoints.at(-1)?.label.length).toBeLessThanOrEqual(
    BROWSER_DIAGNOSTIC_LIMITS.stringLength
  );
  expect(bounded.players.at(-1)?.elementId).toEqual(expect.any(String));
  expect(String(bounded.players.at(-1)?.elementId).length).toBeLessThanOrEqual(
    BROWSER_DIAGNOSTIC_LIMITS.stringLength
  );
  expect(bounded.authoredSources.at(-4)?.mimeType.length).toBeLessThanOrEqual(
    BROWSER_DIAGNOSTIC_LIMITS.stringLength
  );
  expect(String(bounded.authoredSources.at(-4)?.codec).length)
    .toBeLessThanOrEqual(BROWSER_DIAGNOSTIC_LIMITS.stringLength);
  expect(latestDiagnostics?.privateValues).toEqual({
    headers: "[redacted-sensitive]",
    authorization: "[redacted-sensitive]",
    cookie: "[redacted-sensitive]",
    integrity: "[redacted-sensitive]",
    etag: "[redacted-sensitive]",
    responseText: "[redacted-sensitive]",
    token: "[redacted-sensitive]",
    secret: "[redacted-sensitive]",
    apiKey: "[redacted-sensitive]",
    credentials: "[redacted-sensitive]",
    sourceBytes: "[redacted-sensitive]",
    bytes: "[redacted-sensitive]",
    body: "[redacted-sensitive]",
    payload: "[redacted-sensitive]",
    sourceBuffer: "[redacted-sensitive]"
  });
  expect(latestDiagnostics?.uploadPath).toBe("rgba-copy");
  expect(latestDiagnostics?.rendererByteAccounting).toEqual({
    bytes: { expected: 7_372_800, actual: 7_372_800 }
  });
  expect(latestDiagnostics?.relativeReference).toBe("[redacted-url]");
  expect(latestDiagnostics?.rootedReference).toBe("[redacted-url]");
  expect(latestDiagnostics?.queryReferences).toEqual([
    "[redacted-url]",
    "[redacted-url]",
    "[redacted-url]"
  ]);
  expect(latestDiagnostics?.propertyNameProbe).toEqual({
    "[redacted-sensitive-key]": "[redacted-sensitive]"
  });
  expect(latestDiagnostics?.pathValues).toEqual(
    Array.from({ length: 6 }, () => "[redacted-path]")
  );
  expect(latestDiagnostics?.diagnosticError).toEqual({
    name: "[redacted-url]",
    message: "Failure at ([redacted-path]), ([redacted-path]), " +
      "([redacted-path]), ([redacted-path]), ([redacted-path]), and " +
      "([redacted-path])"
  });
  const serialized = JSON.stringify(bounded);
  expect(serialized).not.toContain("SECRET_STACK");
  expect(serialized).not.toContain("secret.example");
  expect(serialized).not.toContain("session-token");
  expect(serialized).not.toContain("/secret");
  expect(serialized).not.toContain("/Users/alex/Private Folder/file.avl");
  expect(serialized).not.toContain("C:\\secret");
  expect(serialized).not.toContain("C:\\Users\\Alex Doe\\Private Files\\file.avl");
  expect(serialized).not.toContain("server\\share");
  expect(serialized).not.toContain("server\\shared folder\\Private File.avl");
  for (const secret of [
    "HEADER_SECRET",
    "AUTHORIZATION_SECRET",
    "COOKIE_SECRET",
    "INTEGRITY_SECRET",
    "ETAG_SECRET",
    "RESPONSE_TEXT_SECRET",
    "TOKEN_SECRET",
    "SECRET_VALUE",
    "API_KEY_SECRET",
    "CREDENTIAL_SECRET",
    "RELATIVE_PATH_TOKEN",
    "ROOTED_PATH_TOKEN",
    "ERROR_NAME_TOKEN",
    "CONTEXT_TOKEN",
    "ACCESS_TOKEN_QUERY_SECRET",
    "API_KEY_QUERY_SECRET",
    "CLIENT_SECRET_QUERY_SECRET",
    "KEY_LEAK",
    "SOURCE_BYTES_SECRET",
    "RAW_BYTES_SECRET",
    "BODY_SECRET",
    "PAYLOAD_SECRET"
  ]) {
    expect(serialized).not.toContain(secret);
  }
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText(value: string) {
          (window as Window & { __avalCopiedDiagnosticJson?: string })
            .__avalCopiedDiagnosticJson = value;
          return Promise.resolve();
        }
      }
    });
  });
  await overlay.locator("button", { hasText: "Copy JSON" }).evaluate(
    (button: HTMLButtonElement) => button.click()
  );
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __avalCopiedDiagnosticJson?: string })
      .__avalCopiedDiagnosticJson ?? null
  )).not.toBeNull();
  const copiedJson = await page.evaluate(() =>
    (window as Window & { __avalCopiedDiagnosticJson?: string })
      .__avalCopiedDiagnosticJson ?? ""
  );
  expect(copiedJson).toContain("[redacted-sensitive]");
  for (const secret of [
    "SOURCE_BYTES_SECRET",
    "RAW_BYTES_SECRET",
    "BODY_SECRET",
    "PAYLOAD_SECRET"
  ]) {
    expect(copiedJson).not.toContain(secret);
  }
  expect(bounded.session.url).toBe("/?avalDiagnostics=1");
  expect(bounded.serializationBudgetExhausted).toBe(false);

  await page.evaluate(() => {
    const api = (window as Window & {
      readonly avalBrowserDiagnostics?: {
        checkpoint(label: string, player?: HTMLElement): unknown;
      };
    }).avalBrowserDiagnostics;
    if (api === undefined) throw new Error("Browser diagnostics are unavailable");
    const probe = document.querySelector<HTMLElement>("#favorite-motion");
    if (probe === null) throw new Error("Diagnostic player is unavailable");
    const diagnosticProbe = probe as HTMLElement & {
      getDiagnostics: () => Readonly<Record<string, unknown>>;
    };
    const original = diagnosticProbe.getDiagnostics;
    const aggregateObject = Object.fromEntries(
      Array.from({ length: 72 }, (_, outer) => [
        `branch-${String(outer)}`,
        Object.fromEntries(Array.from({ length: 72 }, (_, inner) => [
          `leaf-${String(inner)}`,
          `payload-${String(outer)}-${String(inner)}-${"z".repeat(256)}`
        ]))
      ])
    );
    diagnosticProbe.getDiagnostics = () => ({ aggregateObject });
    try {
      api.checkpoint("bounds:aggregate-budget", diagnosticProbe);
    } finally {
      diagnosticProbe.getDiagnostics = original;
    }
  });
  const aggregate = await readReport(page);
  expect(aggregate.serializationBudgetExhausted).toBe(true);
  expect(() => assertBrowserDiagnosticReport({
    ...bounded,
    session: {
      ...bounded.session,
      url: "/?avalDiagnostics=1&avalCertificationMode=full-ladder"
    }
  })).not.toThrow();
  expect(() => assertBrowserDiagnosticReport({
    ...bounded,
    session: {
      ...bounded.session,
      url: "/?avalDiagnostics=1&token=EXTRA_QUERY_TOKEN"
    }
  })).toThrow();
});

test("bounds diagnostics while ingesting and traversing hostile values", async ({
  page
}) => {
  await openWithDiagnostics(page);

  await page.evaluate((limits) => {
    const api = (window as Window & {
      readonly avalBrowserDiagnostics?: {
        _setOverlayStatus(callback: () => void): void;
        attach(player: HTMLElement, context?: unknown): unknown;
        checkpoint(label: string, player?: HTMLElement): unknown;
      };
    }).avalBrowserDiagnostics;
    if (api === undefined) throw new Error("Browser diagnostics are unavailable");
    api._setOverlayStatus(() => undefined);

    const noBulkTraversal = document.createElement("div");
    noBulkTraversal.id = "no-bulk-traversal";
    noBulkTraversal.append(document.createElement("source"));
    Object.defineProperty(noBulkTraversal, "querySelectorAll", {
      value: () => {
        throw new Error("diagnostics must not materialize an unbounded NodeList");
      }
    });
    api.attach(noBulkTraversal);

    const sourceBoundProbe = document.createElement("div");
    sourceBoundProbe.id = "source-bound-probe";
    for (let index = 0; index <= limits.authoredSources; index += 1) {
      const source = document.createElement("source");
      source.type = `video/mp4; codecs="avc1.${String(index)}"`;
      if (index === limits.authoredSources) {
        Object.defineProperty(source, "getAttribute", {
          value: () => {
            throw new Error("diagnostics traversed beyond the source bound");
          }
        });
      }
      sourceBoundProbe.append(source);
    }
    api.attach(sourceBoundProbe);

    const rawDiagnostics = {
      safe: "value",
      elementTrace: [],
      runtimeTrace: []
    };
    const objectEntriesProbe = document.createElement("div") as HTMLElement & {
      getDiagnostics?: () => Readonly<Record<string, unknown>>;
    };
    objectEntriesProbe.id = "object-entries-probe";
    objectEntriesProbe.getDiagnostics = () => rawDiagnostics;
    api.attach(objectEntriesProbe);
    const originalObjectEntries = Object.entries;
    Object.entries = ((value: object) => {
      if (value === rawDiagnostics) {
        throw new Error("diagnostics must not materialize unbounded entries");
      }
      return originalObjectEntries(value);
    }) as typeof Object.entries;
    try {
      api.checkpoint("bounded-object-traversal", objectEntriesProbe);
    } finally {
      Object.entries = originalObjectEntries;
    }

    const originalShift = Array.prototype.shift;
    Array.prototype.shift = function forbiddenDiagnosticShift() {
      throw new Error("diagnostics must not repeatedly shift bounded queues");
    };
    try {
      for (let index = 0; index < limits.players + limits.checkpoints; index += 1) {
        const probe = document.createElement("div");
        probe.id = `queue-bound-probe-${String(index)}`;
        api.attach(probe);
      }
    } finally {
      Array.prototype.shift = originalShift;
    }
  }, BROWSER_DIAGNOSTIC_LIMITS);

  const report = await readReport(page);
  expect(report.players).toHaveLength(BROWSER_DIAGNOSTIC_LIMITS.players);
  expect(report.authoredSources).toHaveLength(
    BROWSER_DIAGNOSTIC_LIMITS.authoredSources
  );
  expect(report.checkpoints).toHaveLength(BROWSER_DIAGNOSTIC_LIMITS.checkpoints);
});

async function toggleFavorite(
  page: Page,
  profile: "desktop" | "touch" | "unsupported"
): Promise<void> {
  if (profile === "unsupported") {
    throw new Error("Unsupported evidence cannot toggle the favorite demo");
  }
  const toggle = page.locator("#toggle-state");
  if (profile === "touch") await toggle.tap();
  else await toggle.click();
}

async function waitForFavoriteState(
  page: Page,
  state: "idle" | "engaged",
  settled = false
): Promise<void> {
  await page.waitForFunction(({ expectedState, requireSettled }) => {
    const player = document.querySelector("#favorite-motion") as HTMLElement & {
      readonly visualState?: string | null;
      readonly isTransitioning?: boolean;
    } | null;
    return player !== null && player.visualState === expectedState &&
      (!requireSettled || player.isTransitioning === false);
  }, { expectedState: state, requireSettled: settled });
}
