import type {
  CompiledManifest,
  Edge,
  ProductionRendition,
  Unit
} from "@pixel-point/aval-format";

import type { RuntimeFrameKey } from "./model.js";
import { manifestBodyFrameAt } from "./body-frame-semantics.js";
import {
  checkedByteNumber,
  checkedRgbaBytes,
  roundedGpuAllocationBytes,
  validatePositiveSafeInteger
} from "./checked-runtime-bytes.js";

export const MIN_REVERSIBLE_CLIP_FRAMES = 1;
const MAX_REVERSIBLE_CLIP_FRAMES = 0xffff_ffff;
export const MIN_ENDPOINT_RUNWAY_FRAMES = 6;
export const MAX_ENDPOINT_RUNWAY_FRAMES = 12;

export interface InteractionCacheDeviceLimits {
  readonly maxArrayTextureLayers: number;
  readonly maxTextureSize: number;
}

export interface InteractionCachePlanInput {
  readonly manifest: CompiledManifest;
  readonly rendition: string;
  readonly deviceLimits: Readonly<InteractionCacheDeviceLimits>;
}

interface SemanticEndpointRunwayInput {
  readonly state: string;
  readonly port: string;
  readonly frames: readonly RuntimeFrameKey[];
}

interface SemanticReversibleClipInput {
  readonly unit: string;
  readonly sourceEndpoint: Readonly<SemanticEndpointRunwayInput>;
  readonly clip: readonly RuntimeFrameKey[];
  readonly targetEndpoint: Readonly<SemanticEndpointRunwayInput>;
}

interface SemanticCutRunwayInput {
  readonly edge: string;
  readonly state: string;
  readonly port: string;
  readonly frames: readonly RuntimeFrameKey[];
}

interface InteractionCacheSemanticInput {
  readonly rendition: string;
  readonly width: number;
  readonly height: number;
  readonly reversibleClips: readonly SemanticReversibleClipInput[];
  readonly cutRunways: readonly SemanticCutRunwayInput[];
  readonly deviceLimits: Readonly<InteractionCacheDeviceLimits>;
}

export interface InteractionCacheLayer {
  readonly key: Readonly<RuntimeFrameKey>;
  readonly layer: number;
}

export interface InteractionCacheSequence {
  readonly frames: readonly Readonly<RuntimeFrameKey>[];
  readonly layers: readonly number[];
}

export interface InteractionCacheEndpointRunway
  extends InteractionCacheSequence {
  readonly state: string;
  readonly port: string;
}

export interface InteractionCacheReversibleClip {
  readonly unit: string;
  readonly sourceEndpoint: Readonly<InteractionCacheEndpointRunway>;
  readonly clip: Readonly<InteractionCacheSequence>;
  readonly targetEndpoint: Readonly<InteractionCacheEndpointRunway>;
  readonly clipBytes: number;
  readonly endpointPairBytes: number;
}

export interface InteractionCacheCutRunway extends InteractionCacheSequence {
  readonly edge: string;
  readonly state: string;
  readonly port: string;
}

export interface InteractionCachePlan {
  readonly rendition: string;
  readonly width: number;
  readonly height: number;
  readonly bytesPerFrame: number;
  readonly layerCount: number;
  readonly semanticFrameCount: number;
  readonly persistentBytes: number;
  readonly persistentAllocationBytes: number;
  readonly uniqueFrames: readonly Readonly<InteractionCacheLayer>[];
  readonly reversibleClips: readonly Readonly<InteractionCacheReversibleClip>[];
  readonly cutRunways: readonly Readonly<InteractionCacheCutRunway>[];
  layerFor(key: RuntimeFrameKey): number | undefined;
}

