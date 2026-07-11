import { describe, expect, it } from "vitest";

import {
  FRAME_TAG_CELL_COUNT,
  decodeFrameTagFromRgba,
  encodeFrameTagCells,
  getFrameTagLayout
} from "./frame-tag";

describe("synthetic frame tags", () => {
  it.each([0, 1, 42, 127, 128, 255])(
    "round-trips tag %i through an RGBA surface",
    (value) => {
      const surface = renderTag(value);

      expect(decodeFrameTagFromRgba(surface)).toBe(value);
    }
  );

  it("keeps anchors, complements, and parity in the encoded cells", () => {
    const cells = encodeFrameTagCells(0b1010_0110);

    expect(cells).toHaveLength(FRAME_TAG_CELL_COUNT);
    expect(cells.slice(0, 2)).toEqual([false, true]);
    for (let bit = 0; bit < 8; bit += 1) {
      expect(cells[2 + bit]).toBe(!cells[10 + bit]);
    }
    expect(cells.at(-2)).toBe(!cells.at(-1));
  });

  it("tolerates bounded grayscale noise", () => {
    const surface = renderTag(173, 11);

    expect(decodeFrameTagFromRgba(surface)).toBe(173);
  });

  it("rejects a corrupted complement cell", () => {
    const surface = renderTag(42);
    paintCell(surface, 10, 24);

    expect(() => decodeFrameTagFromRgba(surface)).toThrow(
      "complement check failed"
    );
  });

  it("rejects dimensions too small for robust cells", () => {
    expect(() => getFrameTagLayout(40, 20)).toThrow("needs at least");
  });
});

interface TestSurface {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

function renderTag(value: number, noise = 0): TestSurface {
  const surface: TestSurface = {
    data: new Uint8Array(220 * 100 * 4),
    width: 220,
    height: 100
  };
  const cells = encodeFrameTagCells(value);

  for (let cell = 0; cell < cells.length; cell += 1) {
    const base = cells[cell] === true ? 232 : 24;
    paintCell(surface, cell, base, noise);
  }

  return surface;
}

function paintCell(
  surface: TestSurface,
  cell: number,
  gray: number,
  noise = 0
): void {
  const layout = getFrameTagLayout(surface.width, surface.height);
  const x0 = Math.floor((cell * layout.width) / layout.cellCount);
  const x1 = Math.floor(((cell + 1) * layout.width) / layout.cellCount);

  for (let y = layout.y; y < layout.y + layout.height; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const alternatingNoise = (x + y) % 2 === 0 ? noise : -noise;
      const value = Math.max(0, Math.min(255, gray + alternatingNoise));
      const offset = (y * surface.width + x) * 4;
      surface.data[offset] = value;
      surface.data[offset + 1] = value;
      surface.data[offset + 2] = value;
      surface.data[offset + 3] = 255;
    }
  }
}
