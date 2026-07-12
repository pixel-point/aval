# M7 Loader, Integrity, and Resource Manager Implementation Plan

**Date:** 2026-07-12

**Design:** [M7 Loader, Integrity, and Resource Manager Design](../specs/2026-07-12-m7-loader-integrity-resource-manager-design.md)

## Outcome

Extend the committed M6 web runtime from one completely resident asset to one
bounded URL/full-memory catalog path with exact HTTP range/entity rules,
internal and optional external SHA-256 enforcement, shared page decoder/memory
leases, decoded-static eviction, visibility suspension/rebuild, WebGL context
recovery, and terminal cleanup evidence. Preserve the compiled wire format at
`0.1` and preserve one downstream graph/scheduler/worker/renderer path.

M6 must be gated and committed before production implementation begins. M7 is
one later intentional milestone commit after its complete evidence gate passes.

## Engineering Rules

- Write a failing focused test before every production slice.
- Keep compiled format `0.1`; transport and page policy never enter the
  manifest or writer.
- Keep `@rendered-motion/format` platform-free. Fetch, streams, Web Crypto,
  DOM visibility, canvas context events, and page resources live only in
  `@rendered-motion/player-web` or the browser proof.
- Use the existing `parseHeader()`, `parseFrontIndex()`, canonical layout, and
  `validateCompleteAsset()`; do not add a second header/index parser.
- Only complete digest-bearing unit/static blobs enter persistent cache.
- Never call `arrayBuffer()` or `blob()` on an untrusted response body.
- Never parse externally integrity-gated bytes before the complete external
  digest succeeds.
- Never combine responses without one exact final URL, total, strong ETag, and
  generation; never use `Last-Modified` as a partial validator.
- Reserve bytes/decoder capacity before allocation. Release the reservation if
  allocation or construction fails.
- Keep at most four active payload bodies per asset, one decoder per player,
  two decoder leases per default page, 64 MiB logical bytes per player, and
  192 MiB physical bytes per default page.
- Close/cancel/release every reader, timer, abort listener, quarantine buffer,
  worker transfer, frame, bitmap, worker, decoder, texture, buffer, callback,
  context listener, lease, waiter, and participant on every terminal path.
- Keep the current static surface covered until a replacement static or a
  fully prepared first animated frame has drawn.
- Keep manager victim selection deterministic and never preempt equal-priority
  visible animation for a new requester.
- Keep production files focused by authority. Do not create a giant loader,
  resource manager, or lifecycle coordinator.
- Preserve the owned complete-byte API as an adapter over the sparse catalog;
  do not maintain network and memory scheduler implementations.
- Do not add M8 custom-element/automatic observer behavior or M9 certification.
- Do not commit generated `dist`, Playwright traces, browser caches, absolute
  paths, response bodies, ETags, or credentials in evidence.

## Execution Order

### 1. Freeze M7 public/internal types and stable failures

Update:

```text
packages/player-web/src/runtime/errors.ts
packages/player-web/src/runtime/model.ts
packages/player-web/src/runtime/public-api.compile.ts
packages/player-web/src/index.ts
```

Add closed immutable contracts for:

- `RuntimeAssetRequest`, normalized external integrity, and loader policy;
- entity identity and range/full transport modes;
- metadata/blob residency snapshots;
- page policy, participant state, byte categories, byte leases, decoder
  tickets/leases, reclamation reasons, and manager snapshots;
- visibility/suspension and context-recovery snapshots; and
- loader/resource diagnostics with numeric bounded context.

Extend `StaticReason` with the transient values `visibility-suspended` and
`decoder-queued`. Add an explicit transient/sticky classification so only those
two values can automatically re-enter animation in M7; do not make generic
resource or integrity failure retry in a loop.

Add stable runtime codes `load-failure`, `range-response-invalid`,
`entity-changed`, `integrity-mismatch`, and `context-loss`. Retain the existing
resource/watchdog/abort/fallback codes. Extend structured context with bounded
request ordinal, HTTP status, expected/observed bytes, declared total,
player/page totals, and lifecycle phase. Never retain URL, ETag, response
header values, or body text in a failure.

Keep browser-native objects behind injectable interfaces in core contracts so
the public declaration surface exposes only the intended web types. Add
compile-only hostile examples proving unknown request/policy fields, mutable
snapshots, weak integrity syntax, and direct lease construction are rejected.

Run:

```text
npx vitest run packages/player-web/src/runtime/model.test.ts
npm run typecheck -w @rendered-motion/player-web
```

### 2. Implement exact HTTP header grammar