/** Expand the validated manifest's complete M5.5 resident interaction set. */
export function createInteractionCachePlan(
  input: InteractionCachePlanInput
): Readonly<InteractionCachePlan> {
  validateObject(input, "interaction cache plan input");
  validateObject(input.manifest, "interaction cache manifest");
  const rendition = requireProductionVideoRendition(
    input.manifest.renditions,
    input.rendition
  );

  const units = new Map(input.manifest.units.map((unit) => [unit.id, unit]));
  const states = new Map(input.manifest.states.map((state) => [state.id, state]));
  const reversibleClips = input.manifest.units
    .filter((unit): unit is Extract<Unit, { readonly kind: "reversible" }> =>
      unit.kind === "reversible"
    )
    .map((unit) => {
      const primary = requirePrimaryReversibleEdge(input.manifest.edges, unit.id);
      const sourceEndpoint = requireEndpoint(unit, primary.from);
      const targetEndpoint = requireEndpoint(unit, primary.to);
      return {
        unit: unit.id,
        sourceEndpoint: expandEndpointRunway({
          endpoint: sourceEndpoint,
          rendition: rendition.id,
          units,
          states
        }),
        clip: frameKeys(rendition.id, unit.id, unit.frameCount),
        targetEndpoint: expandEndpointRunway({
          endpoint: targetEndpoint,
          rendition: rendition.id,
          units,
          states
        })
      };
    });
  const cutRunways = input.manifest.edges
    .filter((edge): edge is Extract<Edge, { readonly continuity: "cut" }> =>
      edge.start.type === "cut"
    )
    .map((edge) => {
      const state = states.get(edge.to);
      if (state === undefined) {
        throw new RangeError(`cut edge ${edge.id} has no target state`);
      }
      const body = units.get(state.bodyUnit);
      if (body?.kind !== "body") {
        throw new RangeError(`cut edge ${edge.id} has no target body`);
      }
      const port = body.ports.find(({ id }) => id === edge.start.targetPort);
      if (port === undefined) {
        throw new RangeError(`cut edge ${edge.id} has no target port`);
      }
      return {
        edge: edge.id,
        state: state.id,
        port: port.id,
        frames: expandBodyRunway(
          rendition.id,
          body,
          port.entryFrame,
          edge.targetRunwayFrames
        )
      };
    });

  return assembleInteractionCachePlan({
    rendition: rendition.id,
    width: rendition.codedWidth,
    height: rendition.codedHeight,
    reversibleClips,
    cutRunways,
    deviceLimits: input.deviceLimits
  });
}

function requireProductionVideoRendition(
  renditions: readonly ProductionRendition[],
  id: string
): Readonly<ProductionRendition> {
  const selected = renditions.find((candidate) => candidate.id === id);
  if (selected === undefined) {
    throw new RangeError("selected production video rendition is unavailable");
  }
  return selected;
}

