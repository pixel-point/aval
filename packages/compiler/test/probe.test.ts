import { describe, expect, it } from "vitest";

import { CompilerError } from "../src/diagnostics.js";
import {
  decimalSecondsToMicros,
  parseProbeJson,
  parseRational
} from "../src/ffmpeg/probe.js";

function probeJson(
  timestamps: readonly number[],
  options: {
    readonly durationTicks?: number;
    readonly frameRate?: string;
    readonly pixelFormat?: string;
    readonly timeBase?: string;
  } = {}
): string {
  const durationTicks = options.durationTicks ?? 1;
  const frameRate = options.frameRate ?? "30/1";
  return JSON.stringify({
    frames: timestamps.map((timestamp) => ({
      best_effort_timestamp: timestamp,
      duration: durationTicks
    })),
    streams: [{
      width: 256,
      height: 128,
      sample_aspect_ratio: "1:1",
      pix_fmt: options.pixelFormat ?? "yuv420p",
      field_order: "progressive",
      avg_frame_rate: frameRate,
      r_frame_rate: frameRate,
      time_base: options.timeBase ?? "1/30",
      nb_frames: String(timestamps.length),
      duration: "0.100000"
    }],
    format: {
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
      duration: "0.100000"
    }
  });
}

describe("FFprobe parser", () => {
  it("parses and freezes a bounded CFR source", () => {
    const result = parseProbeJson(
      probeJson([0, 1, 2]),
      "clip.mp4"
    );
    expect(result).toMatchObject({
      width: 256,
      height: 128,
      frameRate: { numerator: 30, denominator: 1 },
      frameCount: 3,
      durationMicros: 100_000,
      variableFrameRate: false,
      hasAlpha: false
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.frames)).toBe(true);
  });

  it("reports VFR from timestamp deltas or conflicting rate metadata", () => {
    expect(parseProbeJson(
      probeJson([0, 1, 3])
    ).variableFrameRate).toBe(true);

    const value = JSON.parse(probeJson([0, 1, 2]));
    value.streams[0].r_frame_rate = "60/1";
    expect(parseProbeJson(JSON.stringify(value)).variableFrameRate).toBe(true);
  });

  it("classifies indexed palettes and packed AYUV/VUYA as alpha-bearing", () => {
    for (const pixelFormat of [
      "pal8",
      "ayuv64le",
      "ayuv64be",
      "vuya",
      "yuva420p",
      "gbrap16le",
      "rgba64be",
      "ya16le"
    ]) {
      expect(parseProbeJson(
        probeJson([0], { pixelFormat }),
        `${pixelFormat}.mov`
      ).hasAlpha).toBe(true);
    }
    for (const pixelFormat of ["yuv420p", "rgb24", "bgr0", "gray16le"]) {
      expect(parseProbeJson(
        probeJson([0], { pixelFormat }),
        `${pixelFormat}.mov`
      ).hasAlpha).toBe(false);
    }
  });

  it("proves 30000/1001 timing with exact tick arithmetic", () => {
    const options = {
      durationTicks: 1_001,
      frameRate: "30000/1001",
      timeBase: "1/30000"
    } as const;
    expect(parseProbeJson(probeJson([0, 1_001, 2_002], options))
      .variableFrameRate).toBe(false);
    expect(parseProbeJson(probeJson([0, 1_001, 2_003], options))
      .variableFrameRate).toBe(true);
  });

  it("keeps a CFR grid exact when safe PTS subtraction exceeds the safe range", () => {
    const tick = 3_002_399_751_580_331;
    expect(parseProbeJson(probeJson(
      [-tick, 0, tick, 2 * tick],
      {
        durationTicks: tick,
        frameRate: "1/1",
        timeBase: `1/${String(tick)}`
      }
    )).variableFrameRate).toBe(false);
  });

  it("does not round an over-limit exact duration down to thirty seconds", () => {
    const ticksPerSecond = 2 ** 49;
    const halfThirtySeconds = 15 * ticksPerSecond;
    expect(() => parseProbeJson(probeJson(
      [-halfThirtySeconds, halfThirtySeconds],
      {
        durationTicks: 1,
        frameRate: "1/1",
        timeBase: `1/${String(ticksPerSecond)}`
      }
    ))).toThrowError(expect.objectContaining({ code: "SOURCE_LIMIT" }));
  });

  it("rejects declared media beyond thirty seconds outside the probe window", () => {
    const over = JSON.parse(probeJson([0]));
    over.streams[0].duration = "30.0000001";
    over.format.duration = "30.0000001";
    expect(() => parseProbeJson(JSON.stringify(over), "sparse.mov"))
      .toThrowError(expect.objectContaining({ code: "SOURCE_LIMIT" }));

    const exact = JSON.parse(probeJson([0]));
    exact.streams[0].duration = "30.0000000";
    exact.format.duration = "30.0000000";
    expect(parseProbeJson(JSON.stringify(exact), "bounded.mov").durationMicros)
      .toBe(30_000_000);
  });

  it("parses rational and decimal time without floating-point drift", () => {
    expect(parseRational("60000/2002", "fps")).toEqual({
      numerator: 30_000,
      denominator: 1_001
    });
    expect(decimalSecondsToMicros("1.0000005")).toBe(1_000_001);
    expect(decimalSecondsToMicros("0.033333")).toBe(33_333);
  });

  it("rejects unsupported demuxers, dimensions, timestamps, and empty streams", () => {
    const cases = [
      (() => {
        const value = JSON.parse(probeJson([0]));
        value.format.format_name = "hls";
        return value;
      })(),
      (() => {
        const value = JSON.parse(probeJson([0]));
        value.streams[0].width = 4097;
        return value;
      })(),
      JSON.parse(probeJson([0, 0])),
      (() => {
        const value = JSON.parse(probeJson([0]));
        value.frames = [];
        return value;
      })(),
      (() => {
        const value = JSON.parse(probeJson([0]));
        value.streams.push({ ...value.streams[0], index: 1 });
        return value;
      })(),
      (() => {
        const value = JSON.parse(probeJson([0]));
        value.streams[0].sample_aspect_ratio = "4:3";
        return value;
      })(),
      (() => {
        const value = JSON.parse(probeJson([0]));
        value.streams[0].field_order = "tt";
        return value;
      })(),
      (() => {
        const value = JSON.parse(probeJson([0]));
        value.streams[0].side_data_list = [{ rotation: -90 }];
        return value;
      })()
    ];
    for (const value of cases) {
      expect(() => parseProbeJson(JSON.stringify(value))).toThrow(CompilerError);
    }
  });
});
