# M7 Loader, Integrity, and Resource Manager Evidence

**Date:** 2026-07-12

**Milestone:** Bounded HTTP/full-memory asset loading, exact entity and digest
enforcement, sparse verified residency, shared page resource authority,
decoded-static reclamation, visibility suspension, and WebGL recovery for the
internal web runtime

**Status:** M7-scoped implementation and verification complete. Deterministic
fixture verification, focused and full player/decoder gates, three consecutive
final-shape ten-case Chromium runs, package dry-runs, dependency/security audit,
and the strict maintainability/composition pass are green. The still-moving
M8/M9 full-repository gate and reviewed revision identity remain pending; this
document must not claim repository-wide completion until those rows are closed.

## Result and Claim Boundary

M7 keeps compiled wire version `0.1`. It adds one bounded web retrieval path
that parses the existing header/front index, verifies complete unit/static
blobs before cache or media use, and adapts both HTTP and owned bytes into the
same sparse catalog. A page-scoped authority accounts a closed set of byte
categories and grants at most two default decoder leases, while each player
owns and closes its browser objects. The integrated player exposes host-driven
visibility and context-recovery seams without adding automatic DOM observers.

The checked local work proves only an internal web runtime on the environment
recorded below. It does not claim a public custom element, framework wrapper,
automatic `IntersectionObserver` or media-query wiring, persistent or
cross-player caching, service-worker behavior, authenticated range playback,
device certification, observed-display continuity, or publication readiness.
Those boundaries remain assigned to M8 and M9.

## Reviewed Revision and Captured Environment

M7 work started from reviewed base commit
`7c02823e99350b2e5642207c32acd061c67a84dd` (`feat: implement transparent
motion and static fallback`). The final reviewed M7 commit/tree is intentionally
pending; the containing milestone evidence cannot truthfully predict its own
commit identity while implementation is changing.

| Item | Captured value |
| --- | --- |
| Final M7 commit/tree | **Pending final gate** |
| OS | macOS 15.6, build 24G84; Darwin 24.6.0 arm64 |
| Node.js | 25.8.1 |
| npm | 11.11.0 |
| TypeScript | 7.0.2 |
| Vitest | 4.1.10 |
| Playwright | 1.61.1 |
| Chromium | Chrome for Testing 149.0.7827.55 |
| FFmpeg | 8.1.2 |
| FFprobe | 8.1.2 |

No machine-local executable or workspace path is recorded here.

## Deterministic Fixture and Provenance

`fixtures/conformance/m7/reference-packed.rma` is byte-identical to the
reviewed M6 `packed-alpha-all-routes.rma` compiler output. The M7 fixture adds
transport/scenario provenance without changing the compiler output or wire
format.

| Provenance item | Bytes | SHA-256 |
| --- | ---: | --- |
| M7 reference asset | 37,968 | `aa66fbca787138b692e7fed691cbabec58dd9f9576b63b13d4ed9c69269d9a0f` |
| M7 provenance document | 10,011 | `97bed71d2d0dfeb95a2eea6faa4a24321fc4235a9c65a6a3845554beab2a91a0` |
| M7 provenance generator | 7,217 | `5bfa1f46b573e33603c40a950e8e47dc2cb7dd78d9b8191b7102710a5a90ec75` |
| M7 network scenarios | 2,419 | `8e86196102a57aa638fb44b1fe758b56d547ee47366da05695213117a61acbcf` |
| inherited M6 provenance | 115,800 | `40ba4f3701463025ad54ff191618ba3c17b42f08dd6c93df320d232ec263c8f3` |
| compiler source project | 5,080 | `5d82ef90b04be6c52e06fc8fc0eb7fb215e16706d44dda11034f838bab17346f` |
| compiler manifest | n/a | `37e526bda7a4e0f049d1d6f7ba1e50e45d25a8f4fea8e0b4b4ada355f82cae12` |

The inherited compiler toolchain identity is unchanged:

