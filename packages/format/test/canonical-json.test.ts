import { describe, expect, it } from "vitest";

import {
  compareUtf8Strings,
  parseCanonicalJson,
  parseStrictJson,
  serializeCanonicalJson,
  serializeCanonicalJsonWithLimits
} from "../src/canonical-json.js";
import { FormatError } from "../src/errors.js";
import type { FormatErrorCode } from "../src/errors.js";

function utf8(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "utf8"));
}

function text(value: Uint8Array): string {
  return Buffer.from(value).toString("utf8");
}

function expectCode(action: () => unknown, code: FormatErrorCode): FormatError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FormatError);
    expect((error as FormatError).code).toBe(code);
    return error as FormatError;
  }
  throw new Error(`Expected FormatError ${code}`);
}

describe("canonical JSON serialization", () => {
  it("shares a strict noncanonical source-document parser", () => {
    const value = parseStrictJson(utf8('{ "z": 2, "a": 1 }'));
    expect(value).toEqual({ z: 2, a: 1 });
    expect(Object.getPrototypeOf(value)).toBeNull();
    expect(Object.isFrozen(value)).toBe(true);
    expectCode(
      () => parseStrictJson(utf8('{"a":1,"\\u0061":2}')),
      "JSON_DUPLICATE_KEY"
    );
  });

  it("writes the recursively minified canonical form", () => {
    const value = Object.assign(Object.create(null) as Record<string, unknown>, {
      z: [true, false, null, -42],
      a: { b: 2, a: 1 }
    });

    expect(text(serializeCanonicalJson(value))).toBe(
      '{"a":{"a":1,"b":2},"z":[true,false,null,-42]}'
    );
  });

  it("uses the same writer for explicitly bounded high-cardinality output", () => {
    const values = Array.from({ length: 25_000 }, (_, index) => index);
    const bytes = serializeCanonicalJsonWithLimits({ values }, {
      maxBytes: 1024 * 1024,
      maxDepth: 16,
      maxNodes: 30_000,
      maxStringBytes: 4_096
    });
    expect(JSON.parse(text(bytes))).toEqual({ values });
    expectCode(
      () => serializeCanonicalJsonWithLimits({ values }, {
        maxBytes: 1_024,
        maxDepth: 16,
        maxNodes: 30_000,
        maxStringBytes: 1_024
      }),
      "BUDGET_EXCEEDED"
    );
  });

  it("sorts keys by unsigned UTF-8 bytes rather than UTF-16 code units", () => {
    const value = { "𐀀": 2, "": 1, é: 3, z: 4 };

    expect(text(serializeCanonicalJson(value))).toBe(
      '{"z":4,"é":3,"":1,"𐀀":2}'
    );
    expect(compareUtf8Strings("", "𐀀")).toBeLessThan(0);
  });

  it("uses only the prescribed escapes and preserves all other scalars", () => {
    const value = '"\\\b\t\n\f\r\u0000/  é😀';

    expect(text(serializeCanonicalJson(value))).toBe(
      '"\\"\\\\\\b\\t\\n\\f\\r\\u0000/  é😀"'
    );
  });

  it("writes minimum and maximum safe integers in shortest decimal form", () => {
    expect(
      text(
        serializeCanonicalJson([
          Number.MIN_SAFE_INTEGER,
          0,
          Number.MAX_SAFE_INTEGER
        ])
      )
    ).toBe("[-9007199254740991,0,9007199254740991]");
  });

  it("rejects unsupported values, cycles, accessors, and unsafe numbers stably", () => {
    expectCode(() => serializeCanonicalJson(undefined), "INPUT_INVALID");
    expectCode(() => serializeCanonicalJson(-0), "INPUT_INVALID");
    expectCode(() => serializeCanonicalJson(1.5), "INTEGER_UNSAFE");
    expectCode(
      () => serializeCanonicalJson(Number.MAX_SAFE_INTEGER + 1),
      "INTEGER_UNSAFE"
    );

    const cycle: unknown[] = [];
    cycle.push(cycle);
    expectCode(() => serializeCanonicalJson(cycle), "INPUT_INVALID");

    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, "value", {
      enumerable: true,
      get: () => 1
    });
    expectCode(() => serializeCanonicalJson(accessor), "INPUT_INVALID");
  });

  it("rejects dangerous keys and lone UTF-16 surrogates", () => {
    const dangerous = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(dangerous, "constructor", {
      value: 1,
      enumerable: true
    });
    expectCode(
      () => serializeCanonicalJson(dangerous),
      "JSON_DANGEROUS_KEY"
    );
    expectCode(() => serializeCanonicalJson("\ud800"), "INPUT_INVALID");
    expectCode(() => serializeCanonicalJson("\udc00"), "INPUT_INVALID");
  });

  it("bounds object-key work before retaining encoded key metadata", () => {
    let descriptorReads = 0;
    const value = new Proxy(
      { a: 1, b: 2 },
      {
        getOwnPropertyDescriptor(target, key) {
          descriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        }
      }
    );

    expectCode(
      () =>
        serializeCanonicalJson(value, {
          budgets: { maxJsonNodes: 2 }
        }),
      "BUDGET_EXCEEDED"
    );
    expect(descriptorReads).toBe(0);

    descriptorReads = 0;
    const byteLimited = new Proxy(
      { a: 1, b: 2, c: 3 },
      {
        getOwnPropertyDescriptor(target, key) {
          descriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, key);
        }
      }
    );
    expectCode(
      () =>
        serializeCanonicalJson(byteLimited, {
          budgets: { maxManifestBytes: 1 }
        }),
      "BUDGET_EXCEEDED"
    );
    expect(descriptorReads).toBe(2);

    expectCode(
      () => serializeCanonicalJson({ ["a".repeat(4_097)]: 1 }),
      "BUDGET_EXCEEDED"
    );
  });
});

