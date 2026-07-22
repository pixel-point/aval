import { createHash } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it } from "vitest";

import {
  BROWSER_DIAGNOSTIC_PRODUCER_LIMITS,
  type BrowserDiagnosticReport,
  captureActiveAvalPlayerEvidence,
  finalizeBrowserDiagnosticEvidenceFromEnvironment,
  initializeBrowserDiagnosticEvidenceRunRoot,
  writeBrowserDiagnosticEvidencePair,
  writeBrowserDiagnosticEvidenceSession,
  writeBrowserDiagnosticInteractionLedger
} from "./browser-diagnostic-capture.js";

const SESSION_ID = "20260719T000000Z-test";
const HEAD_COMMIT = "a".repeat(40);

const EVIDENCE_ENVIRONMENT_NAMES = [
  "AVAL_BROWSER_EVIDENCE_RUN_ROOT",
  "AVAL_BROWSER_EVIDENCE_SLOT_ID",
  "AVAL_BROWSER_EVIDENCE_MODE",
  "AVAL_BROWSER_EVIDENCE_EXPECTED_OUTCOME",
  "AVAL_BROWSER_EVIDENCE_INTERACTION_PROFILE",
  "AVAL_BROWSER_EVIDENCE_SESSION_JSON",
  "AVAL_BROWSER_EVIDENCE_LEDGER_JSON"
] as const;
const ORIGINAL_EVIDENCE_ENVIRONMENT = new Map(
  EVIDENCE_ENVIRONMENT_NAMES.map((name) => [name, process.env[name]])
);