| Toolchain item | SHA-256 |
| --- | --- |
| FFmpeg executable | `329fa7360b28a067a0cd7281474bb18cd868932d5173646a674466bcb56d6e93` |
| FFmpeg version output | `98f2da65e4b3e39aa6ac74848582be422751d8f52176cf810eceb94bbcaa78d1` |
| FFmpeg configuration | `8470f6e5d1c91c01f1228e91aa8827bea05a7e8a39c8dedefdb778716bdc1aec` |
| FFmpeg encoder list | `38b11441f5ffe17fd32539030ba9290b81e730878bb0cffe1af5084e2b7b8879` |
| packed-YUV calibration | `2187478d0b9baaa2e44dc458abcdcbc7c9242c360bb233cff2d5229004a6911c` |
| FFprobe executable | `841ab2259a55e5c44c5851890867d48750ff1e7cfa92b5fbed91445a493128` |
| FFprobe version output | `8316221740e891c1f9d08d30a9a45059af9f1ec96741423eee3ae0c7721d9cec` |

The complete-file digest encodes to the canonical external integrity value
`sha256-qmb7ynhxOLaS5/7Wkcur7Fjdn5V2tjsT1O2caSadmg8=`. The entity validator
value is deliberately omitted; tests compare its exact code units without
placing the value in evidence.

The independent fixture audit performed all of these checks:

- `node fixtures/conformance/m7/update-provenance.mjs --check` exited zero;
- M7 and inherited M6 asset files compared byte-for-byte equal;
- the asset SHA-256 and canonical external-integrity encoding matched
  provenance;
- all 17 canonical blob digests matched: 14 units and three statics;
- all 41 alignment-padding bytes were zero;
- storage spans were ordered, nonoverlapping, gap-free when padding is
  included, and ended exactly at byte 37,968; and
- generator, scenario, source provenance, and compiler-project byte lengths
  and digests matched the self-bound provenance document.

The exact front-index and expected coalesced storage ranges are:

| Purpose | Offset | Length | Inclusive HTTP range |
| --- | ---: | ---: | --- |
| header | 0 | 64 | `bytes=0-63` |
| front-index tail | 64 | 8,456 | `bytes=64-8519` |
| complete front index | 0 | 8,520 | n/a |
| initial static `static.02` | 33,000 | 4,968 | `bytes=33000-37967` |
| all static storage | 23,061 | 14,907 | `bytes=23061-37967` |
| selected `packed.1x` storage | 13,111 | 9,950 | `bytes=13111-23060` |
| all payload storage | 8,520 | 29,448 | `bytes=8520-37967` |

The selected rendition contains 9,937 digest-bearing payload bytes inside
9,950 storage bytes. All three static payloads contain 14,904 digest-bearing
bytes inside 14,907 storage bytes.

The focused format/compiler/player fixture gate passed three files and five
tests. It checks version `0.1`, canonical layout, stable provenance, and player
catalog interpretation.

## HTTP, Body Bounds, and Integrity

The final focused loader/integrity gate passed 16 files and 286 tests. It covers the
closed Fetch/request contract, canonical response grammar, bounded body reader,
watchdogs, SHA-256 and external-integrity parsing, range/full opening, canonical
blob plans/assembly, batch coalescing, sparse residency, and verified promotion.

After the absolute-deadline composition changed, the final focused rerun passed
eight files and 126 tests. One operation deadline now spans both metadata
requests, no-validator full fallback, late external digest and pre-promotion
checks, and each public ensure waiter. Shared waiters retain independent absolute
deadlines; expiry of the final interested waiter cancels the active payload
reader. Coalesced multi-blob timeout rolls back every pending promotion, and
late metadata reservations are released. The tests assert zero terminal
deadline/timer/listener/waiter and active-body/load ownership.

The final-shape public-runtime Chromium proof passed the following exact range
sequence for the selected path:

1. header `bytes=0-63`;
2. front-index tail `bytes=64-8519`;
3. current static `bytes=33000-37967`;
4. the two remaining statics coalesced as `bytes=23061-32999`; and
5. selected rendition storage `bytes=13111-23060`.

All five responses were exact `206` identity representations with the same
declared total. Requests two through five carried the exact pinned strong
validator, and every returned validator/final response location matched the
pinned identity. Values themselves are not recorded.

The browser proof also passed:

- an ignored initial range as one bounded full `200`;
- missing and weak initial validators as one partial response followed by
  exactly one range-free full restart;
- valid external integrity as exactly one range-free full response;
- invalid external integrity as `integrity-mismatch`, with no opened session;
- changed identity, wrong total, truncation, overflow, non-identity encoding,
  corrupt static, corrupt unit, nonzero padding, and stalled/aborted body
  containment; and