describe("canonical JSON parsing", () => {
  it("returns a recursively frozen graph of null-prototype objects", () => {
    const parsed = parseCanonicalJson(
      utf8('{"a":{"b":1},"items":[{"c":2}]}')
    ) as Record<string, unknown>;
    const nested = parsed.a as Record<string, unknown>;
    const items = parsed.items as readonly unknown[];
    const item = items[0] as Record<string, unknown>;

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(Object.getPrototypeOf(nested)).toBeNull();
    expect(Object.getPrototypeOf(item)).toBeNull();
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(nested)).toBe(true);
    expect(Object.isFrozen(items)).toBe(true);
    expect(Object.isFrozen(item)).toBe(true);
  });

  it("accepts every canonical primitive and literal non-ASCII scalar", () => {
    for (const source of [
      "null",
      "true",
      "false",
      "0",
      "-1",
      '"é😀  /"',
      "[]",
      "{}"
    ]) {
      expect(() => parseCanonicalJson(utf8(source))).not.toThrow();
    }
  });

  it("detects duplicate keys after escape decoding before canonical comparison", () => {
    const error = expectCode(
      () => parseCanonicalJson(utf8('{"a":1,"\\u0061":2}')),
      "JSON_DUPLICATE_KEY"
    );
    expect(error.offset).toBe(7);
  });

  it.each([
    '{"__proto__":1}',
    '{"prototype":1}',
    '{"constructor":1}',
    '{"\\u005f_proto__":1}',
    '{"safe":{"constructor":1}}'
  ])("rejects dangerous decoded keys: %s", (source) => {
    expectCode(() => parseCanonicalJson(utf8(source)), "JSON_DANGEROUS_KEY");
  });

  it.each([
    ["leading whitespace", " true"],
    ["trailing whitespace", "true\n"],
    ["interior whitespace", "[1, 2]"],
    ["unsorted keys", '{"b":1,"a":2}'],
    ["escaped slash", '"\\/"'],
    ["unnecessary scalar escape", '"\\u0061"'],
    ["uppercase control hex", '"\\u001B"'],
    ["surrogate escape pair", '"\\uD83D\\uDE00"'],
    ["negative zero", "-0"],
    ["leading zero", "01"],
    ["fraction", "1.0"],
    ["exponent", "1e0"]
  ])("rejects %s as noncanonical", (_label, source) => {
    expectCode(() => parseCanonicalJson(utf8(source)), "JSON_NONCANONICAL");
  });

  it.each([
    ["BOM", [0xef, 0xbb, 0xbf, 0x6e, 0x75, 0x6c, 0x6c]],
    ["unexpected continuation", [0x22, 0x80, 0x22]],
    ["overlong two byte", [0x22, 0xc0, 0xaf, 0x22]],
    ["overlong three byte", [0x22, 0xe0, 0x80, 0xaf, 0x22]],
    ["encoded surrogate", [0x22, 0xed, 0xa0, 0x80, 0x22]],
    ["above Unicode range", [0x22, 0xf4, 0x90, 0x80, 0x80, 0x22]],
    ["truncated sequence", [0x22, 0xf0, 0x9f, 0x98]],
    ["bad continuation", [0x22, 0xe2, 0x28, 0xa1, 0x22]]
  ])("rejects fatal UTF-8 case: %s", (_label, source) => {
    expectCode(
      () => parseCanonicalJson(Uint8Array.from(source as number[])),
      "JSON_INVALID"
    );
  });

  it.each([
    '"\\ud800"',
    '"\\udc00"',
    '"\\ud800x"',
    '"\\ud800\\u0041"',
    '"\\uZZZZ"',
    '"\\x20"',
    '"raw\nnewline"',
    "[1,]",
    '{"a":1,}',
    "tru",
    ""
  ])("rejects malformed JSON without a built-in exception: %s", (source) => {
    expectCode(() => parseCanonicalJson(utf8(source)), "JSON_INVALID");
  });

  it("rejects integers outside the safe range", () => {
    expectCode(
      () => parseCanonicalJson(utf8("9007199254740992")),
      "INTEGER_UNSAFE"
    );
    expectCode(
      () => parseCanonicalJson(utf8("-9007199254740992")),
      "INTEGER_UNSAFE"
    );
    expectCode(
      () => parseCanonicalJson(utf8("999999999999999999999999999999")),
      "INTEGER_UNSAFE"
    );
  });

  it("enforces manifest, depth, node, and decoded string budgets", () => {
    expectCode(
      () => parseCanonicalJson(utf8("null"), { budgets: { maxManifestBytes: 3 } }),
      "BUDGET_EXCEEDED"
    );
    expectCode(
      () => parseCanonicalJson(utf8("[[0]]"), { budgets: { maxJsonDepth: 2 } }),
      "BUDGET_EXCEEDED"
    );
    expectCode(
      () => parseCanonicalJson(utf8("[0,1]"), { budgets: { maxJsonNodes: 2 } }),
      "BUDGET_EXCEEDED"
    );
    expectCode(
      () => parseCanonicalJson(utf8('"éé"'), { budgets: { maxJsonStringBytes: 3 } }),
      "BUDGET_EXCEEDED"
    );
    expectCode(
      () => parseCanonicalJson(utf8('"\\u00e9\\u00e9"'), {
        budgets: { maxJsonStringBytes: 3 }
      }),
      "BUDGET_EXCEEDED"
    );
  });

  it("reports the first byte that differs from canonical form", () => {
    const error = expectCode(
      () => parseCanonicalJson(utf8('{"b":1,"a":2}')),
      "JSON_NONCANONICAL"
    );
    expect(error.offset).toBe(2);
  });
});
