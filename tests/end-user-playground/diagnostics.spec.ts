import { expect, test } from "@playwright/test";

import {
  assertBrowserDiagnosticReport,
  BROWSER_DIAGNOSTIC_LIMITS,
  captureBrowserDiagnosticArtifacts,
  captureOperation,
  openWithDiagnostics,
  readReport
} from "../support/browser-diagnostic-capture.js";

test("captures bounded query-only browser diagnostics", async ({
  page
}, testInfo) => {
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

  let toggled = null;
  if (ready.outcome === "completed") {
    toggled = await captureOperation(
      page,
      "toggle-favorite",
      async () => {
        await page.locator("#toggle-state").click();
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
    "end-user-playground-diagnostics"
  );

  expect(ready.outcome).toBe("completed");
  expect(toggled?.outcome).toBe("completed");
  expect(failed).toMatchObject({
    outcome: "error",
    error: "Synthetic diagnostic capture failure"
  });
  expect(timedOut.outcome).toBe("timeout");
  expect(report.authoredSources.map(({ codec }) => codec)).toEqual([
    "av01.0.00M.10.0.110.01.01.01.0",
    "vp09.00.10.08.01.01.01.01.00",
    "hvc1.1.6.L30.90",
    "avc1.64000A"
  ]);
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
      credentials: "CREDENTIAL_SECRET"
    };
    const diagnostics = {
      stack: "SECRET_STACK",
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
    credentials: "[redacted-sensitive]"
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
    "KEY_LEAK"
  ]) {
    expect(serialized).not.toContain(secret);
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
