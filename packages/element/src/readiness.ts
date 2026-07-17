import type {
  Blob,
  Edge,
  Manifest,
  Unit
} from "./asset.js";

type Body = Extract<Unit, { readonly kind: "body" }>;

export interface ReadinessRoute {
  readonly edge: string;
  readonly kind: "cut" | "reversible" | "stream";
  readonly transitionUnit: string | null;
  readonly targetUnit: string;
  readonly targetFrames: readonly number[];
  readonly continuationFrame: number;
}

export interface ReadinessEndpoint {
  readonly reversibleUnit: string;
  readonly state: string;
  readonly bodyUnit: string;
  readonly frames: readonly number[];
  readonly continuationFrame: number;
}

export interface ReadinessPlan {
  readonly units: readonly string[];
  readonly loops: readonly string[];
  readonly reversibleUnits: readonly string[];
  readonly resident: readonly Readonly<{
    unit: string;
    frames: readonly number[];
  }>[];
  readonly endpoints: readonly Readonly<ReadinessEndpoint>[];
  readonly routes: readonly Readonly<ReadinessRoute>[];
  readonly decodedFrameBytes: number;
  readonly encodedBytes: number;
  readonly semanticPersistentBytes: number;
  readonly uniquePersistentBytes: number;
  readonly declaredWorkingSetBytes: number;
}

const RING = 12;

/** Expand the complete format-1.0 all-routes set for one selected rendition. */
export function createReadinessPlan(
  manifest: Readonly<Manifest>,
  renditionId: string,
  blobs: readonly Readonly<Blob>[]
): Readonly<ReadinessPlan> {
  const rendition = manifest.renditions.find(({ id }) => id === renditionId);
  if (rendition === undefined) throw invalid();
  const units = new Map(manifest.units.map((unit) => [unit.id, unit]));
  const states = new Map(manifest.states.map((state) => [state.id, state]));
  const resident = new Map<string, Set<number>>();
  const keep = (unit: string, frames: readonly number[]): void => {
    const set = resident.get(unit) ?? new Set<number>();
    for (const frame of frames) set.add(frame);
    resident.set(unit, set);
  };

  const reversibleUnits = orderUnits(manifest)
    .filter((id) => units.get(id)?.kind === "reversible");
  const endpoints: ReadinessEndpoint[] = [];
  let semanticFrames = 0;
  for (const id of reversibleUnits) {
    const unit = units.get(id)! as Extract<Unit, { readonly kind: "reversible" }>;
    const clip = indices(unit.frameCount);
    keep(id, clip);
    semanticFrames = add(semanticFrames, unit.frameCount);
    for (const endpoint of unit.residency.endpoints) {
      const state = states.get(endpoint.state);
      const body = units.get(state?.bodyUnit ?? "");
      if (state === undefined || body?.kind !== "body") throw invalid();
      const port = body.ports.find(({ id: portId }) => portId === endpoint.port);
      if (port === undefined) throw invalid();
      const frames = runway(body, port.entryFrame, endpoint.frames);
      keep(body.id, frames);
      semanticFrames = add(semanticFrames, endpoint.frames);
      endpoints.push({
        reversibleUnit: id,
        state: state.id,
        bodyUnit: body.id,
        frames,
        continuationFrame: bodyFrame(body, port.entryFrame + endpoint.frames)
      });
    }
  }

  const routes: ReadinessRoute[] = [];
  for (const edge of orderEdges(manifest)) {
    const state = states.get(edge.to);
    const body = units.get(state?.bodyUnit ?? "");
    if (state === undefined || body?.kind !== "body") throw invalid();
    const port = body.ports.find(({ id }) => id === edge.start.targetPort);
    if (port === undefined) throw invalid();
    let kind: ReadinessRoute["kind"];
    let count: number;
    if (edge.start.type === "cut") {
      kind = "cut";
      if (edge.targetRunwayFrames === undefined) throw invalid();
      count = edge.targetRunwayFrames;
    } else if (edge.transition?.kind === "reversible") {
      kind = "reversible";
      count = endpointFrames(edge, endpoints);
    } else {
      kind = "stream";
      count = RING;
    }
    const targetFrames = runway(body, port.entryFrame, count);
    if (edge.start.type === "cut") {
      keep(body.id, targetFrames);
      semanticFrames = add(semanticFrames, count);
    }
    routes.push({
      edge: edge.id,
      kind,
      transitionUnit: edge.transition?.unit ?? null,
      targetUnit: body.id,
      targetFrames,
      continuationFrame: bodyFrame(body, port.entryFrame + count)
    });
  }

  const decodedFrameBytes = product(rendition.codedWidth, rendition.codedHeight, 4);
  const maximumDecodedFrameBytes = Math.max(...manifest.renditions.map(({ codedWidth, codedHeight }) =>
    product(codedWidth, codedHeight, 4)));
  const encodedByRendition = new Map<string, number>();
  for (const blob of blobs) encodedByRendition.set(
    blob.rendition,
    add(encodedByRendition.get(blob.rendition) ?? 0, blob.length)
  );
  const selectedBlobs = blobs.filter(({ rendition: id }) => id === renditionId);
  const encodedBytes = encodedByRendition.get(renditionId) ?? 0;
  if (selectedBlobs.length !== manifest.units.length) {
    throw invalid();
  }
  const semanticPersistentBytes = product(semanticFrames, maximumDecodedFrameBytes);
  const uniqueFrames = [...resident.values()].reduce((sum, frames) =>
    add(sum, frames.size), 0);
  const uniquePersistentBytes = product(uniqueFrames, decodedFrameBytes);
  const declaredWorkingSetBytes = [
    semanticPersistentBytes,
    product(RING, maximumDecodedFrameBytes),
    Math.max(0, ...encodedByRendition.values()),
    product(manifest.canvas.width, manifest.canvas.height, 4)
  ].reduce(add, 0);
  if (
    manifest.limits.decodedPixelBytes < maximumDecodedFrameBytes ||
    manifest.limits.persistentCacheBytes < semanticPersistentBytes ||
    manifest.limits.runtimeWorkingSetBytes < declaredWorkingSetBytes
  ) throw new RangeError("AVAL resource declarations are insufficient");

  return {
    units: orderUnits(manifest),
    loops: orderUnits(manifest).filter((id) => {
      const unit = units.get(id);
      return unit?.kind === "body" && unit.playback === "loop";
    }),
    reversibleUnits,
    resident: manifest.units.flatMap(({ id }) => {
      const frames = resident.get(id);
      return frames === undefined ? [] : [{ unit: id, frames: [...frames].sort(numberOrder) }];
    }),
    endpoints,
    routes,
    decodedFrameBytes,
    encodedBytes,
    semanticPersistentBytes,
    uniquePersistentBytes,
    declaredWorkingSetBytes
  };
}