Create:

```text
packages/player-web/src/runtime/http-content-range.ts
packages/player-web/src/runtime/http-content-range.test.ts
packages/player-web/src/runtime/http-entity-tag.ts
packages/player-web/src/runtime/http-entity-tag.test.ts
packages/player-web/src/runtime/http-response-contract.ts
packages/player-web/src/runtime/http-response-contract.test.ts
```

Implement one checked parser each for:

- canonical `bytes S-E/T` with concrete safe integers;
- one strong quoted ETag and exact normalized equality;
- absent-or-single-`identity` content encoding;
- canonical `Content-Length`; and
- status/final-URL/common response validation.

The exact range validator takes the requested inclusive range and optional
known total. It rejects wildcard, multipart/list, leading-zero, overflow,
wrong start/end/count/total, internal-whitespace, and suffix forms. The ETag
parser treats a weak/missing tag as unavailable during the first partial
response and as entity change after pinning. Keep header access behind a small
`RuntimeHeadersView` for deterministic fakes.

Test every grammar boundary and adversarial accessor. Property-test generated
decimal values around zero, `Number.MAX_SAFE_INTEGER`, requested boundaries,
and comma/whitespace insertions.

Run:

```text
npx vitest run packages/player-web/src/runtime/http-content-range.test.ts packages/player-web/src/runtime/http-entity-tag.test.ts packages/player-web/src/runtime/http-response-contract.test.ts
```

### 3. Build the bounded abortable response-body reader

Create:

```text
packages/player-web/src/runtime/bounded-body-reader.ts
packages/player-web/src/runtime/bounded-body-reader.test.ts
packages/player-web/src/runtime/load-watchdogs.ts
packages/player-web/src/runtime/load-watchdogs.test.ts
```

Implement known-exact and bounded-unknown body modes over one injected stream
reader. Check chunk type, non-empty progress, cumulative length, expected EOF,
and cap before copying. Known bodies allocate exactly once after a transient
lease. Unknown bodies reserve each retained chunk and the final compact copy;
record/release the charged double-residency peak.

Implement overall, first-byte, and idle-body watchdogs with an injected timer
host. Reset idle only after accepting non-empty bytes. Link caller/session
abort without retaining listeners. On every failure, cancel and await the
reader, clear timers, release buffers/leases, and reject through one normalized
error. A late read releases rather than publishes.

Tests cover absent body, zero/empty chunks, truncation, one-byte overflow,
oversized `Content-Length`, chunk-reader rejection, cancel rejection, abort at
every await, stalled headers/body, late completion, exact-cap success, and
terminal zero counters.

Run:

```text
npx vitest run packages/player-web/src/runtime/bounded-body-reader.test.ts packages/player-web/src/runtime/load-watchdogs.test.ts
```

### 4. Add SHA-256 and external-integrity primitives

Create:

```text
packages/player-web/src/runtime/sha256-verifier.ts
packages/player-web/src/runtime/sha256-verifier.test.ts
packages/player-web/src/runtime/external-integrity.ts
packages/player-web/src/runtime/external-integrity.test.ts
```

Wrap Web Crypto behind an injected `digestSha256()` adapter. Decode internal
lowercase hexadecimal and external canonical standard Base64 into exact
32-byte arrays. Compare by full XOR accumulation. Parse only the exact
`sha256-<44 canonical Base64 chars>` host syntax.

Make verifier operations generation-aware and abort-aware even though Web
Crypto itself cannot always be canceled: stale completion releases its input
lease and never promotes bytes. Do not implement or import a second SHA-256
algorithm.

Tests use official known-answer vectors, empty and maximum bounded inputs,
every malformed alphabet/padding/whitespace/token case, first/middle/last-byte
mismatch, digest rejection, abort before/during completion, and no early
promotion.

Run:

```text
npx vitest run packages/player-web/src/runtime/sha256-verifier.test.ts packages/player-web/src/runtime/external-integrity.test.ts
```

### 5. Implement the entity-pinned header/front-index loader

Create:

```text
packages/player-web/src/runtime/asset-fetch-contracts.ts
packages/player-web/src/runtime/range-asset-session.ts
packages/player-web/src/runtime/range-asset-session.test.ts
packages/player-web/src/runtime/full-asset-fetch.ts
packages/player-web/src/runtime/full-asset-fetch.test.ts
```

Use one Fetch adapter, one session controller, and one operation generation.
Implement:

1. exact `Range: bytes=0-63` startup;
2. strict initial `206`, total/header equality, final-URL pin, and strong-ETag
   capture;
