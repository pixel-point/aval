import type { RuntimeMediaPresentation } from "./model.js";
import type { PathSchedulerExpectedOutput } from "./path-scheduler-output.js";

export type PathSchedulerFrameMedia = Extract<
  RuntimeMediaPresentation,
  { readonly kind: "frame" }
>;

export interface PathSchedulerPresentationReservation {
  readonly media: Readonly<PathSchedulerFrameMedia>;
  readonly output: Readonly<PathSchedulerExpectedOutput> | null;
  readonly commitRoute: boolean;
}

/** Owns the scheduler's sole draw-barrier presentation reservation. */
export class PathSchedulerReservationOwner {
  #current: Readonly<PathSchedulerPresentationReservation> | null = null;

  public get current(): Readonly<PathSchedulerPresentationReservation> | null {
    return this.#current;
  }

  public reserve(
    reservation: PathSchedulerPresentationReservation
  ): void {
    this.requireEmpty();
    this.#current = Object.freeze({ ...reservation });
  }

  public consume(
    media: Readonly<PathSchedulerFrameMedia>
  ): Readonly<PathSchedulerPresentationReservation> {
    const current = this.#current;
    if (current === null || !sameSchedulerMediaIdentity(current.media, media)) {
      throw new RangeError("scheduler presentation reservation diverged");
    }
    this.#current = null;
    return current;
  }

  public discard(): void {
    this.#current = null;
  }

  public requireEmpty(): void {
    if (this.#current !== null) {
      throw new RangeError("scheduler already has a prepared presentation");
    }
  }
}

export function sameSchedulerMediaIdentity(
  left: Readonly<PathSchedulerFrameMedia>,
  right: Readonly<PathSchedulerFrameMedia>
): boolean {
  return left.graphKind === right.graphKind &&
    left.state === right.state &&
    left.edge === right.edge &&
    left.path === right.path &&
    left.frame.rendition === right.frame.rendition &&
    left.frame.unit === right.frame.unit &&
    left.frame.localFrame === right.frame.localFrame &&
    left.unitInstance === right.unitInstance &&
    left.decodeOrdinal === right.decodeOrdinal &&
    left.timestamp === right.timestamp &&
    left.intendedPresentationOrdinal === right.intendedPresentationOrdinal;
}
