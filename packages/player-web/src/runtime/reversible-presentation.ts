import type { GraphPresentation } from "@rendered-motion/graph";

import type {
  InteractionCacheEndpointRunway,
  InteractionCachePlan,
  InteractionCacheReversibleClip
} from "./interaction-cache-plan.js";
import type { RuntimeFrameKey } from "./model.js";
import type {
  RenderFrameHandle,
  ResidentFrameHandle
} from "./opaque-frame-renderer.js";

type ReversibleGraphPresentation = Extract<
  GraphPresentation,
  { readonly kind: "reversible" }
>;

export interface ReversiblePresentationRenderer {
  readonly resourceGeneration: number;
  residentHandle(layer: number): ResidentFrameHandle;
  draw(handle: RenderFrameHandle): void;
}

export interface PreparedReversiblePresentation {
  readonly presentation: Readonly<ReversibleGraphPresentation>;
  readonly frame: Readonly<RuntimeFrameKey>;
  readonly layer: number;
  readonly handle: Readonly<ResidentFrameHandle>;
  readonly expectedPreviousFrame: number | null;
  readonly expectedPreviousUnit: string | null;
}

export interface PreparedReversibleRunwayFrame {
  readonly frame: Readonly<RuntimeFrameKey>;
  readonly layer: number;
  readonly handle: Readonly<ResidentFrameHandle>;
}

export interface ReversiblePresentationSnapshot {
  readonly activeUnit: string | null;
  readonly activeEdge: string | null;
  readonly visibleFrame: number | null;
  readonly direction: "forward" | "reverse" | null;
  readonly directionChanges: number;
  readonly draws: number;
  readonly disposed: boolean;
}

export class ReversiblePresentationInvariantError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReversiblePresentationInvariantError";
  }
}

/**
 * Stateful draw-barrier owner for already-resident reversible layers. Graph
 * routing stays outside; this class accepts only the graph's exact visible
 * presentation and never invokes a decoder.
 */
export class ReversiblePresentationCoordinator {
  readonly #renderer: ReversiblePresentationRenderer;
  readonly #clips = new Map<
    string,
    Readonly<InteractionCacheReversibleClip>
  >();
  readonly #issuedTokens = new WeakSet<object>();
  readonly #drawnTokens = new WeakSet<object>();

  #activeUnit: string | null = null;
  #activeEdge: string | null = null;
  #visibleFrame: number | null = null;
  #direction: "forward" | "reverse" | null = null;
  #directionChanges = 0;
  #draws = 0;
  #disposed = false;

  public constructor(
    plan: Readonly<InteractionCachePlan>,
    renderer: ReversiblePresentationRenderer
  ) {
    if (plan === null || typeof plan !== "object") {
      throw new TypeError("reversible presentation requires a cache plan");
    }
    validateRenderer(renderer);
    for (const clip of plan.reversibleClips) {
      if (this.#clips.has(clip.unit)) {
        throw new ReversiblePresentationInvariantError(
          "reversible cache plan contains a duplicate unit"
        );
      }
      this.#clips.set(clip.unit, clip);
    }
    this.#renderer = renderer;
  }

