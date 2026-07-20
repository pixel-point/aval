import {
  inspectH264AnnexBRendition
} from "@pixel-point/aval-format";

import {
  decodedStorageGeometry,
  freezeFrameRate,
  requireBt709Limited,
  requireGeometry,
  requireVisibleGeometry,
  type CodecAdapterInput,
  type VideoBitstreamAdapter
} from "./model.js";

export const H264_BITSTREAM_ADAPTER: VideoBitstreamAdapter = Object.freeze({
  inspect(input: Readonly<CodecAdapterInput>) {
    const geometry = decodedStorageGeometry(input.candidate);
    const inspection = inspectH264AnnexBRendition(Object.freeze({
      profile: Object.freeze({
        codedWidth: input.candidate.rendition.codedWidth,
        codedHeight: input.candidate.rendition.codedHeight,
        expectedVisibleRect: geometry.rect,
        frameRate: freezeFrameRate(input.frameRate),
        requireBt709LimitedRange: true as const
      }),
      units: Object.freeze(input.units.map((unit) => Object.freeze({
        id: unit.id,
        accessUnits: Object.freeze(unit.chunks.map((chunk) => Object.freeze({
          bytes: chunk.bytes,
          key: chunk.record.randomAccess
        })))
      })))
    }));
    requireBt709Limited(inspection.parameterSet.color, "H.264 SPS");
    requireGeometry(
      inspection.parameterSet.codedWidth,
      inspection.parameterSet.codedHeight,
      input.candidate,
      "H.264 SPS"
    );
    requireVisibleGeometry(
      inspection.parameterSet.crop.visibleWidth,
      inspection.parameterSet.crop.visibleHeight,
      geometry,
      "H.264 SPS"
    );
    return Object.freeze({
      codec: inspection.parameterSet.codec,
      bitDepth: 8 as const,
      units: Object.freeze(inspection.units.map((unit) => Object.freeze({
        id: unit.id,
        chunks: Object.freeze(unit.accessUnits.map((accessUnit) => Object.freeze({
          chunkType: accessUnit.key ? "key" as const : "delta" as const,
          displayedFrameCount: 1,
          expectedPresentationIndex: accessUnit.presentationIndex
        })))
      })))
    });
  }
});