- zero active fixture responses and zero retained runtime resources after each
  terminal path.

The selected browser path admitted three verified statics and seven verified
selected-rendition units. The fixture audit additionally checked the seven
unselected rendition units. Independent browser instrumentation recorded these
selected-path counters:

| Observation | Recorded value |
| --- | --- |
| declared/observed response bytes | 64/64; 8,456/8,456; 4,968/4,968; 9,939/9,939; 9,950/9,950 |
| body/reader peak; cancellations; releases | 1/1; 0; 5 |
| digest calls/bytes | 10 / 24,841 |
| header/front-index/complete parsers | 1 / 1 / 0 |
| strict-PNG/media gates | 3 / 1 |
| timers scheduled/cleared/fired/pending/peak | 14 / 14 / 0 / 0 / 2 |
| reservations attempted/succeeded/failed/released | 27 / 27 / 0 / 27 |

The valid external-integrity path recorded one complete-file digest over
37,968 bytes before one complete-asset parser call. The mismatch path recorded
the same single digest, zero parser/PNG/media calls, and one unpromoted full
release. The oversized-range response declared 64 bytes, was stopped after 65
observed bytes, cancelled its reader, and failed `range-response-invalid`.
The stalled response declared 64 bytes, stopped at 32 observed bytes, fired one
operation watchdog, cancelled its reader, and failed `watchdog-timeout`. Every
case ended with zero active bodies/readers, timers, page bytes, byte leases,
participants, decoder leases, and decoder tickets.

## Sparse Residency and Resource Accounting

The successful public range run observed this readiness order:

| Phase | Metadata bytes | Verified payload | Verified units | Verified statics |
| --- | ---: | ---: | ---: | ---: |
| metadata | 8,520 | 0 | 0 | 0 |
| initial static | 8,520 | 4,968 | 0 | 1 |
| all statics | 8,520 | 14,904 | 0 | 3 |
| selected rendition | 8,520 | 24,841 | 7 | 3 |

The first accounting audit exposed simultaneous retained `response-body` and
`asset-metadata` ownership for the same 8,520-byte front index. The range
session was then changed to retire its raw prefix/response lease before public
session publication. An independent rerun observed no persistent
`response-body`, quarantine, or assembly bytes and these exact stable-phase
totals:

| Phase | Physical/logical bytes | Leases | Positive persistent categories |
| --- | ---: | ---: | --- |
| metadata | 8,520 | 1 | metadata 8,520 |
| initial static | 13,488 | 2 | metadata 8,520; verified static 4,968 |
| all statics | 23,424 | 4 | metadata 8,520; verified statics 14,904 |
| selected rendition | 33,361 | 11 | metadata 8,520; verified statics 14,904; verified units 9,937 |

The selected range path peaked at 43,836 physical and per-player logical bytes
across 13 leases. Its exact category peaks were metadata 8,520, response body
17,040, blob assembly 4,968, verified statics 14,904, and verified units 9,937;
quarantine remained zero. Disposal returned physical/logical bytes and every
lease to zero.

Independent full-path phase accounting observed exactly one 37,968-byte
`asset-full` lease and no other positive category after metadata publication
for the ignored-initial-range, no-validator restart, and valid external-
integrity scenarios. Each path disposed to zero bytes, leases, participants,
decoder owners, and decoder tickets.

The ignored-range and valid external-integrity full paths each peaked at
37,968 physical/logical bytes, one lease, and 37,968 quarantine bytes before
promotion. The no-validator path cancelled its unused initial 64-byte reader
at zero observed bytes, then recorded the same bounded full-body peaks.

The reference page policy is frozen at:

| Limit | Value |
| --- | ---: |
| active decoder leases per page | 2 |
| active decoder leases per player | 1 |
| page physical tracked bytes | 192 MiB |
| player logical tracked bytes | 64 MiB |
| closed byte categories | 20 |

Higher host limits require the explicit uncertified opt-in and clear the
`referenceProfile` flag. The byte categories contain no generic or `other`
bucket.

## Page Arbitration and Static Reclamation