function assembleInteractionCachePlan(
  input: InteractionCacheSemanticInput
): Readonly<InteractionCachePlan> {
  validateObject(input, "interaction cache semantic input");
  validateIdentifier(input.rendition, "interaction cache rendition");
  validatePositiveSafeInteger(input.width, "interaction cache width");
  validatePositiveSafeInteger(input.height, "interaction cache height");
  validateDeviceLimits(input.deviceLimits);
  if (input.width > input.deviceLimits.maxTextureSize) {
    throw new RangeError("interaction cache width exceeds MAX_TEXTURE_SIZE");
  }
  if (input.height > input.deviceLimits.maxTextureSize) {
    throw new RangeError("interaction cache height exceeds MAX_TEXTURE_SIZE");
  }
  if (!Array.isArray(input.reversibleClips)) {
    throw new TypeError("reversible clips must be an array");
  }
  if (!Array.isArray(input.cutRunways)) {
    throw new TypeError("cut runways must be an array");
  }

  const frameBytes = checkedRgbaBytes(
    input.width,
    input.height,
    1,
    "interaction cache frame bytes"
  );
  const layerByIdentity = new Map<string, number>();
  const uniqueFrames: InteractionCacheLayer[] = [];
  let semanticFrameCount = 0;

  const registerSequence = (
    sequence: readonly RuntimeFrameKey[],
    label: string
  ): Readonly<InteractionCacheSequence> => {
    if (!Array.isArray(sequence)) throw new TypeError(`${label} must be an array`);
    const frames: Readonly<RuntimeFrameKey>[] = [];
    const layers: number[] = [];
    for (let index = 0; index < sequence.length; index += 1) {
      const key = cloneFrameKey(sequence[index], `${label} frame ${String(index)}`);
      if (key.rendition !== input.rendition) {
        throw new RangeError(`${label} frame rendition does not match the plan`);
      }
      const identity = identityFor(key);
      let layer = layerByIdentity.get(identity);
      if (layer === undefined) {
        layer = uniqueFrames.length;
        layerByIdentity.set(identity, layer);
        uniqueFrames.push(Object.freeze({ key, layer }));
      }
      frames.push(key);
      layers.push(layer);
    }
    const nextSemanticFrameCount = semanticFrameCount + sequence.length;
    if (!Number.isSafeInteger(nextSemanticFrameCount)) {
      throw new RangeError("interaction cache semantic frame count exceeds safe integer range");
    }
    semanticFrameCount = nextSemanticFrameCount;
    return Object.freeze({
      frames: Object.freeze(frames),
      layers: Object.freeze(layers)
    });
  };

  const reversibleClips = [...input.reversibleClips]
    .sort((left, right) => compareAscii(left.unit, right.unit))
    .map((candidate, index) => {
      const label = `reversible clip ${candidate?.unit ?? String(index)}`;
      validateObject(candidate, label);
      validateIdentifier(candidate.unit, `${label} unit`);
      validateObject(candidate.sourceEndpoint, `${label} source endpoint`);
      validateObject(candidate.targetEndpoint, `${label} target endpoint`);
      validateSequenceLength(
        candidate.sourceEndpoint.frames,
        `${label} source endpoint runway`,
        MIN_ENDPOINT_RUNWAY_FRAMES,
        MAX_ENDPOINT_RUNWAY_FRAMES
      );
      validateSequenceLength(
        candidate.clip,
        label,
        MIN_REVERSIBLE_CLIP_FRAMES,
        MAX_REVERSIBLE_CLIP_FRAMES
      );
      validateSequenceLength(
        candidate.targetEndpoint.frames,
        `${label} target endpoint runway`,
        MIN_ENDPOINT_RUNWAY_FRAMES,
        MAX_ENDPOINT_RUNWAY_FRAMES
      );
      validateIdentifier(candidate.sourceEndpoint.state, `${label} source state`);
      validateIdentifier(candidate.sourceEndpoint.port, `${label} source port`);
      validateIdentifier(candidate.targetEndpoint.state, `${label} target state`);
      validateIdentifier(candidate.targetEndpoint.port, `${label} target port`);

      const source = registerSequence(
        candidate.sourceEndpoint.frames,
        `${label} source endpoint runway`
      );
      const clip = registerSequence(candidate.clip, label);
      const target = registerSequence(
        candidate.targetEndpoint.frames,
        `${label} target endpoint runway`
      );
      const clipBytes = frameBytes * BigInt(new Set(clip.layers).size);
      const endpointLayers = new Set([
        ...source.layers,
        ...target.layers
      ]);
      const endpointPairBytes = frameBytes * BigInt(endpointLayers.size);
      return Object.freeze({
        unit: candidate.unit,
        sourceEndpoint: Object.freeze({
          state: candidate.sourceEndpoint.state,
          port: candidate.sourceEndpoint.port,
          ...source
        }),
        clip,
        targetEndpoint: Object.freeze({
          state: candidate.targetEndpoint.state,
          port: candidate.targetEndpoint.port,
          ...target
        }),
        clipBytes: checkedByteNumber(clipBytes, "reversible clip bytes"),
        endpointPairBytes: checkedByteNumber(
          endpointPairBytes,
          "reversible endpoint pair bytes"
        )
      });
    });

  const cutRunways = [...input.cutRunways]
    .sort((left, right) => compareAscii(left.edge, right.edge))
    .map((candidate, index) => {
      const label = `cut runway ${candidate?.edge ?? String(index)}`;
      validateObject(candidate, label);
      validateIdentifier(candidate.edge, `${label} edge`);
      validateIdentifier(candidate.state, `${label} state`);
      validateIdentifier(candidate.port, `${label} port`);
      validateSequenceLength(
        candidate.frames,
        label,
        MIN_ENDPOINT_RUNWAY_FRAMES,
        MAX_ENDPOINT_RUNWAY_FRAMES
      );
      return Object.freeze({
        edge: candidate.edge,
        state: candidate.state,
        port: candidate.port,
        ...registerSequence(candidate.frames, label)
      });
    });

  const layerCount = uniqueFrames.length;
  const layerLimit = input.deviceLimits.maxArrayTextureLayers;
  if (layerCount > layerLimit) {
    throw new RangeError(
      `interaction cache layer count ${String(layerCount)} exceeds layer limit ${String(layerLimit)}`
    );
  }
  const persistentBytes = frameBytes * BigInt(layerCount);
  const frozenFrames = Object.freeze(uniqueFrames);
  return Object.freeze({
    rendition: input.rendition,
    width: input.width,
    height: input.height,
    bytesPerFrame: checkedByteNumber(frameBytes, "interaction cache frame bytes"),
    layerCount,
    semanticFrameCount,
    persistentBytes: checkedByteNumber(persistentBytes, "persistent cache bytes"),
    persistentAllocationBytes: checkedByteNumber(
      roundedGpuAllocationBytes(persistentBytes),
      "persistent cache allocation bytes"
    ),
    uniqueFrames: frozenFrames,
    reversibleClips: Object.freeze(reversibleClips),
    cutRunways: Object.freeze(cutRunways),
    layerFor(key: RuntimeFrameKey) {
      return isFrameKey(key) ? layerByIdentity.get(identityFor(key)) : undefined;
    }
  });
}