3. exact `[64, frontIndexEnd)` with `If-Range`;
4. bounded initial `200` as a standalone complete entity;
5. one no-validator restart through a range-free bounded `200`;
6. later `200` replacement only with unchanged pinned final URL/strong ETag;
7. entity-change rejection for changed/missing validators after pinning; and
8. deliberate full-request rejection of `206`.

Combine only the exact prefix after both responses pass. Call the existing
format parsers and translate their bounded errors without losing codes. Pin no
untrusted response object beyond its body operation. Cap active payload bodies
at four, though metadata startup remains sequential.

Tests assert exact Fetch calls/headers and cover every status, opaque response,
network error, URL change, total change, strong/weak/missing/malformed ETag,
ignored range, encoding, declared/observed body length, restart-loop, format
header, and front-index failure. Every rejection must show canceled readers,
cleared timers, and released transient leases.

Run:

```text
npx vitest run packages/player-web/src/runtime/range-asset-session.test.ts packages/player-web/src/runtime/full-asset-fetch.test.ts
```

### 6. Plan canonical payload storage ranges and assembly

Create:

```text
packages/player-web/src/runtime/blob-range-plan.ts
packages/player-web/src/runtime/blob-range-plan.test.ts
packages/player-web/src/runtime/blob-assembly.ts
packages/player-web/src/runtime/blob-assembly.test.ts
```

Consume only `ParsedFrontIndex.unitBlobs`, `.staticBlobs`, and canonical file
geometry. Associate each blob with its immediately preceding alignment padding
without changing `@rendered-motion/format`. Sort by canonical offset, validate
checked coverage, coalesce adjacent requested storage spans up to the 4 MiB
target, and split larger legal spans into bounded exact requests.

Assemble out-of-order response segments into one exact quarantined blob while
validating zero padding and prohibiting overlap, holes, duplicate completion,
or cross-generation input. Hash/promote each descriptor independently even
when transport ranges were coalesced.

Property tests generate legal canonical layouts and hostile interval sets.
Assert deterministic plans, complete coverage, maximum request size (except an
indivisible read is still split), zero-padding enforcement, exact peak byte
accounting, and release on missing/duplicate/late segments.

Run:

```text
npx vitest run packages/player-web/src/runtime/blob-range-plan.test.ts packages/player-web/src/runtime/blob-assembly.test.ts
```

### 7. Refactor the asset catalog into metadata plus verified residency

Refactor/update:

```text
packages/player-web/src/runtime/asset-catalog.ts
packages/player-web/src/runtime/asset-catalog-index.ts
packages/player-web/src/runtime/asset-catalog.test.ts
packages/player-web/src/runtime/resource-plan.ts
packages/player-web/src/runtime/resource-plan.test.ts
```

Create:

```text
packages/player-web/src/runtime/verified-blob-store.ts
packages/player-web/src/runtime/verified-blob-store.test.ts
packages/player-web/src/runtime/runtime-asset-session.ts
packages/player-web/src/runtime/runtime-asset-session.test.ts
```

Keep metadata lookup behavior immutable and synchronous. Add `absent`,
`loading`, and `verified` blob state with shared same-session waiters. Add
asynchronous ensure operations for one static, all statics, one unit, and all
units of one rendition. Only digest-passed exact bytes receive persistent
leases. Strictly validate static PNG structure before marking it available to
the static decoder.

Make `copySample()` legal only for a verified containing unit and preserve one
fresh transfer-owned copy. Make `copyStaticPng()` legal only for a verified
static. Add exact residency/byte snapshots and eviction of animation blobs
only after their worker/sample owners retire.

Convert the current complete-byte constructor into a `validateCompleteAsset()`
adapter that pre-promotes its blobs through the same store without copying
every blob again. Reconcile the resource plan with dynamic actual residency,
front-index/full ownership, transient transfer bytes, and already frozen M6
PNG/GPU terms. There must be one catalog lookup and one candidate path.

Tests cover concurrent waiters, waiter-only abort, session abort, retry after
transport failure, corruption never promoted, sample boundaries, mutation
isolation, disposal, in-memory compatibility, exact dynamic bytes, and no
complete-file-sized allocation in range mode.

Run:

```text
npx vitest run packages/player-web/src/runtime/asset-catalog.test.ts packages/player-web/src/runtime/verified-blob-store.test.ts packages/player-web/src/runtime/runtime-asset-session.test.ts packages/player-web/src/runtime/resource-plan.test.ts
```

### 8. Enforce internal digests before cache and media use

Update:

```text
packages/player-web/src/runtime/runtime-asset-session.ts
packages/player-web/src/runtime/integrated-player-static-preparation.ts
packages/player-web/src/runtime/integrated-animated-preparation.ts
packages/player-web/src/runtime/worker-samples.ts
packages/player-web/src/runtime/static-surfaces.ts
```

Wire payload assembly through SHA-256 before `VerifiedBlobStore.promote()`.
Prioritize the requested static, then all other statics, bootstrap units, and
remaining selected-rendition units. Ensure candidate inspection, worker sample
copying, and strict PNG decode accept only verified handles rather than raw
arrays.

Preserve `metadataReady` -> `visualReady` -> `interactiveReady/staticReady`
order. Do not report animated readiness until the selected rendition's complete
all-routes set is resident and verified. On a lower-rendition retry, release
unreferenced failed-candidate unit blobs before planning the next candidate.

Add integration tests with one-byte mutations in front index, unit starts,
unit middles/ends, static bytes, and alignment padding. Assert no corrupt
promotion, inspector call, worker submit, native PNG path, draw, or leaked
lease. Assert internal hashes are labeled consistency checks, not external
authenticity.

Run:

```text
npx vitest run packages/player-web/src/runtime/runtime-asset-session.test.ts packages/player-web/src/runtime/worker-samples.test.ts packages/player-web/src/runtime/static-surfaces.test.ts packages/player-web/src/runtime/integrated-player-preparation.test.ts
```

### 9. Integrate external whole-file integrity

Update:

```text
packages/player-web/src/runtime/full-asset-fetch.ts
packages/player-web/src/runtime/runtime-asset-session.ts
packages/player-web/src/runtime/public-api.compile.ts
```

When external integrity is present, send exactly one range-free request, read
one bounded `200` into quarantine, verify the whole SHA-256 before
`parseHeader()` or any format access, then validate/install through the complete
byte adapter. Continue internal unit/static digest and strict PNG checks on
use.

Instrument parser and media seams in tests so a mismatched external digest
proves zero parser, inspector, PNG, worker, and draw calls. Test valid external
integrity with and without an ETag, tampered body, malformed host syntax,
compressed response, truncated/oversized response, digest rejection/late
completion, and disposal. Assert no Range/If-Range header appears.

Run:

```text
npx vitest run packages/player-web/src/runtime/full-asset-fetch.test.ts packages/player-web/src/runtime/runtime-asset-session.test.ts packages/player-web/src/runtime/public-api.test.ts
```

### 10. Build the shared page byte-accounting core

Create:

```text
packages/player-web/src/runtime/page-resource-policy.ts
packages/player-web/src/runtime/page-resource-policy.test.ts
packages/player-web/src/runtime/page-resource-manager.ts
packages/player-web/src/runtime/page-resource-manager.test.ts
packages/player-web/src/runtime/player-resource-account.ts
packages/player-web/src/runtime/player-resource-account.test.ts
```

Implement default two-decoder/192 MiB page and 64 MiB player limits. Lower
overrides are ordinary; higher limits require the explicit uncertified flag and
set `referenceProfile: false`. Use opaque participant/lease IDs and checked
integer sums.

Implement transactional byte reservations, positive-delta resize, idempotent
release, category snapshots, participant registration/status/touch sequence,
and disposal. Every M6 resource-plan allocation must map to a closed category;
reject unknown categories instead of hiding them in `other`.

Test exact-limit success, one-byte-over failure, rollback on allocation
failure, double release, resize, participant cap versus page cap, lower/higher
policy, hostile numeric input, snapshot immutability, participant disposal with
live leases, and seeded randomized reserve/release schedules against a simple
integer oracle.

Run:

```text
npx vitest run packages/player-web/src/runtime/page-resource-policy.test.ts packages/player-web/src/runtime/page-resource-manager.test.ts packages/player-web/src/runtime/player-resource-account.test.ts packages/player-web/src/runtime/resource-plan.test.ts
```

### 11. Add FIFO decoder leases and deterministic reclamation

Create:

```text
packages/player-web/src/runtime/page-decoder-leases.ts
packages/player-web/src/runtime/page-decoder-leases.test.ts
packages/player-web/src/runtime/page-reclamation.ts
packages/player-web/src/runtime/page-reclamation.test.ts
```

Grant at most one decoder ticket per player and two active leases by default.
Queue visible eligible players FIFO. Park hidden players and reject disposed
ones. A visible waiter may resolve preparation statically as `decoder-queued`
while its generation-tagged ticket remains pending; grant triggers one fresh
readiness rebuild behind its static cover. Grant the next ticket only after
prior owner cleanup and lease release. Remove tickets on hidden, reduced,
replacement, abort, or disposal.

