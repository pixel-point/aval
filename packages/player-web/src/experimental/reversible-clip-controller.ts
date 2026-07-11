export type ReversibleClipPhase = "stable" | "waiting" | "clip" | "runway";

export type ReversibleClipDirection = "forward" | "reverse";

export type ReversibleClipRequestOutcome =
  | "begin"
  | "cancel"
  | "continue"
  | "reverse"
  | "follow-on"
  | "ignored";

export interface ReversibleClipControllerOptions<TEndpoint extends string> {
  readonly sourceEndpoint: TEndpoint;
  readonly targetEndpoint: TEndpoint;
  readonly initialEndpoint?: TEndpoint;
  readonly clipFrameCount: number;
  readonly sourceRunwayFrameCount: number;
  readonly targetRunwayFrameCount: number;
  readonly canFollow?: (
    prospectiveEndpoint: TEndpoint,
    destination: TEndpoint
  ) => boolean;
  /** Maximum diagnostic ticks retained in memory. Defaults to 256. */
  readonly traceCapacity?: number;
  /** Maximum distinct intents evaluated on one content tick. Defaults to 32. */
  readonly requestCapacity?: number;
}

export interface ReversibleClipRequest<TEndpoint extends string> {
  readonly sequence: number;
  readonly destination: TEndpoint;
}

export interface ReversibleClipRequestTrace<TEndpoint extends string>
  extends ReversibleClipRequest<TEndpoint> {
  readonly outcome: ReversibleClipRequestOutcome;
}

export interface ReversibleClipFollowOn<TEndpoint extends string> {
  readonly sequence: number;
  readonly fromEndpoint: TEndpoint;
  readonly destination: TEndpoint;
}

export type ReversibleClipPresentation<TEndpoint extends string> =
  | {
      readonly kind: "stable";
      readonly endpoint: TEndpoint;
    }
  | {
      readonly kind: "clip";
      readonly frameIndex: number;
      readonly direction: ReversibleClipDirection;
    }
  | {
      readonly kind: "runway";
      readonly endpoint: TEndpoint;
      readonly frameIndex: number;
      readonly direction: ReversibleClipDirection;
    };

export interface ReversibleClipSnapshot<TEndpoint extends string> {
  readonly tick: number;
  readonly phase: ReversibleClipPhase;
  readonly direction: ReversibleClipDirection | null;
  readonly inTransition: boolean;
  readonly requestedEndpoint: TEndpoint;
  readonly visualEndpoint: TEndpoint;
  readonly prospectiveEndpoint: TEndpoint;
  readonly clipFrameIndex: number | null;
  readonly runwayFrameIndex: number | null;
  readonly pendingFollowOn: TEndpoint | null;
  readonly pendingRequestCount: number;
}

export interface ReversibleClipTickOptions<TEndpoint extends string> {
  /** The endpoint whose authored portal is eligible on this content tick. */
  readonly portalEndpoint?: TEndpoint;
}

export interface ReversibleClipTraceRecord<TEndpoint extends string> {
  readonly tick: number;
  readonly portalEndpoint: TEndpoint | null;
  readonly requests: readonly ReversibleClipRequestTrace<TEndpoint>[];
  readonly before: ReversibleClipSnapshot<TEndpoint>;
  readonly presentation: ReversibleClipPresentation<TEndpoint>;
  readonly emittedFollowOn: ReversibleClipFollowOn<TEndpoint> | null;
  readonly snapshot: ReversibleClipSnapshot<TEndpoint>;
}

type ControllerState<TEndpoint extends string> =
  | {
      phase: "stable";
      endpoint: TEndpoint;
    }
  | {
      phase: "waiting";
      fromEndpoint: TEndpoint;
      toEndpoint: TEndpoint;
      direction: ReversibleClipDirection;
    }
  | {
      phase: "clip";
      direction: ReversibleClipDirection;
      frameIndex: number;
    }
  | {
      phase: "runway";
      endpoint: TEndpoint;
      direction: ReversibleClipDirection;
      frameIndex: number;
    };

/**
 * A clock-free state machine for one resident, reversible source/target clip.
 * Requests only become observable from tick(), so a caller can issue arbitrary
 * input between content ticks without causing a mid-frame direction change.
 */