The final focused resource/static/visibility/context/lifecycle gate passed 20
files and 243 tests. It covers transactional byte reservations and reclassification,
randomized accounting oracles, FIFO decoder tickets, deterministic two-phase
reclamation, exact candidate/worker/static hosts, LRU surface ownership,
serialized visibility, context recovery, and root lifecycle settlement.

The real-browser page-arbitration proof created three visible participants:

- two received decoder leases;
- the third remained one queued ticket;
- releasing the first owner promoted the third participant, which was not one
  of the initial owners; and
- decoder leases, tickets, participants, byte leases, and physical bytes all
  returned to zero.

The real-browser static proof decoded three strict surfaces, evicted the
deterministic LRU victim `static.00`, retained two, re-decoded that same static
from verified PNG bytes, performed no additional asset read, and disposed to
zero. Pressure entered through the requesting participant's real asynchronous
`png-copy` resource host; the proof did not call the reclamation coordinator
directly. Every visibility callback kept a valid covered surface; this callback
trace is not the M7 hide/show suspension proof.

The exact static lifecycle report was:

| Observation | Recorded value |
| --- | ---: |
| decoded / re-decoded / evicted surfaces | 4 / 1 / 1 |
| closed before disposal / after disposal | 1 / 4 |
| peak retained surfaces / RGBA bytes | 3 / 14,580 |
| lease reservations | 4 |
| lease releases before disposal / after disposal | 1 / 4 |

The loader page/category peaks and its zero failed reservations are recorded in
the sparse-accounting section above. Allocation-rollback counts for the four
fixed resource/lifecycle seeds are recorded in the adversarial section below.

## Visibility and Context Recovery

Focused unit coverage is green for host-set visibility, hidden preparation,
latest-wins state requests, no hidden wall-time fast-forward, canonical
body-zero re-entry, initial and repeated context loss, immediate static cover,
listener ownership, generation invalidation, fresh rebuild, and terminal
cleanup.

The final-shape real-browser session-player proof composes the HTTP range
session with the actual integrated player, module worker/`VideoDecoder`, strict
PNG decoder, presentation canvases, WebGL2 renderer, page account, and decoder
authority. The recorded environment supported every required capability and
the exact selected AVC configuration.

Initial preparation reached animated mode on `packed.1x`, drew `intro:0` once,
then committed `idle-body:0`, with one decoder lease, all three statics, and all
seven selected-rendition units verified.

On hide/resume the proof recorded:

- the frozen ordinal as the last committed presentation;
- no ordinal change while hidden, after hidden wall time, or during rebuild;
- decoder leases and all five animation categories at zero while hidden;
- complete worker/frame/renderer/GL retirement behind a nontransparent static
  cover before candidate cleanup;
- a fresh decoder lease and `idle-body:0` first draw on resume;
- `idle-body:1` on the next presentation, with zero underflows;
- no intro replay (`intro` draw count remained one); and
- a smooth realtime session after re-entry.

On synthetic WebGL loss/restoration the proof recorded synchronous
`preventDefault()` and static cover, lost state with two owned listeners, no
logical-time advance during loss/wall time/rebuild, zero decoder ownership and
complete old-candidate cleanup, one successful fresh restoration, canonical
`idle-body:0` then `idle-body:1`, zero underflows, and no intro replay.

Three candidates were created: initial preparation, visibility re-entry, and
context restoration. Their initial presentations were exactly `intro:0`,
`idle-body:0`, and `idle-body:0`. Disposal left zero session loads/waiters/body
operations, candidate owners, frames, workers, renderers, GL resources,
staging/source copies, canvas reservations, context listeners/operations,
static surfaces, decoder leases/tickets, page bytes/leases, and participants.
The seven HTTP responses were the metadata/static/rendition sequence plus one
exact selected-rendition reacquisition for each rebuild; all remained on the
pinned entity.

The complete ten-case Chromium proof passed three consecutive final-shape runs
in 9.4, 8.8, and 12.1 seconds. The session-player case also asserted zero page
errors and zero browser console errors.

## Fixed-Seed Adversarial Coverage

`integrated-player-fuzz.test.ts` passed one file and 20 tests. Four existing
integrated-player seeds remained deterministic, and the M7 authority suite used
these four unsigned 32-bit seeds:

```text
0x00000001
0x7f4a7c15
0xa11ce5ed
0xffffffff
```

