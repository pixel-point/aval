# M5 Opaque AVC Compiler and Dedicated Worker Implementation Plan

**Date:** 2026-07-11

**Design:** [M5 Opaque AVC Compiler and Dedicated Worker Design](../specs/2026-07-11-m5-opaque-avc-compiler-worker-design.md)

## Outcome

Add a deterministic Node compiler for the M4 container's opaque AVC profile,
one shared pure Annex B inspector, required compiler-generated static PNGs and
digests, deterministic source-pixel continuity reports, and a dedicated-worker
WebCodecs primitive that decodes inspected units continuously. Keep graph
scheduling in M5.5 and authoring polish in M8.

## Engineering Rules

- Write failing tests before each production slice.
- Reuse M4 public types, writer, parser, graph adapter, budgets, and layout; do
  not import M4 private modules or reproduce compiled-format validation.
- Format's `avc/` extension stays pure ES2023. `compiler` stays Node-only. The
  worker stays WebWorker-only and owns no graph, loader, renderer, or scheduler
  state.
- Every hostile byte/path/process boundary returns a stable domain error;
  built-in exceptions do not escape public APIs.
- Check counts and byte products before allocation or traversal.
- Never invoke a shell, remote protocol, downloader, or bundled encoder.
- Close every child process, stream, handle, timer, decoder, and `VideoFrame`
  on success, failure, cancellation, and disposal.
- Do not commit until the complete M5 gate, real FFmpeg run, and supported AVC
  worker run are recorded.

## Execution Order

### 1. Establish package and TypeScript boundaries

Add:

```text
packages/format/src/avc/index.ts

packages/compiler/package.json
packages/compiler/tsconfig.json
packages/compiler/tsconfig.test.json
packages/compiler/src/index.ts
packages/compiler/src/cli.ts

packages/player-web/tsconfig.worker.json
packages/player-web/src/decoder-worker/protocol.ts
packages/player-web/src/decoder-worker/core.ts
packages/player-web/src/decoder-worker/client.ts
packages/player-web/src/decoder-worker/host.ts
packages/player-web/src/decoder-worker/entry.ts
```

Add workspace/project references and root build order:

```text
graph → format (including avc)
format → compiler
format → player-web
all libraries → playground
```

Give `@rendered-motion/compiler` a provisional private `rma` bin entry. Add
compile-only declaration tests proving that format's AVC exports have no
Node/DOM/WebCodecs types, compiler public types have no DOM/WebCodecs types,
and the worker source has no `Window` or Node ambient types. Preserve format's
sole production dependency on graph.

Gate:

```text
npm run typecheck
npm run build -w @rendered-motion/format
npm run build -w @rendered-motion/compiler
npm run build -w @rendered-motion/player-web
```

### 2. Freeze errors, options, budgets, and checked primitives

Add focused modules instead of one compiler utility file:

```text
packages/format/src/avc/failure.ts
packages/format/src/avc/bit-reader.ts
packages/format/src/avc/types.ts
packages/compiler/src/errors.ts
packages/compiler/src/options.ts
packages/compiler/src/diagnostic.ts
packages/compiler/src/abort.ts
packages/compiler/src/checked-size.ts
```

Extend M4's immutable `FormatError` `PROFILE_INVALID` paths for AVC, and define
immutable `CompilerError` plus worker error codes; lower-only budgets; checked
integer/byte/bit arithmetic; bounded diagnostic sanitization; and cancellation
normalization. Test safe-integer edges, overflow, throwing proxies, unknown
options, frozen results, terminal-control input, and that public entry points
leak no built-in exception.

Do not add generic `utils.ts` or a cross-domain error hierarchy.

### 3. Implement the duplicate-aware source parser and exact schema

Add:

```text
packages/compiler/src/project-json.ts
packages/compiler/src/project-model.ts
packages/compiler/src/project-schema.ts
packages/compiler/src/project-relations.ts
packages/compiler/src/project-normalize.ts
packages/compiler/test/project-json.test.ts
packages/compiler/test/project-schema.test.ts
packages/compiler/test/project-hostile.test.ts
```

Export format's existing bounded `parseStrictJson`,
`serializeCanonicalJson`, and immutable JSON value types from its root, then
implement the closed schema in Design Section 4. Reuse public M4 model types
where they are structurally authoritative, but give source-only fields their
own types. Normalize source arrays without requiring author sorting. Build a
temporary `CompiledManifestInputV01` with structurally valid placeholder-free
derived values only after project/media planning, then let M4 validate the
complete result. Do not implement another JSON tokenizer, writer, UTF-8
decoder, or dangerous-key detector in compiler.