Implement the design's exact reclamation order and deterministic tie-breaks.
Use a two-phase generation-tagged victim token so no manager decision lock is
held across participant cleanup. Never evict an equal-priority visible
animation for a requester. If reclamation cannot fit a request, reject it
without partial counters.

Tests use at least five participants and cover FIFO progress, hidden lease
release, queue abort/removal, simultaneous release/request, stale reclaim
completion, reentrant participant callbacks, exact victim order, requester
self-fallback, policy reduction, equal-visible stability, and all-zero terminal
state.

Run:

```text
npx vitest run packages/player-web/src/runtime/page-decoder-leases.test.ts packages/player-web/src/runtime/page-reclamation.test.ts
```

### 12. Put every loader/candidate/static allocation behind leases

Update:

```text
packages/player-web/src/runtime/bounded-body-reader.ts
packages/player-web/src/runtime/blob-assembly.ts
packages/player-web/src/runtime/verified-blob-store.ts
packages/player-web/src/runtime/resource-plan.ts
packages/player-web/src/runtime/avc-candidate-factory-resources.ts
packages/player-web/src/runtime/browser-avc-candidate.ts
packages/player-web/src/runtime/frame-renderer-browser.ts
packages/player-web/src/runtime/static-surfaces.ts
packages/player-web/src/runtime/strict-static-decoder.ts
packages/player-web/src/decoder-worker/client.ts
```

Thread one `PlayerResourceAccount` through the composed runtime. Reserve before
every network buffer, verified byte store, sample transfer, decoder output
credit, texture/array, staging buffer, PNG scratch/surface, and canvas backing
allocation. Acquire the decoder lease before constructing the module worker or
`VideoDecoder`; release only after both are terminal.

Cross-check live counters against `RuntimeResourcePlan.allocationSnapshot` at
candidate activation and every resize. Treat any unplanned positive delta as a
resource invariant failure and recover static rather than retrying allocation.

Add failure injection before and after every allocation/transfer. Assert exact
lease ownership, no negative/double count, lower-budget static fallback, and
all existing M6 renderer/PNG/worker tests remain green.

Run:

```text
npx vitest run packages/player-web/src/runtime/resource-plan.test.ts packages/player-web/src/runtime/avc-candidate-factory.test.ts packages/player-web/src/runtime/frame-renderer.test.ts packages/player-web/src/runtime/static-surfaces.test.ts packages/player-web/src/decoder-worker/decoder-worker.test.ts
```

### 13. Implement decoded-static LRU eviction and re-decode

Create:

```text
packages/player-web/src/runtime/static-surface-cache.ts
packages/player-web/src/runtime/static-surface-cache.test.ts
```

Refactor/update:

```text
packages/player-web/src/runtime/static-surfaces.ts
packages/player-web/src/runtime/static-surfaces.test.ts
packages/player-web/src/runtime/integrated-player-static-preparation.ts
```

Retain current and incoming surfaces as pins; make all other decoded surfaces
optional LRU entries keyed by manager touch sequence. On reclaim, close oldest
unpinned bitmaps and release their surface leases. Keep verified compressed
statics pinned after `staticReady`.

On a state request for an evicted surface, reserve/decode from the verified PNG,
draw incoming under the M6 cover protocol, then unpin/evict the old surface.
Failure leaves the old current surface visible. Add counters for decode,
re-decode, pin, eviction, close, and peak retained surfaces.

Test deterministic LRU, current/incoming non-eviction, pressure during decode,
rapid latest-wins swaps, decode rejection, page reclamation integration, no
network re-read, uninterrupted cover, and zero surfaces/leases at disposal.

Run:

```text
npx vitest run packages/player-web/src/runtime/static-surface-cache.test.ts packages/player-web/src/runtime/static-surfaces.test.ts packages/player-web/src/runtime/integrated-player-preparation.test.ts
```

### 14. Add serialized visibility suspension and readiness rebuild

Create:

```text
packages/player-web/src/runtime/visibility-policy.ts
packages/player-web/src/runtime/visibility-policy.test.ts
packages/player-web/src/runtime/integrated-player-visibility.ts
packages/player-web/src/runtime/integrated-player-visibility.test.ts
```

Update:

```text
packages/player-web/src/runtime/integrated-player-contracts.ts
packages/player-web/src/runtime/integrated-player.ts
packages/player-web/src/runtime/integrated-player-motion.ts
packages/player-web/src/runtime/realtime-driver.ts
```