  public prepare(
    presentation: Readonly<ReversibleGraphPresentation>
  ): Readonly<PreparedReversiblePresentation> {
    this.#assertActive();
    validatePresentation(presentation);
    const clip = this.#requireClip(presentation.unitId);
    const frameCount = clip.clip.frames.length;
    if (presentation.frameIndex >= frameCount) {
      throw new ReversiblePresentationInvariantError(
        "reversible graph frame exceeds its resident clip"
      );
    }

    if (this.#activeUnit === null) {
      const entry = presentation.direction === "forward"
        ? 0
        : frameCount - 1;
      if (presentation.frameIndex !== entry) {
        throw new ReversiblePresentationInvariantError(
          "reversible presentation must enter at an endpoint"
        );
      }
    } else {
      if (this.#activeUnit !== presentation.unitId) {
        throw new ReversiblePresentationInvariantError(
          "another reversible unit is already active"
        );
      }
      if (
        this.#visibleFrame === null ||
        Math.abs(presentation.frameIndex - this.#visibleFrame) !== 1
      ) {
        throw new ReversiblePresentationInvariantError(
          "active reversible presentations must be adjacent"
        );
      }
    }

    const frame = clip.clip.frames[presentation.frameIndex];
    const layer = clip.clip.layers[presentation.frameIndex];
    if (frame === undefined || layer === undefined) {
      throw new ReversiblePresentationInvariantError(
        "reversible cache sequence is sparse"
      );
    }
    const handle = this.#renderer.residentHandle(layer);
    if (handle.resourceGeneration !== this.#renderer.resourceGeneration) {
      throw new ReversiblePresentationInvariantError(
        "reversible resident handle is stale"
      );
    }
    const prepared = Object.freeze({
      presentation: Object.freeze({ ...presentation }),
      frame,
      layer,
      handle,
      expectedPreviousFrame: this.#visibleFrame,
      expectedPreviousUnit: this.#activeUnit
    });
    this.#issuedTokens.add(prepared);
    return prepared;
  }

  public draw(
    prepared: Readonly<PreparedReversiblePresentation>,
    presentation: Readonly<ReversibleGraphPresentation>
  ): void {
    this.#assertActive();
    if (!this.#issuedTokens.has(prepared)) {
      throw new ReversiblePresentationInvariantError(
        "reversible presentation token was not issued by this coordinator"
      );
    }
    if (this.#drawnTokens.has(prepared)) {
      throw new ReversiblePresentationInvariantError(
        "reversible presentation token was already drawn"
      );
    }
    if (!samePresentation(prepared.presentation, presentation)) {
      throw new ReversiblePresentationInvariantError(
        "prepared reversible presentation does not match the graph"
      );
    }
    if (
      prepared.expectedPreviousFrame !== this.#visibleFrame ||
      prepared.expectedPreviousUnit !== this.#activeUnit
    ) {
      throw new ReversiblePresentationInvariantError(
        "prepared reversible presentation became stale"
      );
    }
    if (
      prepared.handle.resourceGeneration !==
      this.#renderer.resourceGeneration
    ) {
      throw new ReversiblePresentationInvariantError(
        "reversible resident handle is stale"
      );
    }

    this.#renderer.draw(prepared.handle);
    this.#drawnTokens.add(prepared);
    if (
      this.#direction !== null &&
      this.#direction !== presentation.direction
    ) {
      this.#directionChanges = checkedIncrement(
        this.#directionChanges,
        "reversible direction-change count"
      );
    }
    this.#activeUnit = presentation.unitId;
    this.#activeEdge = presentation.edgeId;
    this.#visibleFrame = presentation.frameIndex;
    this.#direction = presentation.direction;
    this.#draws = checkedIncrement(this.#draws, "reversible draw count");
  }

  public completeToEndpoint(
    unit: string,
    state: string,
    port: string
  ): readonly Readonly<PreparedReversibleRunwayFrame>[] {
    const runway = this.prepareEndpointRunway(unit, state, port);
    this.commitEndpoint(unit, state, port);
    return runway;
  }

  /** Validates and materializes endpoint pixels without ending reversibility. */
  public prepareEndpointRunway(
    unit: string,
    state: string,
    port: string
  ): readonly Readonly<PreparedReversibleRunwayFrame>[] {
    this.#assertActive();
    const endpoint = this.#requireReachedEndpoint(unit, state, port);

    const runway = endpoint.frames.map((frame, index) => {
      const layer = endpoint.layers[index];
      if (layer === undefined) {
        throw new ReversiblePresentationInvariantError(
          "reversible endpoint runway is sparse"
        );
      }
      const handle = this.#renderer.residentHandle(layer);
      if (handle.resourceGeneration !== this.#renderer.resourceGeneration) {
        throw new ReversiblePresentationInvariantError(
          "reversible endpoint handle is stale"
        );
      }
      return Object.freeze({ frame, layer, handle });
    });
    return Object.freeze(runway);
  }