Tests cover every object/union key set, duplicate/dangerous keys, IDs, UTF-8,
ranges, array order normalization, graph/unit-use relations, all M4 maxima,
aspect/multiple-of-16 constraints, source/rendition use, lower budgets, and
semantic-equivalence normalization. Reject every compiled-only field at the
project boundary.

### 4. Implement secure path and atomic-output ownership

Add:

```text
packages/compiler/src/local-path.ts
packages/compiler/src/source-resolver.ts
packages/compiler/src/temp-workspace.ts
packages/compiler/src/atomic-output.ts
packages/compiler/test/local-path.test.ts
packages/compiler/test/temp-workspace.test.ts
packages/compiler/test/atomic-output.test.ts
```

Resolve real roots/files, constrain the PNG `%0Nd` form, enumerate sequence
files, reject non-regular inputs and symlink escapes, and create mode-0700 temp
directories. Make cleanup idempotent and non-symlink-following. Publish the
validated asset atomically and the build report without ever exposing a
partial asset.

Test absolute/project-relative edge cases, `..`, mixed separators, NUL, URL
schemes, devices, FIFOs, sockets, nested symlink escapes, output symlinks,
existing destinations, rename/fsync failures, cancellation at every step, and
cleanup after simulated process crashes.

### 5. Build the FFmpeg capability probe and process runner

Add:

```text
packages/compiler/src/tool-resolver.ts
packages/compiler/src/ffmpeg-capability.ts
packages/compiler/src/process-runner.ts
packages/compiler/src/ffmpeg-argv.ts
packages/compiler/src/provenance.ts
packages/compiler/test/tool-resolver.test.ts
packages/compiler/test/process-runner.test.ts
packages/compiler/test/ffmpeg-argv.test.ts
packages/compiler/test/provenance.test.ts
```

Resolve/fingerprint FFmpeg and FFprobe, parse bounded version/configuration and
encoder lists, require `libx264`, and implement the exact ordered argv owners
for probe, decode, scale, and encode. Spawn with `shell: false`, minimal locale
environment, protocol/demuxer allowlists, `-max_alloc`, one thread, bounded
analyze/probe/frames/queues, pipe counters, wall/CPU limits, process-group
termination, and optional platform aggregate-memory limiting.

Use a fake child adapter for exhaustive tests. Snapshot exact argv/environment
for spaces, quotes, leading dashes, Unicode, and option-looking file names.
Prove no project value becomes a flag, stderr cannot exceed its cap, timeout
kills descendants, abort escalates after one second, and every stream/timer is
released. Add a real read-only capability test behind the explicit tool-backed
test gate.

### 6. Parse exact media timing and plan normalized frames

Add:

```text
packages/compiler/src/rational.ts
packages/compiler/src/media-probe.ts
packages/compiler/src/frame-timing.ts
packages/compiler/src/frame-selection.ts
packages/compiler/src/source-plan.ts
packages/compiler/test/rational.test.ts
packages/compiler/test/media-probe.test.ts
packages/compiler/test/frame-timing.test.ts
packages/compiler/test/frame-selection.test.ts
```

Parse FFprobe rationals without floating point. Validate one progressive,
square-pixel, zero-rotation allowlisted video stream, dimensions/duration/frame
count, and exact CFR timestamps. Implement the Section 5.3 hold-last
normalizer and bounded duplicate/drop report. Interpret project unit ranges
only after normalized counts exist; precompute unique source frames and spool
bytes before starting decode.

Table-test reduced rates including 24/1, 25/1, 30/1, 30000/1001, 50/1,
60000/1001, and 60/1; first-PTS offsets; missing/repeated/decreasing/off-grid
PTS; final durations; exact boundary ties; duplicate/drop sets; 30-second and
1,800-frame edges; and source range changes after normalization.

### 7. Implement the bounded canonical RGBA spool

Add:

```text
packages/compiler/src/rgba-frame.ts
packages/compiler/src/rgba-spool.ts
packages/compiler/src/source-decoder.ts
packages/compiler/src/opaque-scan.ts
packages/compiler/test/rgba-spool.test.ts
packages/compiler/test/source-decoder.test.ts
packages/compiler/test/opaque-scan.test.ts
```

