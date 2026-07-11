# M4 Minimal Compiled Format Implementation Plan

**Date:** 2026-07-11

**Design:** [M4 Minimal Compiled Format Design](../specs/2026-07-11-m4-minimal-compiled-format-design.md)

## Outcome

Add a pure `@rendered-motion/format` workspace package that writes one
canonical 0.1 compiled asset, parses its bounded front index, validates a full
file's layout and conformance payloads, and returns M3's validated graph without
copying or retaining media payloads.

## Execution Order

### 1. Establish the package boundary

Add:

```text
packages/format/package.json
packages/format/tsconfig.json
packages/format/tsconfig.test.json
packages/format/src/index.ts
```

Add the root project reference and build `graph` before `format`. The package
has only `@rendered-motion/graph` as a production dependency. Enforce
`lib: ["ES2023"]` and `types: []` in production. Add a compile-only test that
the public declarations contain no DOM, WebCodecs, Node, or platform crypto
types.

### 2. Freeze constants, budgets, errors, and checked arithmetic

Implement:

```text
packages/format/src/constants.ts
packages/format/src/errors.ts
packages/format/src/checked-integer.ts
packages/format/test/header.test.ts
packages/format/test/checked-integer.test.ts
```

Define the exact magic/version/record constants, immutable default budgets,
lower-only budget merge, identifier/digest patterns, and stable `FormatError`
codes. Implement prechecked little-endian byte reads and writes, bigint-first
`uint64` conversion, checked add/multiply, `align8`, and range containment.

Test zero, maximum safe integers, `MAX_SAFE_INTEGER + 1n`, multiplication and
alignment overflow, unaligned `Uint8Array` views, truncation at all 64 header
positions, unsupported versions/features, and that no built-in exception
escapes.

### 3. Implement canonical JSON before the manifest schema

Implement:

```text
packages/format/src/canonical-json.ts
packages/format/test/canonical-json.test.ts
packages/format/test/canonical-json-fuzz.test.ts
```

Write a bounded recursive-descent JSON parser that detects keys after escape
decoding and constructs null-prototype objects. Add canonical UTF-8 serialization
and exact input-byte comparison. Do not use `JSON.parse` as the acceptance
parser because it cannot report duplicate keys.

Golden tests cover UTF-8 bytewise key order, all string escapes, literal
non-ASCII scalars, U+2028/U+2029, decoded duplicate keys, dangerous keys,
invalid and overlong UTF-8, BOM, lone surrogates, unsafe/fraction/exponent
numbers, `-0`, whitespace, depth/nodes/strings, and deterministic recursive
freezing. Seeded grammar and byte mutations must return a value or one
`FormatError` code only.

### 4. Add the exact 0.1 model and executable schema

Implement:

```text
packages/format/src/model.ts
packages/format/src/manifest-schema.ts
packages/format/test/manifest-schema.test.ts
packages/format/test/manifest-hostile.test.ts
```

Encode every closed union and field constraint from Design Section 5 in one
runtime schema/clone layer that returns the public immutable TypeScript model.
Reject unknown and union-inapplicable fields. Validate canonical identity-array
order, IDs, digests, counts, dimensions, rectangles, rates, profiles, unit
usage, sample span shape, reversible endpoints, cut runways, bindings,
readiness references, fallback literals, and declared estimates.

Use compact valid fixtures and table-driven one-field mutations. Assert a
stable path for every rejection. Add explicit boundary cases at 32/33 states,
64/65 edges, 96/97 units, 4/5 renditions, 900/901 frames, 128/129 blobs, and
every lowerable schema budget.

### 5. Implement the sole graph adapter

Implement:

```text
packages/format/src/graph-adapter.ts
packages/format/test/graph-adapter.test.ts
```

Resolve media units and map the manifest to an M3 definition exactly once.
Call `validateMotionGraphDefinition`; wrap its failures as `GRAPH_INVALID`.
Golden tests cover loop/finite/held mapping, initial one-shot, portal/finish/cut,
transitionless and locked edges, a reversible inverse pair, events/completion,
and static IDs. Compare the adapted definition to a hand-written M3 golden and
prove the returned graph is immutable.

### 6. Implement header and access-unit index codecs

Implement:

```text
packages/format/src/header.ts
packages/format/src/access-unit-index.ts
packages/format/test/access-unit-index.test.ts
```

Encode/decode the exact 64-byte header, 16-byte index header, and 32-byte
records. Validate exact index length before record allocation. Cross-check
record count and ordering against every unit/rendition/frame and manifest span.
Test golden hex, all reserved bits/bytes, unknown flag bits, zero/oversized
samples, record-order permutations, missing/extra frames, non-key frame zero,
reference delta flags, span mismatch, unsafe offsets, and truncation at every
record byte.

### 7. Implement canonical layout and front-index parsing

Implement:

```text
packages/format/src/layout.ts
packages/format/src/parser.ts
packages/format/test/front-index.test.ts
packages/format/test/layout.test.ts
```

