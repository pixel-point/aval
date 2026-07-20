import { describe, expect, it } from "vitest";

import { FormatError } from "../src/errors.js";
import { parseFrontIndex } from "../src/parser.js";
import { validateCompiledManifest } from "../src/manifest-schema.js";
import { writeCanonicalAsset } from "../src/writer.js";
import { validManifest } from "./manifest-fixture.js";
import { validWriterInput } from "./writer-fixture.js";

function qualifiedPackedManifest(): Record<string, any> {
  const manifest = structuredClone(validManifest()) as Record<string, any>;
  manifest.formatVersion = "1.1";
  manifest.layout = "packed-alpha";
  manifest.renditions[0].codedHeight = 32;
  manifest.renditions[0].alphaLayout = {
    type: "stacked",
    colorRect: [0, 0, 2, 2],
    alphaRect: [0, 10, 2, 2]
  };
  manifest.renditions[0].outputQualification = {
    kind: "packed-alpha-v1",
    unit: "body-a",
    frame: 0,
    samples: [
      { x: 0, y: 0, expectedRange: [0, 32] },
      { x: 1, y: 1, expectedRange: [159, 255] }
    ]
  };
  manifest.limits.decodedPixelBytes = 16 * 32 * 4;
  manifest.limits.runtimeWorkingSetBytes = 16 * 32 * 4;
  return manifest;
}

function expectManifestInvalid(value: unknown, path?: string): FormatError {
  try {
    validateCompiledManifest(value);
  } catch (error) {
    expect(error).toBeInstanceOf(FormatError);
    expect((error as FormatError).code).toBe("MANIFEST_INVALID");
    if (path !== undefined) expect((error as FormatError).path).toBe(path);
    return error as FormatError;
  }
  throw new Error("expected manifest validation to fail");
}