Run the native-resolution minimum-alpha audit for referenced frames before
scale, locate a failure with one capped targeted alpha-plane read, then stream
fixed-size canvas RGBA frames from the runner. Retain at most two canonical
frames in memory, write only referenced normalized frames into fixed slots,
and expose abortable exact reads for encoder/static consumers. Scan every
retained frame for alpha 255 again before publication. Enforce the 1 GiB spool
preflight and actual write cap.

Test chunk splits at every pixel-byte boundary, short and extra output,
probe/decode count mismatch, randomized frame-selection fanout, repeated range
references, transparency that downscaling would otherwise hide, first/last
translucent pixel, exact coordinate diagnostics, write/read/cancel failures,
cap crossing before spawn, and cleanup with open readers.

### 8. Implement the pure Annex B and RBSP core

Add:

```text
packages/format/src/avc/annex-b.ts
packages/format/src/avc/bit-reader.ts
packages/format/test/avc-annex-b.test.ts
packages/format/test/avc-bit-reader.test.ts
```

Implement bounded start-code scanning, NAL headers, four-byte normalization,
emulation-prevention removal, and checked fixed/Exp-Golomb reads. Results are
detached numeric metadata/ranges; returned objects do not retain mutable input
views.

Golden and hostile tests cover 3/4-byte prefixes, adjacent/empty NALs, leading
and trailing zeros/garbage, forbidden bits, every truncation, emulation bytes,
overlong Golomb prefixes, byte/bit budget edges, mutation fuzzing, caller
buffer mutation after parse, and built-in exception containment.

### 9. Implement SPS, PPS, slice, and unit inspection

Add:

```text
packages/format/src/avc/parameter-sets.ts
packages/format/src/avc/slice-header.ts
packages/format/src/avc/inspector.ts
packages/format/src/avc/index.ts
packages/format/test/avc-parameter-sets.test.ts
packages/format/test/avc-slice-header.test.ts
packages/format/test/avc-inspector.test.ts
packages/format/test/avc-mutation-fuzz.test.ts
```

Parse exactly the frozen fields from Design Section 9. Validate codec/profile/
level, dimensions/crop, VUI timing/color/range, level limits, PPS settings,
AUD/VCL grammar, I then P slice sequence, frame numbers, one slice, key flags,
and unit independence. Expose batch compiler and incremental worker APIs that
share the same field validators and state transitions.

Export only frozen inspector input/result types plus strict and candidate
entry points from `packages/format/src/index.ts`. Keep NAL/RBSP views, bit
readers, parsed parameter sets, and canonicalization helpers private. Extend
format's public declaration test to preserve its platform-free boundary.

Add strict and separately named encoder-candidate inspection entry points. The
candidate entry point permits SPS `42 C0 20` or `42 E0 20` but still proves
every stricter-subset invariant; the normal public/worker path requires exact
`E0`. No inspection mode permits another SPS, PPS, or VCL relaxation.

Create small hand-authored bit fixtures plus actual normalized x264 fixtures.
Mutate every parsed field and every byte boundary. Explicitly reject high/main
profile, level escalation, odd/interlaced/cropped surprises, full range,
wrong timing/color, multiple refs, entropy coding, slice groups, B/SP/SI,
multiple slices, repeated/missing SPS/PPS/AUD, later IDR, frame gaps/wrap
errors, cross-unit state, false key flags, oversized unit/NAL/RBSP, and unknown
NAL types. Golden-test unchanged `42 E0 20`, strict rejection of unnormalized
`C0`, candidate acceptance of conforming `42 C0 20`, and rejection of every
other compatibility byte.

### 10. Encode and inspect every opaque rendition/unit

Add:

```text
packages/compiler/src/avc-encode-plan.ts
packages/compiler/src/avc-encoder.ts
packages/compiler/src/avc-samples.ts
packages/compiler/src/avc-constraint-normalize.ts
packages/compiler/test/avc-encode-plan.test.ts
packages/compiler/test/avc-encoder.test.ts
packages/compiler/test/avc-constraint-normalize.test.ts
```

Freeze level preflight and bitrate/VBV formulas. For every canonical
rendition/unit pair, stream its RGBA range to a fresh single-thread libx264
process, remove only allowed SEI, normalize start codes, inspect the complete
unit, perform the allowed proven SPS constraint-bit normalization when needed,
strictly reinspect, split access units from the final inspector result, and
derive M4 key flags. Reject output before hashing if either inspection fails.