For each M7 seed the suite runs 128 response-grammar/entity cases, 72 bounded
body tapes, 12 corrupt-promotion cases, and 256 resource/lifecycle steps. The
aggregate checked workload is therefore 512 grammar cases, 288 body tapes, 48
corrupt-promotion cases, and 1,024 lifecycle steps, with every lifecycle seed
replayed twice for deterministic equality.

The resource oracle bounds the generated page at 4,096 bytes, each player at
2,048 bytes, and decoder ownership at two. Every seed must inject allocation
rollbacks and replacements, preserve transactional counters, reject corrupt
bytes before PNG/sample access, and finish at exactly zero physical bytes,
byte leases, decoder leases, decoder tickets, reclamations, and participants.

An independent direct report reran each 256-step lifecycle seed twice and
required byte-for-byte equal summaries:

| Seed | Replacements | Budget rejections | Allocation rollbacks | Pending-wait aborts | Peak page bytes | Peak decoders |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `0x00000001` | 17 | 20 | 30 | 14 | 4,040 | 2 |
| `0x7f4a7c15` | 20 | 7 | 29 | 13 | 3,003 | 2 |
| `0xa11ce5ed` | 25 | 12 | 29 | 19 | 3,981 | 2 |
| `0xffffffff` | 24 | 6 | 20 | 12 | 3,274 | 2 |

Every reported terminal summary contained zero physical bytes, byte leases,
decoder leases, decoder queue entries, pending reclamations, and participants.

## Authority and Maintainability Audit

The independent production-only searches found:

- no `arrayBuffer()`, response `.blob()`, or `new Blob()` in player-web
  production;
- no production `setInterval`, `Last-Modified`, multipart range, video-element,
  `currentTime`, or seek implementation (two experimental comments contain the
  word `seek` only);
- one `Content-Range` parser/validator authority in
  `http-content-range.ts`;
- one strong entity-tag parser/matcher authority in `http-entity-tag.ts`;
- one SHA-256 comparison/promotion authority in `sha256-verifier.ts` backed by
  an injected Web Crypto digest capability;
- the existing `@rendered-motion/format` parser/validator as the only wire
  grammar authority, reached through captured testable adapters;
- one untrusted response-body reader in `bounded-body-reader.ts`; the other
  stream reader match is the bounded strict-PNG inflate path, not network
  retrieval;
- no browser worker, decoder, frame, bitmap, canvas, or WebGL object type in
  the page resource manager, decoder-lease authority, reclamation coordinator,
  or player account; and
- exactly 20 named byte categories, with unknown categories rejected.

The final structural pass keeps every player-web production runtime owner below
1,000 lines. The largest are `range-asset-session.ts` and
`integrated-player.ts` at 995 each, `browser-presentation-planes.ts` at 992,
`static-surfaces.ts` at 976, `verified-blob-store.ts` at 972,
`runtime-asset-session.ts` at 963, `page-resource-manager.ts` at 961,
`asset-catalog.ts` at 947, and `player-web-page-runtime.ts` at 733. The former
1,201-line session-player proof was split into a 455-line scenario owner and a
749-line support owner; the duplicated helper block exposed during that split
was removed. Additional narrow extractions placed content ticking in a
179-line owner, page-runtime capture/reclamation support in a 377-line owner,
presentation support in a 188-line owner, and static snapshot capture in a
30-line owner. Async static-surface reservation/rollback is isolated in the
217-line resource owner. Player-web and playground typechecks passed after
decomposition.

The first production search found both `RuntimeSessionLifecycle` and
`PageReclamationCoordinator` standalone. A new `PlayerWebPageRuntime` now owns
the page manager, decoder FIFO, reclamation authority, participant accounts,
and replaceable root lifecycle. Its independently rerun 12-test gate proved
old-player cleanup before session bytes, serialized fresh-generation
publication, hostile-disposer and hostile-signal containment, fail-closed
replacement, every asynchronous production resource host, and zero terminal
owners. One test fills the page with a different participant's optional decoded
static, then opens a real compiled in-memory asset; the full-body reservation
deterministically evicts that cross-owner static and adopts the authenticated
manager lease into the requesting account.

