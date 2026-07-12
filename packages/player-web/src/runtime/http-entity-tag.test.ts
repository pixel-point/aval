import { describe, expect, it } from "vitest";

import { RuntimePlaybackError } from "./errors.js";
import {
  parseStrongEntityTag,
  requireMatchingStrongEntityTag,
  strongEntityTagsEqual
} from "./http-entity-tag.js";

describe("strong HTTP entity tags", () => {
  it.each([
    ['""', '""'],
    ['"opaque"', '"opaque"'],
    [' \t"a,b\\c"\t ', '"a,b\\c"'],
    [`"${String.fromCharCode(0x80, 0xff)}"`, `"${String.fromCharCode(0x80, 0xff)}"`]
  ])("normalizes one syntactically strong quoted tag", (value, expected) => {
    expect(parseStrongEntityTag(value)).toBe(expected);
  });

  it.each([
    null,
    "",
    " ",
    "opaque",
    "W/\"opaque\"",
    "w/\"opaque\"",
    "W /\"opaque\"",
    "\"a\", \"b\"",
    "\"unterminated",
    "\"embedded\"quote\"",
    `"a${String.fromCharCode(0)}b"`,
    `"a${String.fromCharCode(0x1f)}b"`,
    `"a${String.fromCharCode(0x7f)}b"`,
    `"a${String.fromCharCode(0x100)}b"`,
    "\tW/\"weak\"\t",
    "\"ok\"\n"
  ])("treats missing, weak, list, control, and malformed tag %j as unavailable", (value) => {
    expect(parseStrongEntityTag(value)).toBeNull();
  });

  it("compares normalized tags by exact code units", () => {
    const lower = parseStrongEntityTag('"etag"')!;
    const upper = parseStrongEntityTag('"ETAG"')!;
    const same = parseStrongEntityTag('\t"etag" ')!;

    expect(strongEntityTagsEqual(lower, same)).toBe(true);
    expect(strongEntityTagsEqual(lower, upper)).toBe(false);
  });

  it("classifies any missing, weak, malformed, or changed pinned tag as entity change", () => {
    const pinned = parseStrongEntityTag('"generation-1"')!;
    expect(requireMatchingStrongEntityTag(' "generation-1" ', pinned)).toBe(
      pinned
    );

    for (const candidate of [
      null,
      'W/"generation-1"',
      '"generation-2"',
      '"generation-1", "generation-2"'
    ]) {
      try {
        requireMatchingStrongEntityTag(candidate, pinned);
        throw new Error("expected entity change");
      } catch (error) {
        expect(error).toBeInstanceOf(RuntimePlaybackError);
        expect((error as RuntimePlaybackError).code).toBe("entity-changed");
        expect((error as Error).message).not.toContain("generation");
      }
    }
  });
});