Add a host-set visibility seam only; automatic DOM observation remains M8.
Serialize it with motion, decoder eligibility, preparation, recovery, and
disposal. Hidden initial prepare installs/validates statics, resolves with
transient reason `visibility-suspended`, and does not request a decoder. Hiding
active animation freezes rational time, covers current/newest semantic static,
invalidates the candidate generation, aborts optional media work, disposes the
candidate, and releases decoder/animation leases.

Showing under full motion creates one fresh candidate, ensures required units,
reruns all-routes readiness, draws canonical body frame zero for the committed
semantic state, reveals animation, then resumes the clock with no intro or
wall-time fast-forward. Hidden requests remain latest-wins. Integrate page
manager participant states/touches.

Test every hide point, hide during reduce/full, show while decoder queued,
rapid repeated hide/show, hidden request coalescing, finite/loop/transition
states, no intro replay, body-zero first draw, preserved ordinal freeze, rebuild
failure stickiness, eviction-triggered suspension, and disposal races.

Run:

```text
npx vitest run packages/player-web/src/runtime/visibility-policy.test.ts packages/player-web/src/runtime/integrated-player-visibility.test.ts packages/player-web/src/runtime/integrated-player-realtime.test.ts packages/player-web/src/runtime/integrated-player-preparation.test.ts
```

### 15. Add WebGL context-loss recovery behind static cover

Create:

```text
packages/player-web/src/runtime/browser-context-recovery.ts
packages/player-web/src/runtime/browser-context-recovery.test.ts
packages/player-web/src/runtime/integrated-player-context.ts
packages/player-web/src/runtime/integrated-player-context.test.ts
```

Update:

```text
packages/player-web/src/runtime/browser-presentation-planes.ts
packages/player-web/src/runtime/frame-renderer-browser.ts
packages/player-web/src/runtime/integrated-player.ts
```

Own and remove animated-canvas `webglcontextlost/restored` listeners. On loss,
prevent default, synchronously cover the retained current static, freeze the
clock, invalidate output, dispose candidate resources, and release leases. On
restore, use the same visibility rebuild lane: new GL objects, worker, decoder,
readiness, current-state body zero, first draw, then reveal.

A repeated loss during restoration or preparation failure enters sticky static
mode. A static-canvas context failure rejects fallback and leaves the host layer
available; it cannot report `staticReady` without pixels. Late events are
generation checked.

Unit tests use fake canvases/contexts to cover event order, immediate cover,
preventDefault, listener ownership, loss at each phase, restored first draw,
repeated loss, hidden restoration, reduced-motion restoration, disposal, GL
delete failure, and exact lease cleanup.

Run:

```text
npx vitest run packages/player-web/src/runtime/browser-context-recovery.test.ts packages/player-web/src/runtime/integrated-player-context.test.ts packages/player-web/src/runtime/browser-presentation-planes.test.ts packages/player-web/src/runtime/integrated-player-recovery.test.ts
```

### 16. Unify replacement, abort, disposal, and terminal settlement

Create:

```text
packages/player-web/src/runtime/runtime-session-lifecycle.ts
packages/player-web/src/runtime/runtime-session-lifecycle.test.ts
```

Update all M7 owners to register under one root generation/controller. Implement
the exact terminal order: mark terminal; abort network/digest waits; cancel
readers/timers; stop realtime callbacks; dispose candidate/frame/worker/decoder
and GL resources; close statics; release byte/decoder leases; remove context and
abort listeners; unregister participant; settle queues; reject pending waits
once with `AbortError`.

Add a table-driven failure seam for every await and allocation in metadata,
current static, all statics, payload, digest, candidate, readiness, suspension,
eviction, context recovery, and disposal. Run rapid replacement generations and
late completion adversaries. Assert every snapshot counter is zero and cleanup
continues after an injected close/cancel/delete failure.

Run:

```text
npx vitest run packages/player-web/src/runtime/runtime-session-lifecycle.test.ts packages/player-web/src/runtime/integrated-player-disposal.test.ts packages/player-web/src/runtime/integrated-player-fuzz.test.ts
```

### 17. Create deterministic M7 transport and multi-player fixtures

Add:

```text
fixtures/conformance/m7/README.md
fixtures/conformance/m7/reference-packed.rma
fixtures/conformance/m7/reference-packed.provenance.json
fixtures/conformance/m7/network-scenarios.json
```

Use the committed M6 compiler fixture and recorded FFmpeg toolchain. Freeze the
asset SHA-256, header/front-index endpoints, blob offsets/digests, exact expected
range plan, static-first order, and selected-rendition byte total.