Golden-test that normalization changes exactly the constraint-set2 bit in each
SPS that needs it, leaves exact `E0` unchanged, changes no PPS/VCL bytes,
reinspects the normalized rendition, and records the operation in provenance.

The fake-runner suite proves process-per-pair ordering, exact input frame bytes,
no cross-unit state, bounded output, cancellation, sparse/extra output, and
inspector-derived—not runner-asserted—samples. The real tool suite checks one
unit of every kind, multiple renditions, a one-frame finite unit, M4 maximum
frame counts, and deliberate incompatible x264 arguments/outputs.

### 11. Generate deterministic static PNGs

Add:

```text
packages/compiler/src/crc32.ts
packages/compiler/src/adler32.ts
packages/compiler/src/stored-deflate.ts
packages/compiler/src/static-png.ts
packages/compiler/src/static-plan.ts
packages/compiler/test/checksums.test.ts
packages/compiler/test/stored-deflate.test.ts
packages/compiler/test/static-png.test.ts
packages/compiler/test/static-plan.test.ts
```

Implement the exact signature/IHDR/sRGB/single-IDAT/IEND writer with filter-0
rows and deterministic stored DEFLATE. Generate each poster from its optional
source/frame selector or, when omitted, state-body frame zero; deduplicate byte-
identical posters by lexicographically first state. Validate the result through
M4's writer/full-asset path; do not add a browser PNG decoder in M5.

Test standard checksum vectors, stored-block sizes at 65,535 transitions,
every PNG chunk byte, 16×16 through 512×512 dimensions, noisy worst-case size,
all-alpha-255 preservation, input immutability, deterministic deduplication,
custom poster selection, default body-entry selection, shared static
references, and the 2 MiB/static plus 32 MiB/file caps.

### 12. Compute deterministic visual-continuity reports

Add:

```text
packages/compiler/src/compile/seam-analysis.ts
packages/compiler/src/compile/continuity-report.ts
packages/compiler/test/seam-analysis.test.ts
packages/compiler/test/continuity-report.test.ts
```

Implement Design Section 11's linear-light premultiplied RGBA difference,
eight-neighbor p95 window, independent alpha metric, duplicate-boundary flag,
and loop/composed-edge boundary planner. Produce machine-readable `pass | cut`
results from source pixels before encoding. A non-cut heuristic failure is
`CONTINUITY_FAILED` and publishes no asset; a genuinely static loop remains a
valid pass. Do not alter frames, generate optical flow/heatmaps, or add M8
visualization.

Golden-test steady motion, obvious jumps, identical endpoints, short units
with fewer neighbors, loop wrap, portal/finish with and without a bridge,
forward/inverse reversible endpoints, cut classification, alpha math, source
range offsets, traversal-order determinism, and checked dimension/frame-byte
bounds.

### 13. Own compiler digests and resource estimates

Add:

```text
packages/compiler/src/digest.ts
packages/compiler/src/resource-estimate.ts
packages/compiler/src/manifest-lowering.ts
packages/compiler/test/digest.test.ts
packages/compiler/test/resource-estimate.test.ts
packages/compiler/test/manifest-lowering.test.ts
```

Hash exact AU concatenations and PNG bytes, populate every M4 digest before
writing, derive readiness/fallback/profile/capabilities/sample-free unit input,
and calculate checked resource formulas from Design Section 12. Never accept a
project-provided digest, limit, sample count, or readiness list.

Test multi-chunk hash equivalence, padding exclusion, byte-order sensitivity,
shared poster scope, all formula terms including total encoded bytes for the
largest rendition, checked overflow, 64 MiB rejection, minimal readiness for
initial edges, all compiled arrays/strings, and that M4 rejects an intentionally
corrupted lowering.

### 14. Orchestrate deterministic compilation and post-write verification

Add:

```text
packages/compiler/src/compile.ts
packages/compiler/src/build-report.ts
packages/compiler/src/post-write-verify.ts
packages/compiler/test/compile.test.ts
packages/compiler/test/determinism.test.ts
packages/compiler/test/post-write-verify.test.ts
```

Connect the validated stages, call only M4's public `writeCanonicalAsset` and
`validateCompleteAsset`, recompute final unit/static digests from returned
ranges, compute whole-file SHA-256, serialize canonical provenance, and return
immutable bytes/report before atomic publication.

