import {
  MotionGraphEngine,
  type GraphPresentation
} from "@pixel-point/aval-graph";
import type { CompiledManifest, Unit } from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import { createInteractionCachePlan } from "./interaction-cache-plan.js";
import {
  ReversiblePresentationCoordinator,
  ReversiblePresentationInvariantError,
  type ReversiblePresentationRenderer
} from "./reversible-presentation.js";
import { readinessFixture } from "./readiness-test-support.js";

describe("resident reversible presentation", () => {
  it("draws the M3 graph's adjacent inverse and selects its source recovery", () => {
    const fixture = createFixture({ source: "finite", target: "held" });
    const graph = new MotionGraphEngine();
    graph.install(readinessFixture().graph);
    graph.beginAnimated();

    graph.request("finite");
    graph.tick({ contentOrdinal: 0n });
    graph.tick({ contentOrdinal: 1n });
    graph.tick({ contentOrdinal: 2n });
    graph.request("held");
    graph.tick({ contentOrdinal: 3n });
    graph.tick({ contentOrdinal: 4n });

    const forward = requireReversible(
      graph.tick({ contentOrdinal: 5n }).presentation
    );
    draw(fixture, forward);
    draw(fixture, requireReversible(
      graph.tick({ contentOrdinal: 6n }).presentation
    ));
    draw(fixture, requireReversible(
      graph.tick({ contentOrdinal: 7n }).presentation
    ));

    const inverseRequest = graph.request("finite");
    expect(inverseRequest).toMatchObject({ accepted: true, joined: false });
    const inverse = requireReversible(
      graph.tick({ contentOrdinal: 8n }).presentation
    );
    expect(inverse).toMatchObject({
      edgeId: "edge-rev-reverse",
      frameIndex: 1,
      direction: "reverse"
    });
    draw(fixture, inverse);
    draw(fixture, requireReversible(
      graph.tick({ contentOrdinal: 9n }).presentation
    ));

    const recovered = graph.tick({ contentOrdinal: 10n });
    expect(recovered.presentation).toMatchObject({
      kind: "body",
      state: "finite",
      frameIndex: 0
    });
    const runway = fixture.coordinator.completeToEndpoint(
      "rev",
      "finite",
      "default"
    );
    expect(runway.map(({ layer }) => layer)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(fixture.renderer.drawnLayers).toEqual([6, 7, 8, 7, 6]);
    expect(fixture.decoderCalls()).toBe(0);
  });

  it("maps every forward and reverse frame to its persistent authored layer", () => {
    const fixture = createFixture();

    for (let frameIndex = 0; frameIndex < 6; frameIndex += 1) {
      fixture.coordinator.draw(
        fixture.coordinator.prepare(presentation("forward", frameIndex)),
        presentation("forward", frameIndex)
      );
    }
    fixture.coordinator.completeToEndpoint("rev", "target", "default");
    for (let frameIndex = 5; frameIndex >= 0; frameIndex -= 1) {
      fixture.coordinator.draw(
        fixture.coordinator.prepare(presentation("reverse", frameIndex)),
        presentation("reverse", frameIndex)
      );
    }

    expect(fixture.renderer.drawnLayers).toEqual([
      6, 7, 8, 9, 10, 11,
      11, 10, 9, 8, 7, 6
    ]);
    expect(fixture.decoderCalls()).toBe(0);
  });

  it.each([1, 2, 3, 4])(
    "reverses from interior frame %i to the adjacent cached frame",
    (turningFrame) => {
      const fixture = createFixture();
      for (let frameIndex = 0; frameIndex <= turningFrame; frameIndex += 1) {
        draw(fixture, presentation("forward", frameIndex));
      }

      const inverse = presentation("reverse", turningFrame - 1);
      draw(fixture, inverse);

      expect(fixture.renderer.drawnLayers.at(-1)).toBe(6 + turningFrame - 1);
      expect(fixture.coordinator.snapshot()).toMatchObject({
        activeEdge: "edge-reverse",
        visibleFrame: turningFrame - 1,
        directionChanges: 1
      });
      expect(fixture.decoderCalls()).toBe(0);
    }
  );

  it("reverses at both endpoints and supports repeated direction changes", () => {
    const fixture = createFixture();
    const sequence = [
      presentation("forward", 0),
      presentation("reverse", 1),
      presentation("forward", 2),
      presentation("reverse", 1),
      presentation("reverse", 0),
      presentation("forward", 1)
    ];
    for (const value of sequence) draw(fixture, value);

    expect(fixture.renderer.drawnLayers).toEqual([6, 7, 8, 7, 6, 7]);
    expect(fixture.coordinator.snapshot()).toMatchObject({
      visibleFrame: 1,
      directionChanges: 4,
      draws: 6
    });
  });

  it("returns exact source and target recovery runways and resets on completion", () => {
    const fixture = createFixture();
    for (let frameIndex = 0; frameIndex < 6; frameIndex += 1) {
      draw(fixture, presentation("forward", frameIndex));
    }
    const target = fixture.coordinator.completeToEndpoint(
      "rev",
      "target",
      "default"
    );
    expect(target.map(({ frame, layer }) => [frame.localFrame, layer]))
      .toEqual([[0, 12], [1, 13], [2, 14], [3, 15], [4, 16], [5, 17]]);
    expect(fixture.coordinator.snapshot().activeUnit).toBeNull();

    for (let frameIndex = 5; frameIndex >= 0; frameIndex -= 1) {
      draw(fixture, presentation("reverse", frameIndex));
    }
    const source = fixture.coordinator.completeToEndpoint(
      "rev",
      "source",
      "default"
    );
    expect(source.map(({ frame, layer }) => [frame.localFrame, layer]))
      .toEqual([[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);
  });

  it("stages an endpoint non-destructively until body zero commits", () => {
    const fixture = createFixture();
    for (let frameIndex = 0; frameIndex < 6; frameIndex += 1) {
      draw(fixture, presentation("forward", frameIndex));
    }

    const staged = fixture.coordinator.prepareEndpointRunway(
      "rev",
      "target",
      "default"
    );
    expect(staged[0]).toMatchObject({
      frame: { unit: "target-body", localFrame: 0 },
      layer: 12
    });
    expect(fixture.coordinator.snapshot()).toMatchObject({
      activeUnit: "rev",
      visibleFrame: 5,
      direction: "forward"
    });

    // An inverse accepted before endpoint body zero draws resumes from the
    // adjacent resident frame; staging did not destroy clip ownership.
    draw(fixture, presentation("reverse", 4));
    expect(fixture.coordinator.snapshot()).toMatchObject({
      activeUnit: "rev",
      visibleFrame: 4,
      direction: "reverse"
    });

    draw(fixture, presentation("forward", 5));
    fixture.coordinator.prepareEndpointRunway("rev", "target", "default");
    fixture.coordinator.commitEndpoint("rev", "target", "default");
    expect(fixture.coordinator.snapshot().activeUnit).toBeNull();
  });

  it("rejects interior entry, duplicate/nonadjacent frames, and wrong endpoint", () => {
    const fixture = createFixture();
    expect(() => fixture.coordinator.prepare(presentation("forward", 2)))
      .toThrow("endpoint");
    draw(fixture, presentation("forward", 0));
    expect(() => fixture.coordinator.prepare(presentation("forward", 0)))
      .toThrow("adjacent");
    expect(() => fixture.coordinator.prepare(presentation("forward", 2)))
      .toThrow("adjacent");
    expect(() => fixture.coordinator.completeToEndpoint(
      "rev",
      "target",
      "default"
    )).toThrow("target endpoint");
  });

  it("joins duplicate destination intent without duplicating cached draws", () => {
    const fixture = createFixture();
    const token = fixture.coordinator.prepare(presentation("forward", 0));
    // Multiple semantic requests share one graph presentation token.
    fixture.coordinator.draw(token, presentation("forward", 0));
    expect(fixture.renderer.drawnLayers).toEqual([6]);
    expect(() => fixture.coordinator.draw(token, presentation("forward", 0)))
      .toThrow("already drawn");
  });

  it("rejects fabricated and cross-coordinator presentation tokens", () => {
    const left = createFixture();
    const right = createFixture();
    const value = presentation("forward", 0);
    const foreign = right.coordinator.prepare(value);

    expect(() => left.coordinator.draw(foreign, value)).toThrow("not issued");
    expect(() => left.coordinator.draw({
      ...foreign,
      handle: left.renderer.residentHandle(6)
    }, value)).toThrow("not issued");
    expect(left.renderer.drawnLayers).toEqual([]);
  });

  it("keeps resident handles valid after decoded source-frame closure", () => {
    const fixture = createFixture();
    let sourceClosed = true;
    expect(sourceClosed).toBe(true);
    draw(fixture, presentation("forward", 0));
    sourceClosed = true;
    draw(fixture, presentation("forward", 1));

    expect(fixture.renderer.drawnLayers).toEqual([6, 7]);
    expect(sourceClosed).toBe(true);
  });

  it("rejects stale resource handles and terminalizes disposal idempotently", () => {
    const fixture = createFixture();
    const prepared = fixture.coordinator.prepare(presentation("forward", 0));
    fixture.renderer.resourceGeneration = 2;
    expect(() => fixture.coordinator.draw(
      prepared,
      presentation("forward", 0)
    )).toThrow("stale");

    fixture.coordinator.dispose();
    fixture.coordinator.dispose();
    expect(() => fixture.coordinator.prepare(presentation("forward", 0)))
      .toThrow("disposed");
  });
});

function createFixture(
  endpoints: Readonly<{ source: string; target: string }> = {
    source: "source",
    target: "target"
  }
) {
  const renderer = new FakeRenderer();
  let decoderCalls = 0;
  const plan = createInteractionCachePlan({
    manifest: reversibleManifest(endpoints),
    rendition: "opaque",
    deviceLimits: { maxTextureSize: 4_096, maxArrayTextureLayers: 128 }
  });
  return {
    renderer,
    coordinator: new ReversiblePresentationCoordinator(plan, renderer),
    decoderCalls: () => decoderCalls,
    useDecoder: () => { decoderCalls += 1; }
  };
}

function reversibleManifest(
  endpoints: Readonly<{ source: string; target: string }>
): CompiledManifest {
  const sourceBody = `${endpoints.source}-body`;
  const targetBody = `${endpoints.target}-body`;
  const units: readonly Unit[] = [
    body(sourceBody, 0),
    body(targetBody, 6),
    {
      id: "rev",
      kind: "reversible",
      frameCount: 6,
      residency: {
        endpoints: [
          { state: endpoints.source, port: "default", frames: 6 },
          { state: endpoints.target, port: "default", frames: 6 }
        ]
      },
      chunks: [chunk(12, 6)]
    }
  ];
  return {
    formatVersion: "1.1",
    generator: "integrated-reversible-tests",
    codec: "h264",
    bitstream: "annex-b",
    layout: "opaque",
    canvas: {
      width: 4,
      height: 4,
      fit: "contain",
      pixelAspect: [1, 1],
      colorSpace: "srgb"
    },
    frameRate: { numerator: 30, denominator: 1 },
    renditions: [{
      id: "opaque",
      codec: "avc1.42E020",
      bitDepth: 8,
      codedWidth: 4,
      codedHeight: 4,
      alphaLayout: { type: "opaque", colorRect: [0, 0, 4, 4] },
      bitrate: { average: 1, peak: 1 }
    }],
    units,
    initialState: endpoints.source,
    states: [
      { id: endpoints.source, bodyUnit: sourceBody },
      { id: endpoints.target, bodyUnit: targetBody }
    ],
    edges: [
      {
        id: "edge-forward",
        from: endpoints.source,
        to: endpoints.target,
        start: {
          type: "portal",
          sourcePort: "default",
          targetPort: "default",
          maxWaitFrames: 1
        },
        transition: { kind: "reversible", unit: "rev", direction: "forward" },
        continuity: "exact-authored"
      },
      {
        id: "edge-reverse",
        from: endpoints.target,
        to: endpoints.source,
        start: {
          type: "portal",
          sourcePort: "default",
          targetPort: "default",
          maxWaitFrames: 1
        },
        transition: {
          kind: "reversible",
          unit: "rev",
          direction: "reverse",
          reverseOf: "edge-forward"
        },
        continuity: "exact-reverse"
      }
    ],
    bindings: [],
    readiness: {
      policy: "all-routes",
      bootstrapUnits: [sourceBody],
      immediateEdges: ["edge-forward"]
    },
    limits: {
      maxCompiledBytes: 64 * 1024,
      maxRuntimeBytes: 1024 * 1024,
      decodedPixelBytes: 64,
      persistentCacheBytes: 18 * 64,
      runtimeWorkingSetBytes: 18 * 64
    }
  };
}

function body(
  id: string,
  chunkStart: number
): Extract<Unit, { readonly kind: "body" }> {
  return {
    id,
    kind: "body",
    playback: "finite",
    frameCount: 6,
    ports: [{ id: "default", entryFrame: 0, portalFrames: [5] }],
    chunks: [chunk(chunkStart, 6)]
  };
}

function chunk(chunkStart: number, frameCount: number) {
  return {
    rendition: "opaque",
    chunkStart,
    chunkCount: frameCount,
    frameCount,
    sha256: "0".repeat(64)
  };
}

function presentation(
  direction: "forward" | "reverse",
  frameIndex: number
): Extract<GraphPresentation, { readonly kind: "reversible" }> {
  return {
    kind: "reversible",
    edgeId: direction === "forward" ? "edge-forward" : "edge-reverse",
    unitId: "rev",
    frameIndex,
    direction
  };
}

function draw(
  fixture: ReturnType<typeof createFixture>,
  value: ReturnType<typeof presentation>
): void {
  fixture.coordinator.draw(fixture.coordinator.prepare(value), value);
}

function requireReversible(
  value: Readonly<GraphPresentation> | null
): Extract<GraphPresentation, { readonly kind: "reversible" }> {
  if (value?.kind !== "reversible") {
    throw new Error("expected the graph to present a reversible frame");
  }
  return value;
}

class FakeRenderer implements ReversiblePresentationRenderer {
  public resourceGeneration = 1;
  public readonly drawnLayers: number[] = [];

  public residentHandle(layer: number) {
    return Object.freeze({
      kind: "resident" as const,
      layer,
      resourceGeneration: this.resourceGeneration
    });
  }

  public draw(handle: { readonly kind: "resident"; readonly layer: number;
    readonly resourceGeneration: number }): void {
    if (handle.resourceGeneration !== this.resourceGeneration) {
      throw new ReversiblePresentationInvariantError(
        "resident handle belongs to stale resources"
      );
    }
    this.drawnLayers.push(handle.layer);
  }
}