function expandEndpointRunway(input: {
  readonly endpoint: { readonly state: string; readonly port: string; readonly frames: number };
  readonly rendition: string;
  readonly units: ReadonlyMap<string, Unit>;
  readonly states: ReadonlyMap<string, CompiledManifest["states"][number]>;
}): SemanticEndpointRunwayInput {
  const state = input.states.get(input.endpoint.state);
  if (state === undefined) {
    throw new RangeError(`reversible endpoint ${input.endpoint.state} has no state`);
  }
  const body = input.units.get(state.bodyUnit);
  if (body?.kind !== "body") {
    throw new RangeError(`reversible endpoint ${state.id} has no body`);
  }
  const port = body.ports.find(({ id }) => id === input.endpoint.port);
  if (port === undefined) {
    throw new RangeError(`reversible endpoint ${state.id} has no port`);
  }
  return {
    state: state.id,
    port: port.id,
    frames: expandBodyRunway(
      input.rendition,
      body,
      port.entryFrame,
      input.endpoint.frames
    )
  };
}

function expandBodyRunway(
  rendition: string,
  body: Extract<Unit, { readonly kind: "body" }>,
  entryFrame: number,
  length: number
): readonly RuntimeFrameKey[] {
  return Object.freeze(Array.from({ length }, (_, offset) => ({
    rendition,
    unit: body.id,
    localFrame: manifestBodyFrameAt(body, entryFrame + offset)
  })));
}

function frameKeys(
  rendition: string,
  unit: string,
  frameCount: number
): readonly RuntimeFrameKey[] {
  return Object.freeze(Array.from({ length: frameCount }, (_, localFrame) => ({
    rendition,
    unit,
    localFrame
  })));
}

function requirePrimaryReversibleEdge(
  edges: readonly Edge[],
  unit: string
): Edge & {
  readonly transition: {
    readonly kind: "reversible";
    readonly unit: string;
    readonly direction: "forward";
  };
} {
  const matches = edges.filter((edge) =>
    edge.transition?.kind === "reversible" &&
    edge.transition.unit === unit &&
    edge.transition.direction === "forward"
  );
  if (matches.length !== 1) {
    throw new RangeError(`reversible unit ${unit} needs one primary edge`);
  }
  return matches[0] as ReturnType<typeof requirePrimaryReversibleEdge>;
}

function requireEndpoint(
  unit: Extract<Unit, { readonly kind: "reversible" }>,
  state: string
): { readonly state: string; readonly port: string; readonly frames: number } {
  const endpoint = unit.residency.endpoints.find(
    (candidate) => candidate.state === state
  );
  if (endpoint === undefined) {
    throw new RangeError(`reversible unit ${unit.id} has no endpoint ${state}`);
  }
  return endpoint;
}

function validateDeviceLimits(limits: InteractionCacheDeviceLimits): void {
  validateObject(limits, "interaction cache device limits");
  validatePositiveSafeInteger(
    limits.maxArrayTextureLayers,
    "MAX_ARRAY_TEXTURE_LAYERS"
  );
  validatePositiveSafeInteger(limits.maxTextureSize, "MAX_TEXTURE_SIZE");
}

function validateSequenceLength(
  sequence: readonly RuntimeFrameKey[],
  label: string,
  minimum: number,
  maximum: number
): void {
  if (!Array.isArray(sequence)) throw new TypeError(`${label} must be an array`);
  if (sequence.length < minimum || sequence.length > maximum) {
    if (maximum === MAX_REVERSIBLE_CLIP_FRAMES) {
      throw new RangeError(
        `${label} must contain at least ${String(minimum)} frame${minimum === 1 ? "" : "s"}`
      );
    }
    throw new RangeError(
      `${label} must contain ${String(minimum)}–${String(maximum)} frames`
    );
  }
}

function cloneFrameKey(
  candidate: RuntimeFrameKey | undefined,
  label: string
): Readonly<RuntimeFrameKey> {
  if (!isFrameKey(candidate)) {
    throw new TypeError(
      `${label} must have non-empty rendition and unit strings and a non-negative safe local frame`
    );
  }
  return Object.freeze({
    rendition: candidate.rendition,
    unit: candidate.unit,
    localFrame: candidate.localFrame
  });
}

function isFrameKey(candidate: unknown): candidate is RuntimeFrameKey {
  if (candidate === null || typeof candidate !== "object") return false;
  const record = candidate as Partial<RuntimeFrameKey>;
  return typeof record.rendition === "string" &&
    record.rendition.trim().length > 0 &&
    typeof record.unit === "string" &&
    record.unit.trim().length > 0 &&
    Number.isSafeInteger(record.localFrame) &&
    (record.localFrame ?? -1) >= 0;
}

function identityFor(key: RuntimeFrameKey): string {
  return JSON.stringify([key.rendition, key.unit, key.localFrame]);
}

function validateIdentifier(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length < 1) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function validateObject(value: unknown, label: string): void {
  if (value === null || typeof value !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
}

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