Golden tests compile semantically reordered projects repeatedly, from moved
roots and after temp deletion, and require byte identity. Corrupt every final
payload class between write and verification. Abort between every stage and
assert no subsequent stage runs. Ensure asset bytes contain no absolute path,
date, temp name, executable path, host, source metadata, or report-only value.

### 15. Implement CLI commands without M8 polish

Add:

```text
packages/compiler/src/cli-args.ts
packages/compiler/src/cli-output.ts
packages/compiler/src/commands/compile.ts
packages/compiler/src/commands/inspect.ts
packages/compiler/src/commands/validate.ts
packages/compiler/src/commands/unpack.ts
packages/compiler/src/commands/init.ts
packages/compiler/src/commands/dev.ts
packages/compiler/test/cli.test.ts
packages/compiler/test/commands.test.ts
```

Implement the exact Design Section 14 grammar, direct-input synthetic project,
exit statuses, canonical JSON mode, validation claim labels, safe unpack names,
minimal generated init project, and single-flight watcher. Keep UI prompts,
HTTP serving, playground panels, framework examples, artwork, heatmaps, and
diagnostic-copy polish out of M5.

Run every command through a programmatic entry point with captured IO. Test all
flag combinations, missing/duplicate/unknown flags, leading-dash paths,
existing/symlink outputs, direct video/PNG lowering, `--fps` normalization,
inspect frame/time output, validate exit mapping, safe unpack, init identity,
watch abort/coalescing, signals/130, canonical JSON diagnostics, and terminal
sanitization.

### 16. Freeze the worker protocol and fake-decoder core

Add:

```text
packages/player-web/src/decoder-worker/protocol.ts
packages/player-web/src/decoder-worker/core-validation.ts
packages/player-web/src/decoder-worker/core.ts
packages/player-web/src/decoder-worker/decoder-worker.test.ts
```

Implement closed message cloning, one configure, monotonic request/sample IDs,
timestamps and generation tokens, implicit contiguous unit-instance grammar,
configure-time AVC profile validation, shared incremental AVC inspection,
pending/submitted/leased credit accounting, explicit frame release, expected
output FIFO, cumulative limits, snapshots, and idempotent disposal behind
injectable decoder/postMessage/timer adapters.

Generation is only stale-output and frame-lifecycle ownership. This step must
not choose generations from graph state, select a unit path, calculate a
submission horizon, or decide readiness; those policies remain M5.5.

Fake-decoder tests cover every invalid state transition and unknown field,
detached/oversized buffers, generation activation/abort and stale outputs,
credit exhaustion/races, missing/double/unknown frame release, decode throw,
decoder error, out-of-order/extra/missing/wrong-dimension/wrong-color output,
output after failure, transfer throw, watchdog progress/reset, dispose at every
phase, zero reset/flush calls, frame closure, and all pending-promise
settlements.

### 17. Add the real dedicated worker and main-thread client

Implement:

```text
packages/player-web/src/decoder-worker/host.ts
packages/player-web/src/decoder-worker/client.ts
packages/player-web/src/decoder-worker/entry.ts
```

Configure `VideoDecoder` only after exact worker-side support probing, construct
`EncodedVideoChunk` from inspector-derived type/timestamps, transfer validated
frames, and expose an abortable low-level client matching configure,
activate-generation, submit-batch, abort-generation, release-frame, snapshot,
and dispose. The client checks credit before transferring sample ownership,
wraps every frame in a close-once managed handle, and releases worker credit
only after closing the transferred frame.

Do not connect graph, loader, renderer, or M2 experimental player code. Export
only the protocol/client factory and stable errors needed by M5.5.

### 18. Add compiler and worker conformance fixtures

Add:

```text
fixtures/compiler/m5/source/
fixtures/conformance/m5/opaque-loop.rma
fixtures/conformance/m5/opaque-path.rma
fixtures/conformance/m5/provenance.json
fixtures/conformance/m5/README.md
packages/compiler/test/tool-backed.test.ts
tests/browser/m5-opaque-avc-worker.spec.ts
```

Keep source fixtures tiny and licensed/generated. Produce one two-frame loop
and one multi-unit path fixture with the reviewed compatible FFmpeg build.
Normalize provenance by removing local absolute paths while retaining tool
digests/version/configuration and exact argv templates. Document source,
project, unit, static, and whole-file SHA-256 values.

