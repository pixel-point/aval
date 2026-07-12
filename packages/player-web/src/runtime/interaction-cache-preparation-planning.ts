import type { UnitV01 } from "@rendered-motion/format";

import type { RuntimeCatalogIdIndex } from "./asset-catalog.js";
import type { InteractionCachePlan } from "./interaction-cache-plan.js";
import type { WorkerSampleFactory } from "./worker-samples.js";
import {
  checkedAdd,
  validateObject
} from "./interaction-cache-preparation-support.js";

export interface InteractionCachePreparationUnitCatalog {
  readonly units: Pick<RuntimeCatalogIdIndex<UnitV01>, "require">;
}

export interface UnitPreparation {
  readonly unitId: string;
  readonly frameCount: number;
  readonly layerByFrame: ReadonlyMap<number, number>;
  readonly firstLayer: number;
}

export interface PreparationCursor {
  readonly unitIndex: number;
  readonly unitFrame: number;
}

export interface DraftFrame {
  readonly unitId: string;
  readonly unitFrame: number;
  readonly layer: number | null;
}

interface SettledPreparationCounters {
  readonly submittedFrames: number;
  readonly decodedFrames: number;
  readonly uploadedFrames: number;
  readonly dependencyFramesClosed: number;
  readonly staleFrames: number;
  readonly releasedFrames: number;
}

export function buildPreparations(
  plan: Readonly<InteractionCachePlan>,
  catalog: InteractionCachePreparationUnitCatalog
): readonly Readonly<UnitPreparation>[] {
  validateObject(plan, "interaction cache plan");
  validateObject(catalog, "interaction cache preparation catalog");
  if (!Array.isArray(plan.uniqueFrames)) {
    throw new TypeError("interaction cache unique frames must be an array");
  }
  if (
    !Number.isSafeInteger(plan.layerCount) ||
    plan.layerCount < 0 ||
    plan.layerCount !== plan.uniqueFrames.length
  ) {
    throw new RangeError("interaction cache layer count relation is invalid");
  }

  const byUnit = new Map<string, {
    readonly layerByFrame: Map<number, number>;
    firstLayer: number;
  }>();
  const identities = new Set<string>();
  for (let index = 0; index < plan.uniqueFrames.length; index += 1) {
    const planned = plan.uniqueFrames[index];
    if (
      planned === undefined ||
      planned.layer !== index ||
      planned.key.rendition !== plan.rendition ||
      typeof planned.key.unit !== "string" ||
      planned.key.unit.length < 1 ||
      !Number.isSafeInteger(planned.key.localFrame) ||
      planned.key.localFrame < 0
    ) {
      throw new RangeError("interaction cache planned layer identity is invalid");
    }
    const identity = JSON.stringify([
      planned.key.rendition,
      planned.key.unit,
      planned.key.localFrame
    ]);
    if (identities.has(identity)) {
      throw new RangeError("interaction cache planned frame is duplicated");
    }
    identities.add(identity);
    let group = byUnit.get(planned.key.unit);
    if (group === undefined) {
      group = { layerByFrame: new Map(), firstLayer: planned.layer };
      byUnit.set(planned.key.unit, group);
    }
    group.layerByFrame.set(planned.key.localFrame, planned.layer);
    group.firstLayer = Math.min(group.firstLayer, planned.layer);
  }

  let totalFrames = 0;
  const preparations = [...byUnit.entries()].map(([unitId, group]) => {
    const unit = catalog.units.require(unitId);
    if (
      unit.id !== unitId ||
      !Number.isSafeInteger(unit.frameCount) ||
      unit.frameCount < 1
    ) {
      throw new RangeError("interaction cache unit metadata is invalid");
    }
    for (const localFrame of group.layerByFrame.keys()) {
      if (localFrame >= unit.frameCount) {
        throw new RangeError(
          `planned cache frame ${unitId}:${String(localFrame)} exceeds its unit`
        );
      }
    }
    totalFrames = checkedAdd(
      totalFrames,
      unit.frameCount,
      "interaction cache occurrence frames"
    );
    return Object.freeze({
      unitId,
      frameCount: unit.frameCount,
      layerByFrame: group.layerByFrame,
      firstLayer: group.firstLayer
    });
  }).sort((left, right) => left.firstLayer - right.firstLayer);
  void totalFrames;
  return Object.freeze(preparations);
}

export function draftFrames(
  preparations: readonly Readonly<UnitPreparation>[],
  cursor: PreparationCursor,
  maximum: number
): Readonly<{
  readonly frames: readonly Readonly<DraftFrame>[];
  readonly next: Readonly<PreparationCursor>;
}> {
  let unitIndex = cursor.unitIndex;
  let unitFrame = cursor.unitFrame;
  const frames: DraftFrame[] = [];
  while (frames.length < maximum && unitIndex < preparations.length) {
    const preparation = preparations[unitIndex];
    if (preparation === undefined) break;
    frames.push(Object.freeze({
      unitId: preparation.unitId,
      unitFrame,
      layer: preparation.layerByFrame.get(unitFrame) ?? null
    }));
    unitFrame += 1;
    if (unitFrame === preparation.frameCount) {
      unitIndex += 1;
      unitFrame = 0;
    }
  }
  if (frames.length < 1) {
    throw new RangeError("interaction cache preparation made no draft progress");
  }
  return Object.freeze({
    frames: Object.freeze(frames),
    next: Object.freeze({ unitIndex, unitFrame })
  });
}

export function validateBatch(
  batch: ReturnType<WorkerSampleFactory["createBatch"]>,
  draft: readonly Readonly<DraftFrame>[],
  generation: number
): void {
  if (
    batch.generation !== generation ||
    !Array.isArray(batch.samples) ||
    batch.samples.length !== draft.length
  ) {
    throw new RangeError("worker sample batch did not match cache preparation");
  }
  for (let index = 0; index < draft.length; index += 1) {
    const requested = draft[index];
    const sample = batch.samples[index];
    if (
      requested === undefined ||
      sample === undefined ||
      sample.unitId !== requested.unitId ||
      sample.unitFrame !== requested.unitFrame
    ) {
      throw new RangeError(
        "worker sample identity did not match cache preparation"
      );
    }
  }
}

export function validateFinalCounts(
  plan: Readonly<InteractionCachePlan>,
  preparations: readonly Readonly<UnitPreparation>[],
  counters: SettledPreparationCounters
): void {
  const occurrenceFrames = preparations.reduce(
    (total, preparation) => checkedAdd(
      total,
      preparation.frameCount,
      "interaction cache occurrence frames"
    ),
    0
  );
  if (
    counters.submittedFrames !== occurrenceFrames ||
    counters.decodedFrames !== occurrenceFrames ||
    counters.uploadedFrames !== plan.layerCount ||
    checkedAdd(
      counters.uploadedFrames,
      counters.dependencyFramesClosed,
      "settled preparation frames"
    ) !== counters.decodedFrames ||
    checkedAdd(
      counters.decodedFrames,
      counters.staleFrames,
      "released preparation frames"
    ) !== counters.releasedFrames
  ) {
    throw new RangeError("interaction cache preparation counts did not settle");
  }
}