function endpointFrames(
  edge: Readonly<Edge>,
  endpoints: readonly Readonly<ReadinessEndpoint>[]
): number {
  const transition = edge.transition;
  if (transition?.kind !== "reversible") throw invalid();
  const endpoint = endpoints.find(({ reversibleUnit, state }) =>
    reversibleUnit === transition.unit && state === edge.to);
  if (endpoint === undefined) throw invalid();
  return endpoint.frames.length;
}

function runway(body: Body, start: number, count: number): number[] {
  return Array.from({ length: count }, (_, offset) => bodyFrame(body, start + offset));
}

function bodyFrame(body: Body, ordinal: number): number {
  return body.playback === "loop"
    ? ordinal % body.frameCount
    : Math.min(ordinal, body.frameCount - 1);
}

function indices(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}

function orderUnits(manifest: Readonly<Manifest>): string[] {
  return hinted(manifest.readiness.bootstrapUnits, manifest.units.map(({ id }) => id));
}

function orderEdges(manifest: Readonly<Manifest>): Edge[] {
  const byId = new Map(manifest.edges.map((edge) => [edge.id, edge]));
  return hinted(manifest.readiness.immediateEdges, manifest.edges.map(({ id }) => id))
    .map((id) => byId.get(id) ?? invalid());
}

function hinted(hints: readonly string[], all: readonly string[]): string[] {
  const seen = new Set(hints);
  return [...hints, ...all.filter((id) => !seen.has(id))];
}

function numberOrder(left: number, right: number): number { return left - right; }

function add(left: number, right: number): number {
  const value = left + right;
  if (!Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}

function product(...values: number[]): number {
  let result = 1;
  for (const value of values) {
    if (
      !Number.isSafeInteger(value) || value < 0 ||
      value !== 0 && result > Math.floor(Number.MAX_SAFE_INTEGER / value)
    ) throw invalid();
    result *= value;
  }
  return result;
}

function invalid(): never { throw new RangeError("Invalid AVAL readiness plan"); }
