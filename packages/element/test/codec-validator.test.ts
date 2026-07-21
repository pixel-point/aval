import { describe, expect, it } from "vitest";

import { FormatError } from "@pixel-point/aval-format";
import {
  loadVideoPayloadFixture,
  replaceFirstVideoChunk
} from "../../format/test/video-payload-validator-fixture.js";
import { createCodecValidator } from "../src/codec-validator.js";

const INVALID_PAYLOAD_MESSAGE = "Invalid AVAL encoded payload";

describe("element codec validator adapter", () => {
  it.each(["h264", "h265", "vp9", "av1"] as const)(
    "admits every unit of the %s certification asset",
    (family) => {
      const fixture = loadVideoPayloadFixture(family);
      const validator = createCodecValidator(fixture.profile);
      for (const unit of fixture.units) validator.validate(unit);
      validator.complete();
      validator.complete();
    }
  );

  it("maps format validation failures to the opaque element error boundary", () => {
    const fixture = loadVideoPayloadFixture("h264");
    const first = fixture.units[0]!;
    const truncated = replaceFirstVideoChunk(first, {
      bytes: first[0]!.bytes.subarray(0, 4)
    });

    expectOpaqueElementFailure(() =>
      createCodecValidator(fixture.profile).validate(truncated)
    );
  });

  it("maps format construction and completion failures", () => {
    const fixture = loadVideoPayloadFixture("vp9");
    expectOpaqueElementFailure(() => createCodecValidator({
      ...fixture.profile,
      codedWidth: 0
    }));

    const validator = createCodecValidator(fixture.profile);
    expectOpaqueElementFailure(() => validator.complete());
  });
});

function expectOpaqueElementFailure(action: () => unknown): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(FormatError);
  expect((thrown as Error).message).toBe(INVALID_PAYLOAD_MESSAGE);
}