describe("browser diagnostic immutable evidence writers", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const name of EVIDENCE_ENVIRONMENT_NAMES) {
      const value = ORIGINAL_EVIDENCE_ENVIRONMENT.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await Promise.all(roots.splice(0).map((root) =>
      rm(root, { force: true, recursive: true })
    ));
  });

  it("writes a fixed report/PNG pair once and returns ledger-ready identity", async () => {
    const root = await evidenceRoot(roots);
    const screenshot = Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]);
    const beforeScreenshot = Uint8Array.from([137, 80, 78, 71, 0]);
    const contextScreenshot = Uint8Array.from([137, 80, 78, 71, 9, 8, 7, 6]);
    const target = {
      runRoot: root,
      slotId: "ios-18-safari",
      demoId: "grass-rabbit" as const,
      mode: "full-ladder" as const,
      checkpoint: "settled"
    };

    const artifacts = await writeBrowserDiagnosticEvidencePair(
      target,
      diagnosticReport("hover"),
      screenshot,
      beforeScreenshot,
      contextScreenshot
    );

    expect(artifacts).toEqual({
      reportPath: "ios-18-safari/grass-rabbit/full-ladder-settled.json",
      pngPath: "ios-18-safari/grass-rabbit/full-ladder-settled.png",
      contextPngPath:
        "ios-18-safari/grass-rabbit/full-ladder-settled-context.png",
      beforePngPath:
        "ios-18-safari/grass-rabbit/full-ladder-settled-before.png",
      pngSha256: createHash("sha256").update(screenshot).digest("hex"),
      contextPngSha256: createHash("sha256")
        .update(contextScreenshot)
        .digest("hex"),
      visualState: "hover"
    });
    expect(JSON.parse(await readFile(
      join(root, artifacts.reportPath),
      "utf8"
    ))).toMatchObject({ latest: { element: { visualState: "hover" } } });
    expect(await readFile(join(root, artifacts.pngPath))).toEqual(
      Buffer.from(screenshot)
    );
    expect(await readFile(join(root, artifacts.beforePngPath!))).toEqual(
      Buffer.from(beforeScreenshot)
    );
    expect(await readFile(join(root, artifacts.contextPngPath))).toEqual(
      Buffer.from(contextScreenshot)
    );
    await expect(writeBrowserDiagnosticEvidencePair(
      target,
      diagnosticReport("idle"),
      Uint8Array.from([9]),
      Uint8Array.from([8]),
      Uint8Array.from([7])
    )).rejects.toMatchObject({ code: "EEXIST" });
    expect(JSON.parse(await readFile(
      join(root, artifacts.reportPath),
      "utf8"
    ))).toMatchObject({ latest: { element: { visualState: "hover" } } });
  });

  it("requires an immutable run identity and writes session/ledger only once", async () => {
    const missingIdentityRoot = await realpath(await mkdtemp(
      join(tmpdir(), "aval-browser-evidence-missing-identity-")
    ));
    roots.push(missingIdentityRoot);
    await expect(writeBrowserDiagnosticEvidenceSession({
      runRoot: missingIdentityRoot,
      slotId: "windows-11-chrome"
    }, exactSession("windows-11-chrome"))).rejects.toThrow(
      /requires run-identity\.json/u
    );

    const root = await evidenceRoot(roots);
    const sessionTarget = {
      runRoot: root,
      slotId: "windows-11-chrome"
    };
    const ledgerTarget = {
      ...sessionTarget,
      demoId: "kinetic-orb" as const,
      mode: "forced-h264" as const
    };
    const session = exactSession(sessionTarget.slotId);
    await expect(writeBrowserDiagnosticEvidenceSession(
      sessionTarget,
      session
    )).resolves.toEqual({
      sessionPath: "windows-11-chrome/session.json"
    });
    await expect(writeBrowserDiagnosticInteractionLedger(
      ledgerTarget,
      { schemaVersion: 1, events: [] }
    )).resolves.toEqual({
      ledgerPath: "windows-11-chrome/kinetic-orb/" +
        "forced-h264-interaction-ledger.json"
    });
    await expect(writeBrowserDiagnosticEvidenceSession(
      sessionTarget,
      { ...session, testedAt: "2026-07-19T00:00:02.000Z" }
    )).rejects.toMatchObject({ code: "EEXIST" });
    await expect(writeBrowserDiagnosticInteractionLedger(
      ledgerTarget,
      { schemaVersion: 2 }
    )).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("finalizes exact environment metadata and reuses only an identical session", async () => {
    const root = await evidenceRoot(roots);
    const session = exactSession("ios-18-safari");
    process.env.AVAL_BROWSER_EVIDENCE_RUN_ROOT = root;
    process.env.AVAL_BROWSER_EVIDENCE_SLOT_ID = "ios-18-safari";
    process.env.AVAL_BROWSER_EVIDENCE_MODE = "full-ladder";
    process.env.AVAL_BROWSER_EVIDENCE_INTERACTION_PROFILE = "touch";
    process.env.AVAL_BROWSER_EVIDENCE_SESSION_JSON = JSON.stringify(session);

    const playgroundCheckpoints = await checkpointArtifacts(
      root,
      "ios-18-safari",
      "end-user-playground",
      "full-ladder"
    );
    process.env.AVAL_BROWSER_EVIDENCE_LEDGER_JSON = JSON.stringify(
      exactLedger("ios-18-safari", "end-user-playground", "full-ladder")
    );
    await expect(finalizeBrowserDiagnosticEvidenceFromEnvironment({
      demoId: "end-user-playground",
      checkpoints: playgroundCheckpoints,
      measuredRun: exactMeasuredRun("touch")
    })).resolves.toEqual({
      sessionPath: "ios-18-safari/session.json",
      ledgerPath: "ios-18-safari/end-user-playground/" +
        "full-ladder-interaction-ledger.json"
    });

    const rabbitCheckpoints = await checkpointArtifacts(
      root,
      "ios-18-safari",
      "grass-rabbit",
      "full-ladder"
    );
    process.env.AVAL_BROWSER_EVIDENCE_LEDGER_JSON = JSON.stringify(
      exactLedger("ios-18-safari", "grass-rabbit", "full-ladder")
    );
    await expect(finalizeBrowserDiagnosticEvidenceFromEnvironment({
      demoId: "grass-rabbit",
      checkpoints: rabbitCheckpoints,
      measuredRun: exactMeasuredRun("touch")
    })).resolves.toEqual({
      sessionPath: "ios-18-safari/session.json",
      ledgerPath: "ios-18-safari/grass-rabbit/" +
        "full-ladder-interaction-ledger.json"
    });

    expect(JSON.parse(await readFile(
      join(root, "ios-18-safari/session.json"),
      "utf8"
    ))).toEqual(session);
    expect(JSON.parse(await readFile(
      join(
        root,
        "ios-18-safari/grass-rabbit/full-ladder-interaction-ledger.json"
      ),
      "utf8"
    ))).toMatchObject({
      interactionProfile: "touch",
      startedAt: "2026-07-19T00:02:00.000Z",
      finishedAt: "2026-07-19T00:03:00.000Z",
      visualCheckpoints: rabbitCheckpoints.map((checkpoint) => ({
        id: checkpoint.id,
        visualState: checkpoint.visualState,
        advancingFrame: checkpoint.advancingFrame,
        pngSha256: checkpoint.pngSha256,
        contextPngSha256: checkpoint.contextPngSha256,
        frameProof: {
          beforePngSha256: checkpoint.frameProof!.beforeCanvasSha256,
          afterPngSha256: checkpoint.frameProof!.afterCanvasSha256,
          sampleIntervalMilliseconds:
            checkpoint.frameProof!.sampleIntervalMilliseconds,
          beforeDrawsCompleted: checkpoint.frameProof!.beforeDrawsCompleted,
          afterDrawsCompleted: checkpoint.frameProof!.afterDrawsCompleted
        }
      }))
    });

    process.env.AVAL_BROWSER_EVIDENCE_SESSION_JSON = JSON.stringify({
      ...session,
      testedAt: "2026-07-19T00:00:02.000Z"
    });
    const orbCheckpoints = await checkpointArtifacts(
      root,
      "ios-18-safari",
      "kinetic-orb",
      "full-ladder"
    );
    process.env.AVAL_BROWSER_EVIDENCE_LEDGER_JSON = JSON.stringify(
      exactLedger("ios-18-safari", "kinetic-orb", "full-ladder")
    );
    await expect(finalizeBrowserDiagnosticEvidenceFromEnvironment({
      demoId: "kinetic-orb",
      checkpoints: orbCheckpoints,
      measuredRun: exactMeasuredRun("touch")
    })).rejects.toThrow(/differs from exact metadata/u);
  });

  it("rejects traversal-shaped metadata before touching the run", async () => {
    const root = await evidenceRoot(roots);
    await expect(writeBrowserDiagnosticEvidencePair({
      runRoot: root,
      slotId: "../escape",
      demoId: "end-user-playground",
      mode: "full-ladder",
      checkpoint: "ready"
    }, diagnosticReport("idle"), Uint8Array.from([1]), undefined, Uint8Array.from([2])))
      .rejects.toThrow(/slot id is unsafe/u);
    await expect(access(join(root, "escape"))).rejects.toMatchObject({
      code: "ENOENT"
    });
  });
});

