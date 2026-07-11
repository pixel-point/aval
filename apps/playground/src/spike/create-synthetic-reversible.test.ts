import { describe, expect, it } from "vitest";

import {
  SYNTHETIC_REVERSIBLE_BODY_FRAME_COUNT,
  SYNTHETIC_REVERSIBLE_CLIP_FRAME_COUNT,
  SYNTHETIC_REVERSIBLE_FRAME_RATE,
  SYNTHETIC_REVERSIBLE_HEIGHT,
  SYNTHETIC_REVERSIBLE_RUNWAY_FRAME_COUNT,
  SYNTHETIC_REVERSIBLE_WIDTH,
  createSyntheticReversibleMetadata,
  decodeSyntheticReversibleTag,
} from "./create-synthetic-reversible";

describe("synthetic reversible fixture metadata", () => {
  it("preserves arbitrary endpoint names while keeping fixed media geometry", () => {
    const metadata = createSyntheticReversibleMetadata({
      sourceEndpoint: "rest / default 🫧",
      targetEndpoint: "engaged:pressed+",
    });

    expect(metadata.sourceEndpoint).toBe("rest / default 🫧");
    expect(metadata.targetEndpoint).toBe("engaged:pressed+");
    expect(metadata.sourceBody.endpoint).toBe("rest / default 🫧");
    expect(metadata.targetBody.endpoint).toBe("engaged:pressed+");
    expect(metadata.reversibleClip.endpoint).toBeNull();
    expect(metadata.width).toBe(SYNTHETIC_REVERSIBLE_WIDTH);
    expect(metadata.height).toBe(SYNTHETIC_REVERSIBLE_HEIGHT);
    expect(metadata.frameRate).toEqual(SYNTHETIC_REVERSIBLE_FRAME_RATE);
  });

  it("assigns disjoint readback tags to every unit and local frame", () => {
    const metadata = createSyntheticReversibleMetadata();
    const tags = metadata.frameIdentities.map((frame) => frame.tagValue);

    expect(metadata.sourceBody.frames).toHaveLength(
      SYNTHETIC_REVERSIBLE_BODY_FRAME_COUNT,
    );
    expect(metadata.reversibleClip.frames).toHaveLength(
      SYNTHETIC_REVERSIBLE_CLIP_FRAME_COUNT,
    );
    expect(metadata.targetBody.frames).toHaveLength(
      SYNTHETIC_REVERSIBLE_BODY_FRAME_COUNT,
    );
    expect(new Set(tags)).toHaveLength(tags.length);

    for (const frame of metadata.frameIdentities) {
      expect(decodeSyntheticReversibleTag(frame.tagValue)).toEqual({
        unitRole: frame.unitRole,
        localFrame: frame.localFrame,
        tagValue: frame.tagValue,
      });
      expect(frame.key).toEqual({
        rendition: "synthetic-reversible-rgba",
        unit: frame.unitRole,
        localFrame: frame.localFrame,
      });
    }
  });

  it("describes two exact eight-frame endpoint runways from body frame zero", () => {
    const metadata = createSyntheticReversibleMetadata({
      sourceEndpoint: "cold",
      targetEndpoint: "hot",
    });

    expect(metadata.sourceRunway).toMatchObject({
      endpoint: "cold",
      bodyUnitId: "source-body",
      entryFrame: 0,
      frameCount: SYNTHETIC_REVERSIBLE_RUNWAY_FRAME_COUNT,
    });
    expect(metadata.targetRunway).toMatchObject({
      endpoint: "hot",
      bodyUnitId: "target-body",
      entryFrame: 0,
      frameCount: SYNTHETIC_REVERSIBLE_RUNWAY_FRAME_COUNT,
    });
    expect(metadata.sourceRunway.frames.map((frame) => frame.localFrame)).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    expect(metadata.targetRunway.frames.map((frame) => frame.localFrame)).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7],
    );
    expect(metadata.sourceRunway.keys).toEqual(
      metadata.sourceRunway.frames.map((frame) => frame.key),
    );
    expect(metadata.targetRunway.keys).toEqual(
      metadata.targetRunway.frames.map((frame) => frame.key),
    );
  });

  it("rejects blank or identical endpoint names", () => {
    expect(() =>
      createSyntheticReversibleMetadata({ sourceEndpoint: "   " }),
    ).toThrow("Source endpoint must be a non-empty string");
    expect(() =>
      createSyntheticReversibleMetadata({
        sourceEndpoint: "same",
        targetEndpoint: "same",
      }),
    ).toThrow("Source and target endpoints must differ");
  });

  it("does not misclassify tag gaps or invalid bytes", () => {
    expect(decodeSyntheticReversibleTag(0x20)).toBeUndefined();
    expect(decodeSyntheticReversibleTag(0x6c)).toBeUndefined();
    expect(decodeSyntheticReversibleTag(-1)).toBeUndefined();
    expect(decodeSyntheticReversibleTag(256)).toBeUndefined();
  });
});
