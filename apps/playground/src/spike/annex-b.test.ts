import { describe, expect, it } from "vitest";

import {
  H264_NAL_UNIT_TYPE,
  inspectH264AnnexBKeyAccessUnit,
  splitAnnexBAccessUnit
} from "./annex-b";

describe("Annex B inspection", () => {
  it("finds SPS, PPS, and IDR NAL units across both start-code lengths", () => {
    const bytes = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x20,
      0, 0, 1, 0x68, 0xce, 0x3c, 0x80,
      0, 0, 1, 0x65, 0x88, 0x84
    ]);

    const evidence = inspectH264AnnexBKeyAccessUnit(bytes);

    expect(evidence.nalUnitTypes).toEqual([
      H264_NAL_UNIT_TYPE.sps,
      H264_NAL_UNIT_TYPE.pps,
      H264_NAL_UNIT_TYPE.idrSlice
    ]);
    expect(evidence.startCodeLengths).toEqual([4, 3, 3]);
  });

  it("reports exact payload boundaries", () => {
    const units = splitAnnexBAccessUnit(
      new Uint8Array([0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3])
    );

    expect(units).toMatchObject([
      { startOffset: 0, payloadOffset: 3, endOffset: 6, type: 7 },
      { startOffset: 6, payloadOffset: 9, endOffset: 11, type: 8 }
    ]);
  });

  it.each([
    new Uint8Array(),
    new Uint8Array([1, 2, 3]),
    new Uint8Array([9, 0, 0, 1, 0x67])
  ])("rejects malformed Annex B framing", (bytes) => {
    expect(() => splitAnnexBAccessUnit(bytes)).toThrow();
  });

  it("rejects a forbidden NAL header bit", () => {
    expect(() =>
      splitAnnexBAccessUnit(new Uint8Array([0, 0, 1, 0xe7, 1]))
    ).toThrow("forbidden_zero_bit");
  });

  it("rejects a key access unit missing required parameter or IDR units", () => {
    expect(() =>
      inspectH264AnnexBKeyAccessUnit(
        new Uint8Array([0, 0, 1, 0x67, 1, 0, 0, 1, 0x68, 2])
      )
    ).toThrow("IDR");
  });
});
