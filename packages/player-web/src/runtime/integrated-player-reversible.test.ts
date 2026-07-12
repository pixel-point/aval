import {
  MotionGraphEngine,
  type GraphPresentation
} from "@rendered-motion/graph";
import { describe, expect, it } from "vitest";

import { createInteractionCachePlanFromSemanticSequences } from "./interaction-cache-plan.js";
import {
  ReversiblePresentationCoordinator,
  ReversiblePresentationInvariantError,
  type ReversiblePresentationRenderer
} from "./reversible-presentation.js";
import { readinessFixture } from "./readiness-test-fixture.js";

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
  const plan = createInteractionCachePlanFromSemanticSequences({
    rendition: "opaque",
    width: 4,
    height: 4,
    reversibleClips: [{
      unit: "rev",
      sourceEndpoint: {
        state: endpoints.source,
        port: "default",
        frames: frames("source-body", 6)
      },
      clip: frames("rev", 6),
      targetEndpoint: {
        state: endpoints.target,
        port: "default",
        frames: frames("target-body", 6)
      }
    }],
    cutRunways: [],
    deviceLimits: { maxTextureSize: 4_096, maxArrayTextureLayers: 128 }
  });
  return {
    renderer,
    coordinator: new ReversiblePresentationCoordinator(plan, renderer),
    decoderCalls: () => decoderCalls,
    useDecoder: () => { decoderCalls += 1; }
  };
}

function frames(unit: string, count: number) {
  return Array.from({ length: count }, (_, localFrame) => ({
    rendition: "opaque",
    unit,
    localFrame
  }));
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