describe("browser diagnostic active-canvas evidence", () => {
  it("fails closed instead of capturing an unrelated visible player", async () => {
    const unrelated = fakePlayer({
      id: "unrelated-player",
      sourceCodecs: ["h264"],
      screenshots: [Uint8Array.from([1, 2, 3])],
      samples: [{ sampledAtMilliseconds: 1, drawsCompleted: 1 }]
    });

    await expect(captureActiveAvalPlayerEvidence(
      fakePage([unrelated]),
      activeDiagnosticReport({ elementId: "active-player" }),
      { measureAdvancement: false }
    )).rejects.toThrow(/cannot bind the diagnostic active player/u);
    expect(unrelated.screenshotCalls).toBe(0);
  });

  it("measures advancement from separated canvas and draw evidence", async () => {
    const before = Uint8Array.from([137, 80, 78, 71, 1]);
    const after = Uint8Array.from([137, 80, 78, 71, 2]);
    const active = fakePlayer({
      id: "active-player",
      sourceCodecs: ["h264"],
      screenshots: [before, after],
      samples: [
        { sampledAtMilliseconds: 10, drawsCompleted: 4 },
        { sampledAtMilliseconds: 160, drawsCompleted: 7 }
      ]
    });

    const captured = await captureActiveAvalPlayerEvidence(
      fakePage([active]),
      activeDiagnosticReport({ elementId: "active-player" }),
      { measureAdvancement: true }
    );

    expect(captured.screenshot).toEqual(after);
    expect(captured.beforeScreenshot).toEqual(before);
    expect(captured.advancingFrame).toBe(true);
    expect(captured.frameProof).toEqual({
      beforeCanvasSha256: createHash("sha256").update(before).digest("hex"),
      afterCanvasSha256: createHash("sha256").update(after).digest("hex"),
      sampleIntervalMilliseconds: 150,
      beforeDrawsCompleted: 4,
      afterDrawsCompleted: 7
    });
    expect(active.screenshotCalls).toBe(2);
  });

  it("does not infer advancement from interactive readiness", async () => {
    const unchanged = Uint8Array.from([137, 80, 78, 71, 9]);
    const active = fakePlayer({
      id: "active-player",
      sourceCodecs: ["h264"],
      screenshots: [unchanged, unchanged, unchanged],
      samples: [
        { sampledAtMilliseconds: 10, drawsCompleted: 4 },
        { sampledAtMilliseconds: 150, drawsCompleted: 6 },
        { sampledAtMilliseconds: 300, drawsCompleted: 8 }
      ]
    });

    const captured = await captureActiveAvalPlayerEvidence(
      fakePage([active]),
      activeDiagnosticReport({ elementId: "active-player" }),
      { measureAdvancement: true }
    );

    expect(captured.advancingFrame).toBe(false);
    expect(captured.frameProof).not.toBeNull();
    expect(captured.frameProof).toMatchObject({
      beforeDrawsCompleted: 4,
      afterDrawsCompleted: 8
    });
    expect(captured.frameProof?.beforeCanvasSha256).toBe(
      captured.frameProof?.afterCanvasSha256
    );
    expect(active.screenshotCalls).toBe(3);
  });

  it("binds an id-less active player only by a unique authored-source signature", async () => {
    const unrelated = fakePlayer({
      id: "",
      sourceCodecs: ["vp9"],
      screenshots: [Uint8Array.from([1])],
      samples: [{ sampledAtMilliseconds: 1, drawsCompleted: 1 }]
    });
    const active = fakePlayer({
      id: "",
      sourceCodecs: ["h264"],
      screenshots: [Uint8Array.from([2])],
      samples: [{ sampledAtMilliseconds: 1, drawsCompleted: 1 }]
    });

    const captured = await captureActiveAvalPlayerEvidence(
      fakePage([unrelated, active]),
      activeDiagnosticReport({ elementId: null }),
      { measureAdvancement: false }
    );

    expect(captured.screenshot).toEqual(Uint8Array.from([2]));
    expect(unrelated.screenshotCalls).toBe(0);
    expect(active.screenshotCalls).toBe(1);
  });

  it("rejects a state label that changes after the canvas sample", async () => {
    const active = fakePlayer({
      id: "active-player",
      sourceCodecs: ["h264"],
      screenshots: [Uint8Array.from([2])],
      samples: [{ sampledAtMilliseconds: 1, drawsCompleted: 1 }]
    });

    await expect(captureActiveAvalPlayerEvidence(
      fakePage([active], activeDiagnosticReport({
        elementId: "active-player",
        visualState: "hover"
      })),
      activeDiagnosticReport({ elementId: "active-player" }),
      { measureAdvancement: false }
    )).rejects.toThrow(/state or active-player binding changed/u);
  });
});