`parseFrontIndex` validates only the required prefix, returns numeric ranges,
and retains neither input bytes nor payload views. `validateCompleteAsset`
accepts exactly the declared full bytes, reuses or parses a matching front
index, validates canonical unit/PNG positions, scans every alignment region for
zeroes, and rejects gaps, overlaps, aliases, and trailing bytes.

Tests use weak references where available plus direct mutation probes to show
that parsed results do not depend on later input-buffer changes. Cover a
minimum-length front prefix, full-file input to front parsing, mismatched reused
front index, every alignment residue 0–7, nonzero padding at every boundary,
and offsets/ranges at budget and safe-integer edges.

### 8. Add the reference-frame and shallow PNG gates

Implement:

```text
packages/format/src/reference-frame.ts
packages/format/test/reference-frame.test.ts
packages/format/test/png-envelope.test.ts
```

Encode and validate the exact 24-byte `RMRF` header and unpremultiplied row-major
RGBA payload. Return only metadata and an RGBA numeric range. During complete
validation, inspect every reference record and shallow-check each PNG signature
and IHDR envelope.

Mutate every reference-header field, dimension product, index/header frame
agreement, key bit, declared/present payload length, and final byte. PNG tests
cover signature, IHDR length/type, logical dimensions, bit depth, color type,
compression, filter, interlace, and truncation. Include deliberately bad CRC,
IDAT, and IEND fixtures that M4 accepts to document that full PNG validation is
deferred to M6. Include syntactically valid but incorrect unit/static digest
values that M4 accepts to document that recomputation is deferred to M7.

### 9. Implement the bounded canonical writer

Implement:

```text
packages/format/src/writer.ts
packages/format/test/writer.test.ts
packages/format/test/round-trip.test.ts
```

Normalize writer input without mutation, derive sample spans and payload
lengths, run the 32-step fixed point for static offsets, write exact header and
index bytes, copy each payload once, fill only canonical zero padding, and run
`validateCompleteAsset` over the result before returning.

Test repeated byte identity, shuffled semantic input, input immutability,
missing/duplicate/extra payloads, payload mutation between calls, every decimal
digit transition reachable under 32 MiB, eight-byte alignment transitions,
fixed-point convergence, a forced nonconvergence test seam, and maximum-output
allocation rejection before allocation. Recreate a writer input from parsed
metadata plus the original caller-owned payloads and require byte-identical
round trip.

### 10. Add golden and hostile conformance fixtures

Add:

```text
fixtures/conformance/m4/reference-loop.rma
fixtures/conformance/m4/reference-graph.rma
fixtures/conformance/m4/malformed/README.md
packages/format/test/conformance.test.ts
packages/format/test/mutation-fuzz.test.ts
```

Generate and check in one tiny one-state RGBA loop and one multi-state fixture
covering finite/held, portal, cut, locked, and reversible graph metadata. Record
their whole-file hex digest in the fixture README for accidental-change review;
this is fixture provenance, not runtime verification.

Create malformed fixtures programmatically from named mutations instead of
checking in hundreds of binaries. Cover duplicate escaped JSON keys, dangerous
keys, unsafe `uint64`, extreme counts, false index lengths, ordering errors,
zero and huge sample sizes, padding, gap/overlap/alias/trailing bytes, profile
mismatch, malformed reference payloads, and shallow PNG mismatch. Run seeded
single-byte, slice, insertion, deletion, and structured field mutations. The
only permitted outcomes are a frozen valid result or `FormatError`.

### 11. Export and verify the complete repository

Export only the approved constants, types, errors, parser/writer APIs,
reference-frame helpers, budgets, and graph adapter from
`packages/format/src/index.ts`. Do not export mutable schema internals or
unchecked byte helpers.

Run:

```text
npm run typecheck
npm run test:unit
npm run build
npm run test:browser
npm audit --audit-level=high
git diff --check
```

Then run a read-only M4 audit against the design, record
`docs/evidence/2026-07-11-m4-minimal-compiled-format.md`, and verify that:

- the production declaration graph has no platform types;
- all parsed output is frozen and range-only;
- fuzz never leaks a built-in exception;
- M4 does not claim H.264, full PNG, digest, network, or decode conformance;
- M0–M3 evidence remains reproducible; and
- the worktree contains no generated `dist` or unrelated changes in the M4
  commit.

## Package Files

```text
packages/format/
  package.json
  tsconfig.json
  tsconfig.test.json
  src/constants.ts
  src/errors.ts
  src/checked-integer.ts
  src/canonical-json.ts
  src/model.ts
  src/manifest-schema.ts
  src/graph-adapter.ts
  src/header.ts
  src/access-unit-index.ts
  src/layout.ts
  src/reference-frame.ts
  src/parser.ts
  src/writer.ts
  src/index.ts
  test/*.test.ts
fixtures/conformance/m4/
```

## Commit Boundary

Commit the M4 design and this plan before runtime code. Commit the package,
fixtures, tests, evidence, root workspace/reference changes, and lockfile only
after the complete M4 and repository gates pass. Keep compiler, player
integration, H.264 inspection, full PNG validation, digest verification, and
network loading out of this commit.