export class ReversibleClipController<TEndpoint extends string = string> {
  readonly #sourceEndpoint: TEndpoint;
  readonly #targetEndpoint: TEndpoint;
  readonly #clipFrameCount: number;
  readonly #sourceRunwayFrameCount: number;
  readonly #targetRunwayFrameCount: number;
  readonly #canFollow: (
    prospectiveEndpoint: TEndpoint,
    destination: TEndpoint
  ) => boolean;
  readonly #traceCapacity: number;
  readonly #requestCapacity: number;

  #state: ControllerState<TEndpoint>;
  #visualEndpoint: TEndpoint;
  #requestedEndpoint: TEndpoint;
  #pendingFollowOn: ReversibleClipFollowOn<TEndpoint> | null = null;
  #queuedRequests: ReversibleClipRequest<TEndpoint>[] = [];
  #trace: ReversibleClipTraceRecord<TEndpoint>[] = [];
  #requestSequence = 0;
  #tick = 0;

  public constructor(options: ReversibleClipControllerOptions<TEndpoint>) {
    if (options.sourceEndpoint === options.targetEndpoint) {
      throw new RangeError("sourceEndpoint and targetEndpoint must differ");
    }
    const initialEndpoint = options.initialEndpoint ?? options.sourceEndpoint;
    if (
      initialEndpoint !== options.sourceEndpoint &&
      initialEndpoint !== options.targetEndpoint
    ) {
      throw new RangeError("initialEndpoint must be sourceEndpoint or targetEndpoint");
    }
    assertPositiveSafeInteger(options.clipFrameCount, "clipFrameCount");
    assertPositiveSafeInteger(
      options.sourceRunwayFrameCount,
      "sourceRunwayFrameCount"
    );
    assertPositiveSafeInteger(
      options.targetRunwayFrameCount,
      "targetRunwayFrameCount"
    );

    this.#sourceEndpoint = options.sourceEndpoint;
    this.#targetEndpoint = options.targetEndpoint;
    this.#clipFrameCount = options.clipFrameCount;
    this.#sourceRunwayFrameCount = options.sourceRunwayFrameCount;
    this.#targetRunwayFrameCount = options.targetRunwayFrameCount;
    this.#canFollow = options.canFollow ?? (() => false);
    this.#traceCapacity = assertPositiveSafeInteger(
      options.traceCapacity ?? 256,
      "traceCapacity"
    );
    this.#requestCapacity = assertPositiveSafeInteger(
      options.requestCapacity ?? 32,
      "requestCapacity"
    );
    this.#state = { phase: "stable", endpoint: initialEndpoint };
    this.#visualEndpoint = initialEndpoint;
    this.#requestedEndpoint = initialEndpoint;
  }

  /** Queue an intent for the next content tick and return its stable sequence. */
  public request(destination: TEndpoint): number {
    const sequence = ++this.#requestSequence;
    const request = Object.freeze({ sequence, destination });
    if (this.#queuedRequests.length === this.#requestCapacity) {
      // Preserve the earlier ordering evidence while coalescing the newest
      // burst to its latest intent. Interactive input must remain bounded.
      this.#queuedRequests[this.#queuedRequests.length - 1] = request;
    } else {
      this.#queuedRequests.push(request);
    }
    return sequence;
  }

  /** Advance exactly one content tick. */
  public tick(
    options: ReversibleClipTickOptions<TEndpoint> = {}
  ): ReversibleClipTraceRecord<TEndpoint> {
    const before = this.snapshot();
    const requests = this.#consumeRequests();
    const portalEndpoint = options.portalEndpoint ?? null;
    const { presentation, emittedFollowOn } = this.#advance(portalEndpoint);
    this.#tick += 1;
    const snapshot = this.snapshot();
    const record = Object.freeze({
      tick: this.#tick,
      portalEndpoint,
      requests,
      before,
      presentation,
      emittedFollowOn,
      snapshot
    });
    this.#trace.push(record);
    if (this.#trace.length > this.#traceCapacity) {
      this.#trace.splice(0, this.#trace.length - this.#traceCapacity);
    }
    return record;
  }

  /** Return an immutable point-in-time diagnostic snapshot. */
  public snapshot(): ReversibleClipSnapshot<TEndpoint> {
    const state = this.#state;
    let direction: ReversibleClipDirection | null = null;
    let prospectiveEndpoint: TEndpoint;
    let clipFrameIndex: number | null = null;
    let runwayFrameIndex: number | null = null;

    switch (state.phase) {
      case "stable":
        prospectiveEndpoint = state.endpoint;
        break;
      case "waiting":
        direction = state.direction;
        prospectiveEndpoint = state.toEndpoint;
        break;
      case "clip":
        direction = state.direction;
        prospectiveEndpoint = this.#endpointForDirection(state.direction);
        clipFrameIndex = state.frameIndex;
        break;
      case "runway":
        direction = state.direction;
        prospectiveEndpoint = state.endpoint;
        runwayFrameIndex = state.frameIndex;
        break;
    }

    return Object.freeze({
      tick: this.#tick,
      phase: state.phase,
      direction,
      inTransition: state.phase !== "stable",
      requestedEndpoint: this.#requestedEndpoint,
      visualEndpoint: this.#visualEndpoint,
      prospectiveEndpoint,
      clipFrameIndex,
      runwayFrameIndex,
      pendingFollowOn: this.#pendingFollowOn?.destination ?? null,
      pendingRequestCount: this.#queuedRequests.length
    });
  }

  /** Return a frozen copy; callers can neither append nor mutate its records. */
  public getTrace(): readonly ReversibleClipTraceRecord<TEndpoint>[] {
    return Object.freeze([...this.#trace]);
  }

  #consumeRequests(): readonly ReversibleClipRequestTrace<TEndpoint>[] {
    const queued = this.#queuedRequests;
    this.#queuedRequests = [];
    const traces = queued.map((request) =>
      Object.freeze({ ...request, outcome: this.#applyRequest(request) })
    );
    return Object.freeze(traces);
  }

  #applyRequest(
    request: ReversibleClipRequest<TEndpoint>
  ): ReversibleClipRequestOutcome {
    const destination = request.destination;
    const state = this.#state;

    switch (state.phase) {
      case "stable":
        if (destination === state.endpoint) {
          this.#acceptDirectRequest(destination);
          return "continue";
        }
        if (destination === this.#otherEndpoint(state.endpoint)) {
          this.#acceptDirectRequest(destination);
          this.#state = {
            phase: "waiting",
            fromEndpoint: state.endpoint,
            toEndpoint: destination,
            direction: this.#directionForEndpoint(destination)
          };
          return "begin";
        }
        return "ignored";

      case "waiting":
        if (destination === state.toEndpoint) {
          this.#acceptDirectRequest(destination);
          return "continue";
        }
        if (destination === state.fromEndpoint) {
          this.#acceptDirectRequest(destination);
          this.#state = { phase: "stable", endpoint: state.fromEndpoint };
          return "cancel";
        }
        return "ignored";

      case "clip": {
        const prospectiveEndpoint = this.#endpointForDirection(state.direction);
        if (destination === prospectiveEndpoint) {
          this.#acceptDirectRequest(destination);
          return "continue";
        }
        if (destination === this.#otherEndpoint(prospectiveEndpoint)) {
          this.#acceptDirectRequest(destination);
          this.#state = {
            ...state,
            direction: state.direction === "forward" ? "reverse" : "forward"
          };
          return "reverse";
        }
        if (this.#canFollow(prospectiveEndpoint, destination)) {
          this.#requestedEndpoint = destination;
          this.#pendingFollowOn = Object.freeze({
            sequence: request.sequence,
            fromEndpoint: prospectiveEndpoint,
            destination
          });
          return "follow-on";
        }
        return "ignored";
      }

      case "runway":
        if (destination === state.endpoint) {
          this.#acceptDirectRequest(destination);
          return "continue";
        }
        if (destination === this.#otherEndpoint(state.endpoint)) {
          this.#acceptDirectRequest(destination);
          this.#state = {
            phase: "waiting",
            fromEndpoint: state.endpoint,
            toEndpoint: destination,
            direction: this.#directionForEndpoint(destination)
          };
          return "begin";
        }
        return "ignored";
    }
  }

  #acceptDirectRequest(destination: TEndpoint): void {
    this.#requestedEndpoint = destination;
    this.#pendingFollowOn = null;
  }

  #advance(portalEndpoint: TEndpoint | null): {
    presentation: ReversibleClipPresentation<TEndpoint>;
    emittedFollowOn: ReversibleClipFollowOn<TEndpoint> | null;
  } {
    const state = this.#state;

    switch (state.phase) {
      case "stable":
        return {
          presentation: freezePresentation({
            kind: "stable",
            endpoint: state.endpoint
          }),
          emittedFollowOn: null
        };

      case "waiting":
        if (portalEndpoint !== state.fromEndpoint) {
          return {
            presentation: freezePresentation({
              kind: "stable",
              endpoint: this.#visualEndpoint
            }),
            emittedFollowOn: null
          };
        }
        return this.#presentClipEdge(state.direction);

      case "clip":
        return this.#advanceClip(state);

      case "runway":
        return this.#advanceRunway(state);
    }
  }

  #presentClipEdge(direction: ReversibleClipDirection): {
    presentation: ReversibleClipPresentation<TEndpoint>;
    emittedFollowOn: null;
  } {
    const frameIndex = direction === "forward" ? 0 : this.#clipFrameCount - 1;
    this.#state = { phase: "clip", direction, frameIndex };
    return {
      presentation: freezePresentation({ kind: "clip", frameIndex, direction }),
      emittedFollowOn: null
    };
  }

  #advanceClip(state: Extract<ControllerState<TEndpoint>, { phase: "clip" }>): {
    presentation: ReversibleClipPresentation<TEndpoint>;
    emittedFollowOn: ReversibleClipFollowOn<TEndpoint> | null;
  } {
    const nextFrame =
      state.direction === "forward"
        ? state.frameIndex + 1
        : state.frameIndex - 1;

    if (nextFrame >= 0 && nextFrame < this.#clipFrameCount) {
      this.#state = { ...state, frameIndex: nextFrame };
      return {
        presentation: freezePresentation({
          kind: "clip",
          frameIndex: nextFrame,
          direction: state.direction
        }),
        emittedFollowOn: null
      };
    }

    return this.#commitRunway(this.#endpointForDirection(state.direction));
  }

  #commitRunway(endpoint: TEndpoint): {
    presentation: ReversibleClipPresentation<TEndpoint>;
    emittedFollowOn: ReversibleClipFollowOn<TEndpoint> | null;
  } {
    const direction = this.#directionForEndpoint(endpoint);
    this.#state = { phase: "runway", endpoint, direction, frameIndex: 0 };
    this.#visualEndpoint = endpoint;
    const emittedFollowOn = this.#pendingFollowOn;
    this.#pendingFollowOn = null;
    return {
      presentation: freezePresentation({
        kind: "runway",
        endpoint,
        frameIndex: 0,
        direction
      }),
      emittedFollowOn
    };
  }

  #advanceRunway(
    state: Extract<ControllerState<TEndpoint>, { phase: "runway" }>
  ): {
    presentation: ReversibleClipPresentation<TEndpoint>;
    emittedFollowOn: null;
  } {
    const frameCount =
      state.endpoint === this.#sourceEndpoint
        ? this.#sourceRunwayFrameCount
        : this.#targetRunwayFrameCount;
    const nextFrame = state.frameIndex + 1;

    if (nextFrame < frameCount) {
      this.#state = { ...state, frameIndex: nextFrame };
      return {
        presentation: freezePresentation({
          kind: "runway",
          endpoint: state.endpoint,
          frameIndex: nextFrame,
          direction: state.direction
        }),
        emittedFollowOn: null
      };
    }

    this.#state = { phase: "stable", endpoint: state.endpoint };
    return {
      presentation: freezePresentation({
        kind: "stable",
        endpoint: state.endpoint
      }),
      emittedFollowOn: null
    };
  }

  #endpointForDirection(direction: ReversibleClipDirection): TEndpoint {
    return direction === "forward" ? this.#targetEndpoint : this.#sourceEndpoint;
  }

  #directionForEndpoint(endpoint: TEndpoint): ReversibleClipDirection {
    return endpoint === this.#targetEndpoint ? "forward" : "reverse";
  }

  #otherEndpoint(endpoint: TEndpoint): TEndpoint {
    return endpoint === this.#sourceEndpoint
      ? this.#targetEndpoint
      : this.#sourceEndpoint;
  }
}

function freezePresentation<TEndpoint extends string>(
  presentation: ReversibleClipPresentation<TEndpoint>
): ReversibleClipPresentation<TEndpoint> {
  return Object.freeze(presentation);
}

function assertPositiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}
