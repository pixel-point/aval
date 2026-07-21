import { readFileSync } from "node:fs";

import {
  parseFrontIndex,
  type VideoPayloadValidationChunk,
  type VideoPayloadValidationProfile
} from "../src/index.js";

export type VideoFixtureFamily = "h264" | "h265" | "vp9" | "av1";

export interface VideoPayloadFixture {
  readonly profile: VideoPayloadValidationProfile;
  readonly units: readonly (readonly VideoPayloadValidationChunk[])[];
}

export function loadVideoPayloadFixture(
  family: VideoFixtureFamily
): VideoPayloadFixture {
  const bytes = Uint8Array.from(readFileSync(new URL(
    `../../../fixtures/certification/v1/${family}.avl`,
    import.meta.url
  )));
  const front = parseFrontIndex(bytes);
  const rendition = front.manifest.renditions[0]!;
  const color = rendition.alphaLayout.colorRect;
  const visibleWidth = color[2] + color[2] % 2;
  const paneHeight = color[3] + color[3] % 2;
  const visibleHeight = rendition.alphaLayout.type === "stacked"
    ? paneHeight * 2 + 8
    : paneHeight;
  const units = front.manifest.units.map((unit) => {
    const span = unit.chunks[0]!;
    return Object.freeze(Array.from({ length: span.chunkCount }, (_, index) => {
      const record = front.records[span.chunkStart + index]!;
      return Object.freeze({
        bytes: bytes.subarray(record.byteOffset, record.byteOffset + record.byteLength),
        timestamp: record.presentationTimestamp,
        key: record.randomAccess,
        displayedFrames: record.displayedFrameCount
      });
    }));
  });
  return Object.freeze({
    profile: Object.freeze({
      codec: rendition.codec,
      bitDepth: rendition.bitDepth,
      codedWidth: rendition.codedWidth,
      codedHeight: rendition.codedHeight,
      visibleWidth,
      visibleHeight,
      frameRate: front.manifest.frameRate,
      averageBitrate: rendition.bitrate.average
    }),
    units: Object.freeze(units)
  });
}

export function replaceFirstVideoChunk(
  unit: readonly VideoPayloadValidationChunk[],
  change: Partial<VideoPayloadValidationChunk>
): readonly VideoPayloadValidationChunk[] {
  return Object.freeze([
    Object.freeze({ ...unit[0]!, ...change }),
    ...unit.slice(1)
  ]);
}
