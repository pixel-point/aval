import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

type Codec = "av1" | "vp9" | "h265" | "h264";

interface CodecDemoModelModule {
  readonly CODECS: readonly Codec[];
  parseGrassRabbitReport(value: unknown): Readonly<{
    assets: ReadonlyMap<Codec, Readonly<{ codecString: string }>>;
  }>;
  runtimeCodecFamily(value: unknown): Codec;
}

const modelUrl = new URL(
  "../../examples/grass-rabbit-codecs/codec-demo-model.js",
  import.meta.url
).href;
const {
  CODECS,
  parseGrassRabbitReport,
  runtimeCodecFamily
} = await import(modelUrl) as CodecDemoModelModule;

const REPORT_PATH = resolve(
  "examples",
  "grass-rabbit-codecs",
  "public",
  "grass-rabbit",
  "build.json"
);

describe("codec demo runtime selection", () => {
  it("maps every generated codec string back to its authored tab", async () => {
    const report = parseGrassRabbitReport(JSON.parse(
      await readFile(REPORT_PATH, "utf8")
    ));

    expect(CODECS.map((codec) => runtimeCodecFamily(
      report.assets.get(codec)?.codecString
    ))).toEqual(CODECS);
  });

  it.each([null, undefined, "", "not-a-codec"])(
    "rejects an invalid prepared codec identity %#",
    (value) => {
      expect(() => runtimeCodecFamily(value)).toThrow(
        "Prepared codec must identify an authored codec family."
      );
    }
  );
});