Tool-backed tests require explicit tool availability and never download tools.
Browser tests gate on exact codec support, record unsupported honestly, and in
a supported browser run 1,001 loop iterations plus intro/body/bridge/target in
one dedicated worker. Instrument the decoder adapter to prove zero seam-time
  configure/reset/flush/seek/EOS; configure is exactly one and reset/flush are
  exactly zero for the complete run.

### 19. Run adversarial, maintainability, and repository gates

Run focused seeded mutation/property tests before the complete repository:

```text
npx vitest run packages/format/test/avc-*.test.ts
npx vitest run packages/compiler/test
npm run typecheck
npm run test:unit
npm run build
npm run test:browser
npm audit --audit-level=high
npm pack --dry-run -w @rendered-motion/format
npm pack --dry-run -w @rendered-motion/compiler
git diff --check
```

Run the tool-backed compiler suite with the recorded local FFmpeg/FFprobe and
the worker suite in one exact-AVC-supported browser. A VP8 pass or unsupported
Chromium result cannot substitute for this gate.

Perform two read-only audits:

1. contract/security: exact M4 use, no untrusted derived fields, path/protocol/
   process bounds, inspector completeness, cleanup, buffer/frame ownership,
   and honest claim labels; and
2. maintainability: no giant orchestrator/schema/parser/worker files, no
   duplicated AVC parsing, FFmpeg argv, timing selection, digest, static PNG,
   or protocol state logic.

Resolve every blocking finding and rerun the affected focused and full gates.

### 20. Record evidence and commit M5

Write:

```text
docs/evidence/2026-07-11-m5-opaque-avc-compiler-worker.md
```

Record:

- environment and package/tool/browser versions;
- FFmpeg/FFprobe executable digests, configuration, `libx264` capability, and
  memory-limit mode;
- exact unit, fuzz, compiler, and browser test counts;
- source/project/unit/static/asset fixture digests;
- byte-determinism comparison results;
- 1,001-iteration worker ordering and decoder-operation counts;
- unsupported-browser results without promotion to conformance;
- timeout/cancellation/temp/process/decoder/frame cleanup evidence;
- pack/audit/diff results; and
- explicit M5 versus M5.5/M6/M7/M8 claim boundary.

Commit the implementation as one intentional M5 change only after every gate
passes. Do not include `dist`, temp spools, local executables, machine-specific
reports, unrelated worktree changes, scheduler integration, packed alpha, or
authoring UI.

## Planned Production Files

```text
packages/format/src/avc/
  index.ts
  failure.ts
  types.ts
  bit-reader.ts
  annex-b.ts
  parameter-sets.ts
  slice-header.ts
  inspector.ts

packages/compiler/src/
  index.ts
  cli.ts
  cli-args.ts
  cli-output.ts
  errors.ts
  options.ts
  diagnostic.ts
  abort.ts
  checked-size.ts
  project-json.ts
  project-model.ts
  project-schema.ts
  project-relations.ts
  project-normalize.ts
  local-path.ts
  source-resolver.ts
  temp-workspace.ts
  atomic-output.ts
  tool-resolver.ts
  ffmpeg-capability.ts
  process-runner.ts
  ffmpeg-argv.ts
  provenance.ts
  rational.ts
  media-probe.ts
  frame-timing.ts
  frame-selection.ts
  source-plan.ts
  rgba-frame.ts
  rgba-spool.ts
  source-decoder.ts
  opaque-scan.ts
  avc-encode-plan.ts
  avc-encoder.ts
  avc-samples.ts
  avc-constraint-normalize.ts
  crc32.ts
  adler32.ts
  stored-deflate.ts
  static-png.ts
  static-plan.ts
  compile/seam-analysis.ts
  compile/continuity-report.ts
  digest.ts
  resource-estimate.ts
  manifest-lowering.ts
  compile.ts
  build-report.ts
  post-write-verify.ts
  commands/compile.ts
  commands/inspect.ts
  commands/validate.ts
  commands/unpack.ts
  commands/init.ts
  commands/dev.ts

packages/player-web/src/decoder-worker/
  protocol.ts
  core-validation.ts
  core.ts
  host.ts
  client.ts
  entry.ts
```

This file list is a responsibility map, not permission to create large files.
If a module crosses one domain or becomes difficult to review, split it before
the maintainability gate while keeping its public owner unchanged.