The broader production pressure boundary is now closed. A generation-fixed
admission capability routes body, full-body, blob-assembly, copied verified
blob, strict-PNG, decoded-static, two-plane canvas, and candidate-plan
reservations through the page reclamation/retry lane before allocation. The
complete-source borrowed verified path adds no second lease. Copied verified
capacity is admitted before digest/allocation but remains unpublished as
reclaimable until synchronous promotion has staged an exact isolated copy and
the loader commits residency; abort, stale generation, failed publication,
no-promotion, and copied-to-borrowed transition all release the lease exactly.
The real browser static proof triggers cross-owner eviction through the
asynchronous PNG-copy host, and focused tests exercise every production host
through cross-owner reclamation.

The final independent race audit closed three additional ownership gaps. First,
an incoming static-surface admission whose abort-listener registration retained
the listener and then threw could leave a later asynchronous lease unselected;
every rejected reservation race now removes the listener, releases a late grant
exactly once, and retains neither its controller nor PNG/decode work. Second, a
two-plane canvas transition could be admitted, rolled back by generation
retirement, and then consumed by the next promise continuation because
commit-after-rollback was a silent no-op. Production transitions now carry an
authenticated freshness assertion at the exact synchronous mutation boundary;
constructor and resize races leave both canvases unchanged, and
commit-after-rollback fails with `AbortError`. Third, full-memory asset opening
could make replacement wait indefinitely on a victim reclamation callback.
Admission and reclamation now share the exact lifecycle signal: cancellation
detaches token/claim state, rejects before allocation, releases any late grant,
and lets replacement and coordinator disposal reach terminal zero even when a
victim promise never cooperates. The adjacent M7 abort-link authorities also
publish cleanup ownership before registration, covering attach-then-throw
signals without retained listeners.

The audit initially rejected two magic construction casts: metadata catalog
installation crossed the public constructor through `unknown`, and lifecycle
generation creation seeded a non-null context through `unknown`. Both were
replaced by explicit branded/nullable checked boundaries, and the raw
final-location/entity-validator identity type was removed from the public
index. The focused catalog/session/lifecycle/API rerun passed four files and 53
tests plus the strict player-web typecheck.

A queued decoder-grant callback failure initially retained its already granted
lease. It now atomically rejects/releases that grant for both throwing and
disposed callbacks; the focused participant integration rerun passed six tests,
including three complete players, two animated owners, one `decoder-queued`
static player, and exactly one rebuild after FIFO promotion.

Session/player binding now holds one exclusive generation-tagged claim, so an
external session cannot be shared across players or have one player evict bytes
under another. The claim is released on normal disposal and constructor
rollback; the focused adapter rerun passed eight tests, including reject,
dispose/rebind, and constructor-failure/rebind cases.

The allocation-order audit also found that strict-PNG and AVC-inspection
copies were made before their exact transient leases. The reference path now
reserves PNG-copy ownership before invoking the copy capability and performs
AVC inspection through a synchronous byte-free borrowed-view authority. Both
capabilities use direct internal unique-symbol methods, not global registries,
and remain absent from the public package index. The independent focused rerun
passed seven files and 83 tests.

The full-memory adapter finding is closed. One complete-source lease now owns
the caller/full-response copy, while canonical storage ranges and exact blob
ranges are issued through internal unique-symbol capabilities. The batch
validates every padding byte, hashes the exact live blob view, and promotes a
borrowed verified view without assembly allocation, verified-byte allocation,
or a second persistent lease. Forged, expired, sliced, shared, and
out-of-bounds borrow identities are rejected. Copy APIs still return isolated
fresh values, eviction removes logical residency, and re-ensure rehashes the
retained source without another allocation or request.

A later payload `200` after an earlier `206` is also covered: the session and
catalog transition to `full`; the catalog counts the complete source plus only
pre-existing independently leased copied bytes; subsequent blobs borrow the
source; evicting the older copied blob returns ownership to source-only; and
reload needs no new lease or network request. Disposal retains the full lease
until pending digests retire, then reaches zero. The independent focused rerun
passed six files and 63 tests.

The final strict authority and maintainability review is clean for the M7
scope. Production searches found no forbidden unbounded body-copy APIs or
browser objects in page accounting, retained one HTTP/entity/digest authority,
and confirmed the closed 20-category model and the structural cap above.

## Dependency, Package, and Artifact Inspection