`network-scenarios.json` describes behavior, not raw duplicate assets: exact
range, ignored range/full `200`, no ETag, weak ETag, changed ETag, wrong total,
truncated/oversized/compressed/stalled body, corrupt unit, corrupt static,
nonzero padding, and valid/invalid external integrity. Derive mutations in the
test server so provenance remains clear.

Add format/compiler tests proving fixture 0.1 canonicality and stable digests.
Do not hand-edit `.rma` bytes.

Run:

```text
npx vitest run packages/format/test/conformance.test.ts packages/compiler/test/project-compiler-integration.test.ts packages/player-web/src/runtime/runtime-asset-session.test.ts
```

### 18. Add the real HTTP/browser M7 proof

Create/update:

```text
apps/playground/m7-http-fixture-plugin.ts
apps/playground/vite.config.ts
apps/playground/src/m7-loader-budget-proof.ts
tests/browser/m7-loader-budget.spec.ts
```

The Vite test plugin must serve the committed fixture through actual HTTP and
record request method/range/If-Range plus bounded scenario counters. It must not
expose secrets, local paths, or production behavior. Scenarios emit exact
`206`, bounded `200`, entity changes, chunked delays/stalls, corruption, and
identity/invalid encodings.

The browser proof imports only public player-web exports and uses real Fetch
streaming, Web Crypto, strict PNG decode, worker `VideoDecoder`, WebGL2, and
canvas pixels. Prove:

- header/front-index/current-static request order and early static coverage;
- exact strong-ETag `If-Range` payload requests and all internal digests;
- ignored-range and no-validator bounded full success;
- external integrity sends no range and gates parser/media;
- entity change, corrupt unit/static, compressed/stalled/truncated bodies fail
  with zero media/cache leakage;
- three simultaneous visible players never exceed two decoders, the third is
  static/queued, and FIFO progress occurs after release;
- page pressure evicts an unpinned static and re-decodes it without a gap;
- hide freezes and releases, show rebuilds current body frame zero without intro
  or elapsed-time advance;
- synthetic WebGL loss covers static and restores through fresh readiness; and
- all sessions dispose to zero requests, readers, timers, buffers, frames,
  bitmaps, workers, decoders, GL objects, leases, callbacks, listeners, and
  participants.

Capture unsupported browser capability as an explicit unsupported report; do
not substitute VP8, `<video>`, or mocked GL in the production proof. Run the
successful proof three consecutive times.

Run:

```text
npx playwright test tests/browser/m7-loader-budget.spec.ts --project=chromium --workers=1
npx playwright test tests/browser/m7-loader-budget.spec.ts --project=chromium --workers=1
npx playwright test tests/browser/m7-loader-budget.spec.ts --project=chromium --workers=1
```

### 19. Complete adversarial, API, and claim audits

Add/update:

```text
packages/player-web/src/runtime/public-api.compile.ts
packages/player-web/src/runtime/public-api.test.ts
packages/player-web/src/runtime/integrated-player-fuzz.test.ts
docs/evidence/2026-07-12-m7-loader-integrity-resource-manager.md
```

Run seeded response-grammar/body-chunk/entity-generation/resource/lifecycle
fuzzing. Record seeds and bounded maximums. Every rejection asserts no decoder
or browser PNG entry before verification and exact terminal cleanup.

Audit public exports so M8 can compose `openRuntimeAsset`, the sparse catalog,
integrated player, page manager, policies, visibility seam, diagnostics, and
snapshots without importing private maps/leases or old opaque internals.

Run a strict maintainability review and reject:

- a loader that also owns caching, page eviction, or player semantics;
- duplicate header/front-index, Content-Range, ETag, digest, or budget logic;
- `arrayBuffer()`/`blob()` on network responses;
- partial cache promotion or parser/media access before required integrity;
- a complete-file allocation in the normal range path;
- an unbounded read, retry, redirect workaround, timer, queue, or waiter;
- allocation before reservation or a generic/untracked memory bucket;
- parallel memory/network player or candidate implementations;
- resource-manager ownership of browser objects;
- equal-visible decoder thrashing;
- static clear-before-cover; and
- visibility/context code that advances elapsed wall time or replays intro.

Searches include:

```text
rg -n "arrayBuffer\(|\.blob\(|new Blob\(" packages/player-web/src
rg -n "Content-Range|If-Range|ETag|sha-?256|subtle\.digest" packages/player-web/src
rg -n "fetch\(|ReadableStream|reader\.read|reader\.cancel" packages/player-web/src/runtime
rg -n "reserve\(|release\(|trackedBytes|decoderLease" packages/player-web/src
rg -n "webglcontextlost|webglcontextrestored|visibility" packages/player-web/src/runtime
rg -n "setInterval|Last-Modified|multipart/byteranges|HTMLVideoElement|currentTime|seek" packages/player-web/src
```

Every match must be the sole authority, an injected seam, an intentional
compatibility adapter, a test, or removed.

## Planned Production Files

```text
packages/player-web/src/runtime/
  asset-fetch-contracts.ts
  bounded-body-reader.ts
  load-watchdogs.ts
  http-content-range.ts
  http-entity-tag.ts
  http-response-contract.ts
  sha256-verifier.ts
  external-integrity.ts
  full-asset-fetch.ts
  range-asset-session.ts
  blob-range-plan.ts
  blob-assembly.ts
  verified-blob-store.ts
  runtime-asset-session.ts
  page-resource-policy.ts
  page-resource-manager.ts
  player-resource-account.ts
  page-decoder-leases.ts
  page-reclamation.ts
  static-surface-cache.ts
  visibility-policy.ts
  integrated-player-visibility.ts
  browser-context-recovery.ts
  integrated-player-context.ts
  runtime-session-lifecycle.ts
```

Existing catalog, resource plan, static preparation, candidate, worker,
renderer, presentation-plane, integrated-player, model/error, and public-index
files are refactored in place. Deprecated opaque facades remain thin aliases
only where M6 retained them.

## Planned Test and Evidence Files

```text
packages/player-web/src/runtime/*m7-owner*.test.ts
fixtures/conformance/m7/*
apps/playground/m7-http-fixture-plugin.ts
apps/playground/src/m7-loader-budget-proof.ts
tests/browser/m7-loader-budget.spec.ts
docs/evidence/2026-07-12-m7-loader-integrity-resource-manager.md
```

The wildcard denotes the focused tests named in the execution steps, not one
giant M7 test file.

## Final M7 Gate

Run from a cleanly understood worktree:

```text
npm run typecheck
npm run test:unit
npm run build
npm run test:browser
npm audit --audit-level=high
npm pack --dry-run -w @rendered-motion/graph
npm pack --dry-run -w @rendered-motion/format
npm pack --dry-run -w @rendered-motion/compiler
npm pack --dry-run -w @rendered-motion/player-web
git diff --check
```

Also:

- regenerate/verify the M7 fixture with the recorded compiler and FFmpeg;
- run the M7 Chromium proof three consecutive times;
- run the network/resource/lifecycle mutation suites with recorded seeds;
- run the strict maintainability/authority audit; and
- inspect package contents for fixtures, credentials, local paths, traces, or
  generated build output.

The evidence file records:

- exact commit/tree, Node/npm/TypeScript/Vitest/Playwright/browser/OS versions;
- fixture/compiler/FFmpeg/source/asset/external-integrity digests;
- header/front-index ranges, declared total, request sequence/count, status,
  exact strong-validator behavior, final-URL equality result, and full-fallback
  reason without recording URL or ETag values;
- maximum active bodies, declared/observed body bytes, quarantine/compaction
  peaks, watchdog cases, canceled readers, and cleared timers;
- every internal unit/static digest count and proof that corrupt bytes reached
  neither cache nor decoder/PNG;
- proof external integrity disabled ranges and gated parser/media calls;
- selected rendition, verified/resident/evicted bytes, all-routes readiness,
  underflow, and static-first event order;
- page policy, per-player/page byte peaks by category, decoder owners/queue peak,
  exact deterministic eviction order, and reservation rollback counts;
- static surface decode/re-decode/evict/close peaks and uninterrupted coverage;
- visibility freeze/resume ordinals, body-zero first frame, intro count, and
  readiness rebuild;
- context-loss cover/rebuild/repeated-failure traces;
- terminal request, reader, timer, buffer, frame, bitmap, worker, decoder, GL,
  callback, listener, lease, ticket, reclamation, and participant counters;
- unit/browser pass counts, fuzz seeds, audit result, and package contents; and
- explicit claim boundary: internal web runtime, no M8 element/automatic
  observers, persistent cache, authenticated range playback, or M9
  certification/observed-display claim.

Do not mark M7 complete or commit it until every gate is green, all counters
settle, the evidence contains no secret/local identifier or unsupported claim,
and the audit finds exactly one authority for HTTP grammar, body bounds,
digest promotion, resource accounting, visibility rebuild, and context
recovery.