async function checkpointArtifacts(
  root: string,
  slotId: string,
  demoId: "end-user-playground" | "grass-rabbit" | "kinetic-orb",
  mode: "full-ladder"
) {
  const result = [];
  const states = demoId === "end-user-playground"
    ? ["idle", "engaged"]
    : ["idle", "entering", "hover", "exiting"];
  for (const [index, id] of states.entries()) {
    const beforeScreenshot = Uint8Array.from([137, 80, 78, 71, index + 10]);
    const screenshot = Uint8Array.from([137, 80, 78, 71, index + 1]);
    const contextScreenshot = Uint8Array.from([137, 80, 78, 71, index + 20]);
    const artifacts = await writeBrowserDiagnosticEvidencePair({
      runRoot: root,
      slotId,
      demoId,
      mode,
      checkpoint: id
    }, diagnosticReport(id), screenshot,
    beforeScreenshot, contextScreenshot);
    result.push({
      ...artifacts,
      id,
      advancingFrame: true,
      beforePngPath: artifacts.beforePngPath ?? null,
      frameProof: {
        beforeCanvasSha256: createHash("sha256")
          .update(beforeScreenshot)
          .digest("hex"),
        afterCanvasSha256: artifacts.pngSha256,
        sampleIntervalMilliseconds: 100,
        beforeDrawsCompleted: index,
        afterDrawsCompleted: index + 1
      }
    });
  }
  return result;
}