  /** Commits the endpoint only after its first body pixel was presented. */
  public commitEndpoint(unit: string, state: string, port: string): void {
    this.#assertActive();
    this.#requireReachedEndpoint(unit, state, port);
    this.#activeUnit = null;
    this.#activeEdge = null;
    this.#visibleFrame = null;
    this.#direction = null;
  }

  public snapshot(): Readonly<ReversiblePresentationSnapshot> {
    return Object.freeze({
      activeUnit: this.#activeUnit,
      activeEdge: this.#activeEdge,
      visibleFrame: this.#visibleFrame,
      direction: this.#direction,
      directionChanges: this.#directionChanges,
      draws: this.#draws,
      disposed: this.#disposed
    });
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#activeUnit = null;
    this.#activeEdge = null;
    this.#visibleFrame = null;
    this.#direction = null;
  }

  #requireClip(unit: string): Readonly<InteractionCacheReversibleClip> {
    const clip = this.#clips.get(unit);
    if (clip === undefined) {
      throw new ReversiblePresentationInvariantError(
        "reversible unit is not resident"
      );
    }
    return clip;
  }

  #requireReachedEndpoint(
    unit: string,
    state: string,
    port: string
  ): Readonly<InteractionCacheEndpointRunway> {
    const clip = this.#requireClip(unit);
    if (this.#activeUnit !== unit || this.#visibleFrame === null) {
      throw new ReversiblePresentationInvariantError(
        "reversible unit is not active"
      );
    }
    if (
      clip.sourceEndpoint.state === state &&
      clip.sourceEndpoint.port === port
    ) {
      if (this.#visibleFrame !== 0) {
        throw new ReversiblePresentationInvariantError(
          "reversible clip has not reached its source endpoint"
        );
      }
      return clip.sourceEndpoint;
    }
    if (
      clip.targetEndpoint.state === state &&
      clip.targetEndpoint.port === port
    ) {
      if (this.#visibleFrame !== clip.clip.frames.length - 1) {
        throw new ReversiblePresentationInvariantError(
          "reversible clip has not reached its target endpoint"
        );
      }
      return clip.targetEndpoint;
    }
    throw new ReversiblePresentationInvariantError(
      "reversible endpoint is not declared by the cache plan"
    );
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new ReversiblePresentationInvariantError(
        "reversible presentation coordinator is disposed"
      );
    }
  }
}

function validateRenderer(renderer: ReversiblePresentationRenderer): void {
  if (
    renderer === null ||
    typeof renderer !== "object" ||
    typeof renderer.residentHandle !== "function" ||
    typeof renderer.draw !== "function" ||
    !Number.isSafeInteger(renderer.resourceGeneration) ||
    renderer.resourceGeneration < 1
  ) {
    throw new TypeError("reversible presentation renderer is malformed");
  }
}

function validatePresentation(
  presentation: Readonly<ReversibleGraphPresentation>
): void {
  if (
    presentation.kind !== "reversible" ||
    typeof presentation.edgeId !== "string" ||
    presentation.edgeId.length < 1 ||
    typeof presentation.unitId !== "string" ||
    presentation.unitId.length < 1 ||
    !Number.isSafeInteger(presentation.frameIndex) ||
    presentation.frameIndex < 0 ||
    (presentation.direction !== "forward" &&
      presentation.direction !== "reverse")
  ) {
    throw new ReversiblePresentationInvariantError(
      "reversible graph presentation is malformed"
    );
  }
}

function samePresentation(
  left: Readonly<ReversibleGraphPresentation>,
  right: Readonly<ReversibleGraphPresentation>
): boolean {
  return left.kind === right.kind &&
    left.edgeId === right.edgeId &&
    left.unitId === right.unitId &&
    left.frameIndex === right.frameIndex &&
    left.direction === right.direction;
}

function checkedIncrement(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label} exceeded the safe-integer range`);
  }
  return value + 1;
}
