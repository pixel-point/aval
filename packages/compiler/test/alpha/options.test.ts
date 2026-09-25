import { describe, expect, it } from "vitest";
import { resolveAlphaOptions } from "../../src/alpha/options.js";
import { alphaMarkup } from "../../src/alpha/compile.js";
import { parseAlphaCli } from "../../src/alpha/cli.js";
import type { AlphaCompileOptions } from "../../src/alpha/types.js";

describe("alpha compiler policy", () => {
  it("detaches validated search settings from later caller mutations", () => {
    const crfs = [20, 30], presets = ["slow"];
    const optimize = { crfs, presets: { h265: presets }, maxAlphaMae: 2, maxCompositeMae: 3 };
    const result = resolveAlphaOptions({ out: "out", encodings: [{ codec: "h265" }], optimize });
    crfs.push(100); presets[0] = "invalid"; optimize.maxAlphaMae = NaN;
    expect(result.optimize).toEqual({ crfs: [20, 30], presets: { h265: ["slow"] }, maxAlphaMae: 2, maxCompositeMae: 3 });
  });

  it("supports software x265 quality controls and bounded preset searches", () => {
    const options = resolveAlphaOptions({ out: "out", encodings: [{ codec: "h265", crf: 21.5, preset: "veryslow", x265: { aqMode: 3, psyRd: 1, sao: false } }],
      optimize: { crfs: [20, 25], presets: { h265: ["slow", "veryslow"] }, maxAlphaMae: 2, maxCompositeMae: 3 } });
    expect(options.encodings[0]).toMatchObject({ crf: 21.5, preset: "veryslow", x265: { aqMode: 3 } });
  });
  it.each([
    { encodings: [{ codec: "h265", cpuUsed: 1 }] }, { encodings: [{ codec: "vp9", preset: "slow" }] },
    { encodings: [{ codec: "av1", crf: 64 }] }, { encodings: [{ codec: "vp9", crf: 21.5 }] },
    { encodings: [{ codec: "h264", bitDepth: 10 }] }, { encodings: [{ codec: "h265", x265: { argv: "-i" } }] },
    { encodings: [{ codec: "h265" }, { codec: "h265" }] }, { optimize: null },
    { optimize: { crfs: [20], maxAlphaMae: -1, maxCompositeMae: 2 } }, { unknownOption: true }
  ])("rejects unsupported configuration %j", (options) => {
    expect(() => resolveAlphaOptions({ out: "out", ...options } as AlphaCompileOptions)).toThrow();
  });
  it("routes alpha CLI options independently from AVAL project rules", () => {
    expect(parseAlphaCli(["frames-%04d.png", "--out", "out", "--codecs", "h265", "--crf", "24", "--preset", "veryslow", "--fps", "24", "--frames", "48"]))
      .toMatchObject({ command: "alpha", options: { fps: 24, frames: 48, encodings: [{ codec: "h265", crf: 24, preset: "veryslow" }] } });
    expect(() => parseAlphaCli(["clip.mov", "--out", "out", "--typo", "1"])).toThrow();
    expect(() => parseAlphaCli(["clip.mov", "--out", "out", "--crf", "20"])).toThrow(/require --codecs/u);
  });
  it("escapes markup without embedding compiler diagnostics", () => {
    const html = alphaMarkup([{ src: 'a&"<.mp4', type: 'video/mp4; codecs="hvc1.1.6.L30.90"', width: 32, height: 40, colorRect: [0, 0, 32, 16], alphaRect: [0, 24, 32, 16] }], 32, 16);
    expect(html).toContain('src="a&amp;&quot;&lt;.mp4"');
    expect(html).toContain('data-layout="32 40 0 0 32 16 0 24 32 16"');
    expect(html).not.toContain("build.json");
  });
});