function exactSession(slotId: string) {
  return {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    slotId,
    provider: {
      kind: "browserstack-live",
      sessionId: "browserstack-session-123"
    },
    sourceCommit: HEAD_COMMIT,
    tunnelUrl: "https://example.trycloudflare.com/",
    tunnelCreatedAt: "2026-07-19T00:00:00.000Z",
    testedAt: "2026-07-19T00:00:01.000Z",
    os: { name: "iOS", version: "18.0" },
    device: { name: "iPhone 16" },
    browser: {
      brand: "Safari",
      version: "18.0",
      engine: "WebKit",
      engineVersion: null
    }
  };
}

function exactLedger(
  slotId: string,
  demoId: "end-user-playground" | "grass-rabbit" | "kinetic-orb",
  mode: "full-ladder"
) {
  const counters = {
    outputsAccepted: 1,
    drawsCompleted: 1,
    logicalRunsCreated: 1,
    candidateCommits: 1,
    runsClosed: 0,
    transitionStarts: 1,
    transitionEnds: 1,
    loopCrossings: 1,
    nativeDecoderCreatesByLane: [1, 0] as const,
    nativeDecoderClosesByLane: [0, 0] as const
  };
  return {
    schemaVersion: 1,
    slotId,
    demoId,
    mode,
    startedAt: "2026-07-19T00:00:00.000Z",
    finishedAt: "2026-07-19T00:01:00.000Z",
    terminalFailures: 0,
    events: [],
    soak: {
      requiredMilliseconds: 60_000,
      elapsedMilliseconds: 60_000,
      samples: [
        { elapsedMilliseconds: 0, terminalFailures: 0, counters },
        {
          elapsedMilliseconds: 60_000,
          terminalFailures: 0,
          counters: { ...counters, outputsAccepted: 2, drawsCompleted: 2 }
        }
      ]
    }
  };
}

function exactMeasuredRun(profile: "desktop" | "touch" | "unsupported") {
  const soak = exactLedger(
    "ignored-slot",
    "kinetic-orb",
    "full-ladder"
  ).soak;
  return {
    interactionProfile: profile,
    startedAt: "2026-07-19T00:02:00.000Z",
    finishedAt: "2026-07-19T00:03:00.000Z",
    terminalFailures: 0,
    events: [],
    soak
  } as const;
}

async function evidenceRoot(roots: string[]): Promise<string> {
  const parent = await realpath(await mkdtemp(
    join(tmpdir(), "aval-browser-evidence-")
  ));
  roots.push(parent);
  const root = join(parent, HEAD_COMMIT, SESSION_ID);
  await initializeBrowserDiagnosticEvidenceRunRoot(root, {
    schemaVersion: 1,
    sessionId: SESSION_ID,
    createdAt: "2026-07-19T00:00:00.000Z",
    sourceAttestation: {
      headCommit: HEAD_COMMIT,
      trackedDiffSha256: "1".repeat(64),
      untrackedSourceTreeSha256: "2".repeat(64),
      policySha256: "3".repeat(64),
      servedTreeSha256: "4".repeat(64)
    }
  });
  return realpath(root);
}

function diagnosticReport(visualState: string): BrowserDiagnosticReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-19T00:00:01.000Z",
    serializationBudgetExhausted: false,
    session: {
      startedAt: "2026-07-19T00:00:00.000Z",
      startedAtMilliseconds: 1,
      url: "/?avalDiagnostics=1"
    },
    environment: {
      userAgent: "test",
      userAgentData: null,
      secureContext: true,
      crossOriginIsolated: false,
      viewport: { width: 1, height: 1 },
      devicePixelRatio: 1,
      reducedMotion: false,
      visibilityState: "visible",
      capabilities: {
        webCryptoSubtleDigest: true,
        videoDecoder: true,
        videoDecoderIsConfigSupported: true,
        videoFrame: true,
        offscreenCanvas: true,
        webgl2: true,
        webgpu: false,
        braveBrandApi: false
      }
    },
    players: [],
    authoredSources: [],
    checkpoints: [],
    latest: {
      checkpointSequence: 1,
      playerId: "player-1",
      context: null,
      element: { visualState }
    }
  };
}