describe("packed-alpha output qualification wire 1.1", () => {
  it("validates, detaches, and recursively freezes a bounded witness", () => {
    const source = qualifiedPackedManifest();
    const manifest = validateCompiledManifest(source);

    expect(manifest.formatVersion).toBe("1.1");
    expect(manifest.renditions[0]).toMatchObject({
      outputQualification: {
        kind: "packed-alpha-v1",
        unit: "body-a",
        frame: 0,
        samples: [
          { x: 0, y: 0, expectedRange: [0, 32] },
          { x: 1, y: 1, expectedRange: [159, 255] }
        ]
      }
    });
    expect(manifest).not.toBe(source);
    expectDeepFrozen(manifest);
  });

  it("keeps legacy 1.0 exact and requires qualification only for 1.1 packed alpha", () => {
    const legacy = qualifiedPackedManifest();
    legacy.formatVersion = "1.0";
    expectManifestInvalid(legacy, "renditions[0]");

    delete legacy.renditions[0].outputQualification;
    expect(validateCompiledManifest(legacy).formatVersion).toBe("1.0");

    const missing = qualifiedPackedManifest();
    delete missing.renditions[0].outputQualification;
    expectManifestInvalid(missing, "renditions[0].outputQualification");

    const opaque = qualifiedPackedManifest();
    opaque.layout = "opaque";
    opaque.renditions[0].codedHeight = 16;
    opaque.renditions[0].alphaLayout = {
      type: "opaque",
      colorRect: [0, 0, 2, 2]
    };
    opaque.limits.decodedPixelBytes = 16 * 16 * 4;
    opaque.limits.runtimeWorkingSetBytes = 16 * 16 * 4;
    expectManifestInvalid(opaque, "renditions[0]");

    delete opaque.renditions[0].outputQualification;
    expect(validateCompiledManifest(opaque).formatVersion).toBe("1.1");
  });

  it("rejects unknown witness fields and kinds", () => {
    const unknown = qualifiedPackedManifest();
    unknown.renditions[0].outputQualification.extra = true;
    expectManifestInvalid(unknown, "renditions[0].outputQualification");

    const kind = qualifiedPackedManifest();
    kind.renditions[0].outputQualification.kind = "packed-alpha-v2";
    expectManifestInvalid(kind, "renditions[0].outputQualification.kind");

    const sample = qualifiedPackedManifest();
    sample.renditions[0].outputQualification.samples[0].extra = true;
    expectManifestInvalid(
      sample,
      "renditions[0].outputQualification.samples[0]"
    );
  });

  it("requires one through eight dense, uniquely addressed samples", () => {
    const empty = qualifiedPackedManifest();
    empty.renditions[0].outputQualification.samples = [];
    expectManifestInvalid(empty, "renditions[0].outputQualification.samples");

    const excessive = qualifiedPackedManifest();
    excessive.renditions[0].outputQualification.samples = Array.from(
      { length: 9 },
      (_, x) => ({ x: x % 2, y: Math.floor(x / 2), expectedRange: [0, 32] })
    );
    expectManifestInvalid(excessive, "renditions[0].outputQualification.samples");

    const sparse = qualifiedPackedManifest();
    sparse.renditions[0].outputQualification.samples = new Array(1);
    expectManifestInvalid(sparse, "renditions[0].outputQualification.samples[0]");

    const duplicate = qualifiedPackedManifest();
    duplicate.renditions[0].outputQualification.samples[1].x = 0;
    duplicate.renditions[0].outputQualification.samples[1].y = 0;
    expectManifestInvalid(
      duplicate,
      "renditions[0].outputQualification.samples[1]"
    );
  });

  it("bounds local alpha coordinates and inclusive intervals", () => {
    for (const [mutate, path] of [
      [
        (value: Record<string, any>) => {
          value.renditions[0].outputQualification.samples[0].x = 2;
        },
        "renditions[0].outputQualification.samples[0].x"
      ],
      [
        (value: Record<string, any>) => {
          value.renditions[0].outputQualification.samples[0].y = -1;
        },
        "renditions[0].outputQualification.samples[0].y"
      ],
      [
        (value: Record<string, any>) => {
          value.renditions[0].outputQualification.samples[0].expectedRange = [33, 32];
        },
        "renditions[0].outputQualification.samples[0].expectedRange"
      ],
      [
        (value: Record<string, any>) => {
          value.renditions[0].outputQualification.samples[0].expectedRange = [0, 97];
        },
        "renditions[0].outputQualification.samples[0].expectedRange"
      ],
      [
        (value: Record<string, any>) => {
          value.renditions[0].outputQualification.samples[0].expectedRange = [-1, 32];
        },
        "renditions[0].outputQualification.samples[0].expectedRange[0]"
      ],
      [
        (value: Record<string, any>) => {
          value.renditions[0].outputQualification.samples[0].expectedRange = [224, 256];
        },
        "renditions[0].outputQualification.samples[0].expectedRange[1]"
      ]
    ] as const) {
      const manifest = qualifiedPackedManifest();
      mutate(manifest);
      expectManifestInvalid(manifest, path);
    }

    const maximumWidth = qualifiedPackedManifest();
    maximumWidth.renditions[0].outputQualification.samples[0].expectedRange = [0, 96];
    expect(validateCompiledManifest(maximumWidth).formatVersion).toBe("1.1");
  });

  it("enforces unit, local frame, readiness, and rendition-span relations", () => {
    const unknownUnit = qualifiedPackedManifest();
    unknownUnit.renditions[0].outputQualification.unit = "unknown";
    expectManifestInvalid(
      unknownUnit,
      "renditions[0].outputQualification.unit"
    );

    const frame = qualifiedPackedManifest();
    frame.renditions[0].outputQualification.frame = 4;
    expectManifestInvalid(frame, "renditions[0].outputQualification.frame");

    const readiness = qualifiedPackedManifest();
    readiness.renditions[0].outputQualification.unit = "rev-bc";
    readiness.renditions[0].outputQualification.frame = 0;
    expectManifestInvalid(readiness, "renditions[0].outputQualification.unit");

    const span = qualifiedPackedManifest();
    span.units[0].chunks[0].rendition = "other";
    expectManifestInvalid(span);
  });

  it("writes and parses matching 1.1 header and manifest versions", () => {
    const input = validWriterInput() as any;
    const qualified = qualifiedPackedManifest();
    const { units: _compiledUnits, ...fields } = qualified;
    input.manifest = {
      ...input.manifest,
      ...fields,
      units: input.manifest.units
    };

    const bytes = writeCanonicalAsset(input);
    const front = parseFrontIndex(bytes);
    expect([front.header.major, front.header.minor]).toEqual([1, 1]);
    expect(front.manifest.formatVersion).toBe("1.1");
  });

  it("keeps legacy writer headers at 1.0 and rejects either version mismatch", () => {
    const legacy = writeCanonicalAsset(validWriterInput());
    expect([
      parseFrontIndex(legacy).header.major,
      parseFrontIndex(legacy).header.minor
    ]).toEqual([1, 0]);

    const qualifiedInput = validWriterInput() as any;
    const qualified = qualifiedPackedManifest();
    const { units: _compiledUnits, ...fields } = qualified;
    qualifiedInput.manifest = {
      ...qualifiedInput.manifest,
      ...fields,
      units: qualifiedInput.manifest.units
    };
    const qualifiedBytes = writeCanonicalAsset(qualifiedInput);

    const legacyHeaderQualifiedManifest = qualifiedBytes.slice();
    legacyHeaderQualifiedManifest[10] = 0;
    expect(() => parseFrontIndex(legacyHeaderQualifiedManifest)).toThrowError(
      expect.objectContaining({ code: "MANIFEST_INVALID", path: "formatVersion" })
    );

    const qualifiedHeaderLegacyManifest = legacy.slice();
    qualifiedHeaderLegacyManifest[10] = 1;
    expect(() => parseFrontIndex(qualifiedHeaderLegacyManifest)).toThrowError(
      expect.objectContaining({ code: "MANIFEST_INVALID", path: "formatVersion" })
    );
  });
});

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    expectDeepFrozen((value as Record<PropertyKey, unknown>)[key], seen);
  }
}