`npm audit --audit-level=high --json` exited zero with 116 total dependencies
and no info, low, moderate, high, or critical vulnerabilities.

All four required package dry-runs exited zero:

| Package | Packed bytes | Unpacked bytes | Entries | Top-level contents |
| --- | ---: | ---: | ---: | --- |
| `@rendered-motion/graph` | 45,323 | 250,748 | 31 | package metadata, source, tests, configs |
| `@rendered-motion/format` | 136,610 | 621,908 | 98 | package metadata, source, tests, configs |
| `@rendered-motion/compiler` | 339,018 | 1,635,273 | 375 | package metadata, generated distribution, source, tests, configs |
| `@rendered-motion/player-web` | 680,755 | 3,564,432 | 314 | package metadata, source, configs |

No dry-run entry used an absolute path or a secret/report/trace-shaped name.
No generated distribution, trace, report, result, cache, archive, credential
file, or local absolute path is tracked in the repository. One ignored local
test-runner status marker existed during the preliminary audit and is not part
of any package or commit.

Package contents are intentionally broad development packages at this
milestone. Publication shaping, version `1.0.0`, export maps, clean consumer
installs, and release archives remain M9 work; the successful M7 dry-run is not
a publication-readiness claim.

## Verification Ledger

Only commands rerun by the M7 implementation/audit team against the working
tree are marked passed. Repository-wide rows owned by the moving M8/M9 gate
remain pending.

| Check | Result |
| --- | --- |
| M7 provenance regeneration check | passed |
| independent asset/blob/padding/range audit | passed; 17 blob hashes, 41 zero padding bytes |
| M7 format/compiler/player fixture tests | passed; 3 files, 5 tests |
| focused HTTP/body/integrity/session gate | passed; 16 files, 286 tests |
| focused resource/static/visibility/context/lifecycle gate | passed; 20 files, 243 tests |
| absolute-deadline focused gate | passed; 8 files, 126 tests |
| composed page runtime lifecycle/reclamation gate | passed; 1 file, 13 tests; real asset pressure, cancellation-safe replacement, late victim settlement, and every asynchronous production host triggered cross-owner reclamation |
| assembly/verified-copy asynchronous admission gate | passed; 3 files, 45 tests; hostile late/abort/listener/publication rollback and committed-residency publication covered |
| final async ownership race gate | passed; 11 files, 168 tests; late static admission, canvas retirement before continuation, generation-canceled reclamation, coordinator disposal, and attach-then-throw listener cleanup covered |
| candidate/renderer/worker regression samples | passed; 3 files, 59 tests; the 30 worker tests were also rerun alone |
| fixed-seed integrated/M7 adversarial suite | passed; 1 file, 20 tests |
| full M7 player/decoder gate | passed; 89 files, 1,170 tests |
| complete player-web source sweep | passed; 102 files, 1,333 tests |
| complete-source zero-copy/later-200 gate | passed; 6 files, 63 tests |
| player-web workspace typecheck | passed |
| playground workspace typecheck | passed |
| final-shape M7 Chromium proof | passed three consecutive times; 10 tests in 9.4, 8.8, and 12.1 seconds |
| dependency audit | passed; zero vulnerabilities |
| four package dry-runs | passed |
| tracked secret/path/trace/dist inspection | passed |
| `git diff --check` | passed on final M7-scoped audit tree |
| final full-repository `npm run typecheck` | **pending** |
| final full-repository `npm run test:unit` | **pending** |
| final full-repository `npm run build` | **pending** |
| final full `npm run test:browser` | **pending** |
| final-shape M7 Chromium proof, repetition 1 | passed; 10 tests in 9.4 seconds |
| final-shape M7 Chromium proof, repetition 2 | passed; 10 tests in 8.8 seconds |
| final-shape M7 Chromium proof, repetition 3 | passed; 10 tests in 12.1 seconds |
| final mutation summaries and terminal counters | passed; recorded above |
| final strict maintainability/authority review | passed for M7 scope |
| final M7 package/artifact inspection | passed |
| final reviewed commit/tree | **pending** |

## Completion Conditions Still Open

M7-scoped completion conditions are satisfied. Repository-wide completion still
requires the moving M8/M9 full typecheck, unit, build, and browser gates to turn
green, followed by recording the reviewed commit/tree identity without a
circular or fabricated claim.