interface FakePlayer {
  readonly id: string;
  readonly sourceCodecs: readonly string[];
  readonly screenshots: Uint8Array[];
  readonly samples: Array<Readonly<{
    sampledAtMilliseconds: number;
    drawsCompleted: number | null;
  }>>;
  readonly visible: boolean;
  readonly canvasVisible: boolean;
  screenshotCalls: number;
}

function fakePlayer(input: Readonly<{
  id: string;
  sourceCodecs: readonly string[];
  screenshots: readonly Uint8Array[];
  samples: readonly Readonly<{
    sampledAtMilliseconds: number;
    drawsCompleted: number | null;
  }>[];
  visible?: boolean;
  canvasVisible?: boolean;
}>): FakePlayer {
  return {
    id: input.id,
    sourceCodecs: [...input.sourceCodecs],
    screenshots: input.screenshots.map((bytes) => Uint8Array.from(bytes)),
    samples: [...input.samples],
    visible: input.visible ?? true,
    canvasVisible: input.canvasVisible ?? true,
    screenshotCalls: 0
  };
}

function fakePage(
  players: readonly FakePlayer[],
  postSampleReport: BrowserDiagnosticReport = activeDiagnosticReport({
    elementId: players.at(-1)?.id || null
  })
): Page {
  const playerLocator = (player: FakePlayer) => ({
    getAttribute: async (name: string) => name === "id" ? player.id : null,
    isVisible: async () => player.visible,
    evaluate: async (
      callback: (element: unknown, input?: unknown) => unknown,
      input?: unknown
    ) => {
      if (!String(callback).includes("sampledAtMilliseconds")) return undefined;
      const sample = player.samples.shift();
      if (sample === undefined) throw new Error("No fake player sample remains");
      const evaluated = await callback({
        getDiagnostics: () => ({
          runtime: {
            playbackLifecycle: { drawsCompleted: sample.drawsCompleted }
          }
        })
      }, input) as Readonly<Record<string, unknown>>;
      return {
        ...evaluated,
        sampledAtMilliseconds: sample.sampledAtMilliseconds
      };
    },
    locator: (selector: string) => {
      if (selector === ":scope > source") {
        return {
          count: async () => player.sourceCodecs.length,
          nth: (index: number) => ({
            getAttribute: async (name: string) => name === "data-codec"
              ? player.sourceCodecs[index] ?? null
              : null
          })
        };
      }
      if (selector === 'canvas[data-aval-layer="animated"]') {
        return {
          count: async () => 1,
          nth: () => ({
            isVisible: async () => player.canvasVisible,
            screenshot: async () => {
              const screenshot = player.screenshots[player.screenshotCalls];
              player.screenshotCalls += 1;
              if (screenshot === undefined) {
                throw new Error("No fake canvas screenshot remains");
              }
              return screenshot;
            }
          })
        };
      }
      throw new Error(`Unexpected fake player locator: ${selector}`);
    }
  });
  return {
    locator: (selector: string) => {
      if (selector !== "aval-player") {
        throw new Error(`Unexpected fake page locator: ${selector}`);
      }
      return {
        count: async () => players.length,
        nth: (index: number) => {
          const player = players[index];
          if (player === undefined) throw new Error("Fake player is unavailable");
          return playerLocator(player);
        }
      };
    },
    waitForTimeout: async () => undefined,
    evaluate: async () => JSON.stringify({
      limits: BROWSER_DIAGNOSTIC_PRODUCER_LIMITS,
      report: postSampleReport
    })
  } as unknown as Page;
}

function activeDiagnosticReport(input: Readonly<{
  elementId: string | null;
  visualState?: "idle" | "hover";
}>): BrowserDiagnosticReport {
  const playerId = "player-1";
  return {
    ...diagnosticReport(input.visualState ?? "idle"),
    players: [{
      playerId,
      context: null,
      elementId: input.elementId,
      tagName: "aval-player"
    }],
    authoredSources: [{
      playerId,
      context: null,
      index: 0,
      codec: "h264"
    }],
    latest: {
      checkpointSequence: 1,
      playerId,
      context: null,
      element: {
        elementId: input.elementId,
        tagName: "aval-player",
        readiness: "interactiveReady",
        visualState: input.visualState ?? "idle",
        diagnostics: {
          runtime: { playbackLifecycle: { drawsCompleted: 4 } }
        }
      }
    }
  };
}
