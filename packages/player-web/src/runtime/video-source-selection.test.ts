import type {
  CompiledManifest,
  OpaqueProductionRenditionV1_1,
  VideoCodec
} from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import { SourceSupportProbe } from "./source-support-probe.js";
import { certifyVideoRenditions } from "./video-rendition-certification.js";
import {
  selectVideoSource,
  VideoSourceSelectionError,
  type VideoSourceDescriptor,
  type VideoSourceSession
} from "./video-source-selection.js";

const SPECS = Object.freeze({
  h264: Object.freeze({ codec: "avc1.42E020", bitstream: "annex-b" as const }),
  h265: Object.freeze({ codec: "hvc1.1.6.L30.90", bitstream: "annex-b" as const }),
  vp9: Object.freeze({
    codec: "vp09.00.10.08.01.01.01.01.00",
    bitstream: "frame" as const
  }),
  av1: Object.freeze({
    codec: "av01.0.00M.08.0.110.01.01.01.0",
    bitstream: "low-overhead" as const
  })
});

interface Candidate extends VideoSourceDescriptor {
  readonly id: string;
}

describe("ordered catalog-certified video source selection", () => {
  it("preserves source and rendition order and retires each rejected source", async () => {
    const events: string[] = [];
    const sessions = new Map<string, FakeSession>();
    const result = await selectVideoSource({
      candidates: Object.freeze([candidate(0, "av1"), candidate(1, "vp9")]),
      signal: new AbortController().signal,
      async open(source) {
        events.push(`open:${source.id}`);
        const session = new FakeSession(source.id, manifest(
          source.id === "av1" ? "av1" : "vp9",
          source.id === "vp9"
            ? [rendition("first", "vp9"), rendition("second", "vp9")]
            : undefined
        ), events);
        sessions.set(source.id, session);
        return session;
      },
      createProbe(source) {
        return probe(source.id, events, (_config, call) =>
          source.id === "vp9" && call === 2
        );
      },
      isResourceEligible: () => true
    });

    expect(result.candidate.id).toBe("vp9");
    expect(result.rendition).toBe(result.session.catalog.videoRenditions[1]);
    expect(events).toEqual([
      "open:av1",
      "probe:av1:1",
      "probe-dispose:av1",
      "session-dispose:av1",
      "open:vp9",
      "probe:vp9:1",
      "probe:vp9:2",
      "probe-dispose:vp9"
    ]);
    expect(sessions.get("av1")?.disposed).toBe(true);
    expect(sessions.get("vp9")?.disposed).toBe(false);
    expect(result.attempts.map(({ outcome }) => outcome)).toEqual([
      "all-renditions-unsupported",
      "selected"
    ]);
  });

  it.each(["open", "mismatch", "probe"] as const)(
    "treats %s failures as terminal and never opens a later source",
    async (failureAt) => {
      const events: string[] = [];
      const terminal = new Error(`terminal:${failureAt}`);
      const operation = selectVideoSource({
        candidates: Object.freeze([
          candidate(0, "h264", "first"),
          candidate(1, "vp9", "must-not-open")
        ]),
        signal: new AbortController().signal,
        async open(source) {
          events.push(`open:${source.id}`);
          if (failureAt === "open") throw terminal;
          return new FakeSession(
            source.id,
            manifest(failureAt === "mismatch" ? "vp9" : codecFamily(source.codec)),
            events
          );
        },
        createProbe(source) {
          return probe(source.id, events, () => {
            if (failureAt === "probe") throw terminal;
            return true;
          });
        },
        isResourceEligible: () => true
      });

      await expect(operation).rejects.toThrow();
      expect(events).not.toContain("open:must-not-open");
      if (failureAt !== "open") expect(events).toContain("session-dispose:first");
    }
  );

  it("aborts stale selection, retires the active source, and opens no successor", async () => {
    const controller = new AbortController();
    const reason = new DOMException("source generation changed", "AbortError");
    const opened: string[] = [];
    const disposed: string[] = [];
    let started!: () => void;
    const probeStarted = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const held = new Promise<boolean>((resolve) => { release = () => resolve(true); });
    const pending = selectVideoSource({
      candidates: Object.freeze([candidate(0, "av1"), candidate(1, "vp9")]),
      signal: controller.signal,
      async open(source) {
        opened.push(source.id);
        return new FakeSession(source.id, manifest(codecFamily(source.codec)), disposed);
      },
      createProbe(source) {
        return new SourceSupportProbe({
          async probeConfig() {
            disposed.push(`probe:${source.id}`);
            started();
            return held;
          },
          async dispose() { disposed.push(`probe-dispose:${source.id}`); }
        });
      },
      isResourceEligible: () => true
    });

    await probeStarted;
    controller.abort(reason);
    release();
    await expect(pending).rejects.toBe(reason);
    expect(opened).toEqual(["av1"]);
    expect(disposed).toContain("probe-dispose:av1");
    expect(disposed).toContain("session-dispose:av1");
  });

  it("reports sanitized exhaustion without retaining authored URLs", async () => {
    const secret = "https://user:password@example.test/private.avl";
    let error: unknown;
    try {
      await selectVideoSource({
        candidates: Object.freeze([{ authoredIndex: 0, codec: "not-a-codec", secret }]),
        signal: new AbortController().signal,
        async open() { throw new Error(secret); },
        createProbe() { throw new Error(secret); },
        isResourceEligible: () => true
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(VideoSourceSelectionError);
    expect(error).toMatchObject({
      attempts: [{ authoredIndex: 0, outcome: "invalid-codec-hint" }]
    });
    expect(JSON.stringify(error)).not.toContain(secret);
  });
});

class FakeSession implements VideoSourceSession {
  public disposed = false;
  public readonly catalog;

  public constructor(
    public readonly id: string,
    manifestValue: Readonly<CompiledManifest>,
    private readonly events: string[] = []
  ) {
    this.catalog = Object.freeze({
      manifest: manifestValue,
      videoRenditions: certifyVideoRenditions(manifestValue)
    });
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    this.events.push(`session-dispose:${this.id}`);
  }
}

function probe(
  id: string,
  events: string[],
  result: (config: Readonly<VideoDecoderConfig>, call: number) => boolean
): SourceSupportProbe {
  let call = 0;
  return new SourceSupportProbe({
    async probeConfig(config) {
      call += 1;
      events.push(`probe:${id}:${String(call)}`);
      return result(config, call);
    },
    async dispose() { events.push(`probe-dispose:${id}`); }
  });
}

function candidate(
  authoredIndex: number,
  family: VideoCodec,
  id: string = family
): Readonly<Candidate> {
  return Object.freeze({ authoredIndex, id, codec: SPECS[family].codec });
}

function codecFamily(codec: string): VideoCodec {
  const match = Object.entries(SPECS).find(([, value]) => value.codec === codec);
  if (match === undefined) throw new Error("fixture codec is unknown");
  return match[0] as VideoCodec;
}

function rendition(
  id: string,
  family: VideoCodec
): OpaqueProductionRenditionV1_1 {
  return {
    id,
    codec: SPECS[family].codec,
    bitDepth: 8,
    codedWidth: 64,
    codedHeight: 32,
    alphaLayout: { type: "opaque", colorRect: [0, 0, 64, 32] },
    bitrate: { average: 100_000, peak: 150_000 }
  };
}

function manifest(
  family: VideoCodec,
  renditions: readonly OpaqueProductionRenditionV1_1[] = [
    rendition("main", family)
  ]
): CompiledManifest {
  return {
    formatVersion: "1.1",
    generator: "test",
    codec: family,
    bitstream: SPECS[family].bitstream,
    layout: "opaque",
    canvas: { width: 64, height: 32, fit: "contain", pixelAspect: [1, 1], colorSpace: "srgb" },
    frameRate: { numerator: 30, denominator: 1 },
    renditions,
    units: [],
    initialState: "idle",
    states: [],
    edges: [],
    bindings: [],
    readiness: { policy: "all-routes", bootstrapUnits: [], immediateEdges: [] },
    limits: {
      maxCompiledBytes: 1_000_000,
      maxRuntimeBytes: 1_000_000,
      decodedPixelBytes: 1,
      persistentCacheBytes: 1,
      runtimeWorkingSetBytes: 1
    }
  };
}
