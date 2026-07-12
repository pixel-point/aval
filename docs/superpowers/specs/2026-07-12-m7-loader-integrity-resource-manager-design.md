# M7 Loader, Integrity, and Resource Manager Design

**Date:** 2026-07-12

**Status:** Approved implementation slice derived from the committed web
rendered-motion design and the approved M4-M6 contracts

**Authority:**

- [Web Rendered Motion Format Design](2026-07-11-web-rendered-motion-format-design.md)
- [Web Rendered Motion Implementation Plan](../plans/2026-07-11-web-rendered-motion-implementation.md)
- [M4 Minimal Compiled Format Design](2026-07-11-m4-minimal-compiled-format-design.md)
- [M5.5 Integrated Scheduler and Readiness Design](2026-07-12-m55-integrated-scheduler-readiness-design.md)
- [M6 Transparency and Static Fallback Design](2026-07-12-m6-transparency-static-fallback-design.md)

## 1. Outcome and Claim Boundary

M7 replaces M6's completely resident, single-player input assumption with a
bounded browser loader and one shared page resource authority. A player can
open an HTTP asset, validate its 64-byte header and bounded front index before
payload allocation, show the current strict static frame, fetch only complete
unit/static blobs, verify each blob before it becomes resident, and prepare the
existing M6 runtime without changing the compiled format.

M7 proves that:

- every response body, timer, allocation, digest, and entity generation is
  bounded and abortable;
- partial responses are combined only under one unchanged strong entity tag;
- ignored ranges and servers without a strong validator have a safe bounded
  full-file path;
- a host-supplied external SHA-256 gates all parsing and playback on one
  complete verified representation;
- internal unit and static digests are checked before persistent cache
  admission and before decoder or PNG use;
- no player owns more than one active decoder, and the default page owns no
  more than two;
- every player stays within 64 MiB of logical tracked memory and the default
  page stays within 192 MiB of physical tracked memory;
- decoded non-current static surfaces can be evicted without losing static
  state coverage;
- hiding freezes logical time and releases animation resources, while showing
  rebuilds readiness before time advances;
- WebGL context recovery starts from the committed semantic state behind a
  static cover; and
- abort, replacement, eviction, context loss, and disposal close or release
  every owned resource exactly once.

The milestone remains an internal web runtime. It does not add the public
custom element, automatic `IntersectionObserver`/`matchMedia`/engagement
bindings, framework wrappers, persistent browser storage, service-worker
integration, background prefetch policy, authoring UX, or named-device
certification. M8 owns the element and zero-configuration authoring surface;
M9 owns CI publication and certification claims.

## 2. Decisions and Alternatives

### 2.1 Keep compiled wire version 0.1

The container remains exactly version `0.1`. Its existing header already
declares the complete file length and bounded front-index ranges. Its canonical
layout already identifies one digest-bearing blob for every rendition/unit
pair and every static frame. No URL, validator, cache, integrity, or page-budget
field belongs in the asset.

HTTP validators and host-provided integrity are properties of a retrieval, not
of the compiled entity. Page policy is a host/runtime decision. Adding any of
them to the manifest would conflate transport trust with internal consistency
and make identical bytes differ across deployments.

Range-mode validation strengthens no wire rule and relaxes none. A fetched
blob uses the exact canonical range derived by `parseFrontIndex()`. Alignment
padding immediately preceding a fetched blob is also fetched and checked for
zero bytes. Full-file paths continue to use `validateCompleteAsset()`.

### 2.2 Use a sparse verified catalog, not a complete-file facade

The selected design separates immutable metadata from verified blob
residency:

```text
bounded HTTP session
       |
       v
ParsedFrontIndex + entity identity
       |
       v
RuntimeAssetCatalog metadata
       |
       +--> verified static blobs --> strict PNG surfaces
       |
       +--> verified rendition/unit blobs --> sample copies --> decoder worker
```

The catalog can answer graph, rendition, unit, record, port, and static
descriptor queries as soon as the front index is valid. Blob reads are
asynchronous until an exact digest-verified blob is resident; sample copies
remain synchronous after the containing unit has been promoted. The existing
owned-byte constructor becomes an adapter over the same catalog contract.

A complete-file-only loader was rejected because it would satisfy transport
tests while forfeiting the primary UX benefit: early metadata and static
display. A byte-range facade that lets callers read arbitrary sample fragments
was rejected because version 0 digests cover complete unit blobs; fragmented
cache admission could expose bytes before their only integrity check.

### 2.3 Use Fetch and in-memory ownership, not a service worker or Cache API

M7 uses a narrow injectable Fetch adapter and owned in-memory byte stores. It
does not install a service worker, write `CacheStorage`, depend on HTTP cache
partition details, or create a second persistent eviction policy. Browser HTTP
caching may still help normally. Tests inject deterministic responses without
reimplementing loader decisions.

This keeps abort, privacy, entity identity, and byte accounting under one
runtime authority. Persistent/offline caching can be added later around the
same verified-blob interface without weakening M7.

### 2.4 One shared manager owns limits; players own their resources

The page manager grants decoder and byte leases but never manipulates a
worker, frame, bitmap, or GL object directly. Each player remains the sole
owner that can close its resources. Participants expose a bounded reclamation
callback; the manager chooses deterministic victims, then waits for owners to
cover/release before retrying a reservation.

A global pool of reusable `VideoDecoder` objects was rejected. Decoder
configuration, reference chains, callbacks, worker lifetime, and generation
ownership are player-specific; pooling live decoder instances would couple
unrelated assets and make stale-output cleanup unsafe. The shared resource is
permission to own a decoder, not the decoder object itself.

## 3. Package Authority and Runtime Layers

Package boundaries remain inward-facing:

```text
@rendered-motion/format
  owns header/front-index parsing, canonical byte geometry, and complete-file
  validation; it has no Fetch, Web Crypto, DOM, or page-manager dependency

@rendered-motion/player-web
  owns HTTP semantics, Web Crypto digest verification, sparse residency,
  resource leases, visibility/context recovery, and integration with M6

@rendered-motion/graph
  remains unaware of loading, visibility, and memory
```

The M7 player-web path is split into focused owners:

```text
HTTP response grammar --> bounded body reader --> entity-pinned range session
                                                     |
                                                     v
SHA-256 verifier <--> blob assembly/promoter --> sparse runtime catalog
                                                     |
                    page resource manager <----------+--------> M6 player
                         |                                      /       \
                         +--> decoder lease            visibility   GL recovery
                         +--> byte leases                   |           |
                         +--> deterministic eviction         +----static cover
```

No module may both interpret HTTP and choose player eviction. No module may
both hash bytes and decide graph readiness. No module may allocate a browser
resource without a committed lease for its conservative size.

## 4. Asset Session and Catalog Contract

### 4.1 Inputs and lifecycle

The internal loader accepts a closed request shape:

```ts
interface RuntimeAssetRequest {
  readonly url: string | URL;
  readonly integrity?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly credentials?: "omit" | "same-origin";
}
```

Unknown fields are rejected. Credentials default to `same-origin`. Request
headers, methods, bodies, and redirect modes are not asset-controlled. The
injected Fetch adapter exists for tests and hosts, but it must preserve the
same response contract.

`openRuntimeAsset()` returns only after metadata is valid. The returned
`RuntimeAssetSession` owns the entity-pinned loader, sparse catalog, verified
bytes, resource-account leases, operation generation, and abort controller.
It exposes bounded operations to ensure a static blob, one unit blob, all
statics, or all units of one rendition. Disposal is asynchronous, idempotent,
and resolves only after body readers and digest completions retire.

The current in-memory API remains supported. Caller bytes are copied, bounded,
and completely validated exactly once, then exposed through the same catalog
and residency interfaces. There is one downstream scheduler/candidate path,
not separate network and memory players.

### 4.2 Metadata and blob residency

Front-index installation builds the immutable lookup maps already used by
`RuntimeAssetCatalog`. It never allocates storage proportional to a payload
offset or declared file size. Catalog metadata reports the declared file size,
front-index owned bytes, currently verified payload bytes, and exact bytes
required by each rendition/static set.

The catalog has three blob states:

- `absent`: no retained payload bytes;
- `loading`: one generation-owned promise assembles the exact blob; and
- `verified`: an immutable exact-length owned byte array and a memory lease.

Concurrent callers for the same session/blob share one loading promise.
Aborting one caller stops its wait; the underlying request is aborted only
when the session is disposed/superseded or no interested operation remains.
A failed or aborted load returns to `absent`; corrupt bytes are never retained.

Only complete canonical unit blobs and complete static PNG blobs can enter
`verified`. A unit's sample range is a view into its verified blob. The copy
handed to a worker is exact length, freshly owned, transfer-once, and charged
as transient/decoder-input memory until worker acknowledgement. The cache
never exposes its mutable backing array.

### 4.3 Readiness order

The normal preparation order is:

1. fetch and parse the header/front index, then publish `metadataReady`;
2. fetch, internally verify, strictly decode, and cover with the requested
   state's static frame, then publish `visualReady`;
3. fetch, verify, and structurally validate every other state static so a
   complete static mode is available;
4. select one AVC rendition using the existing exact capability ordering;
5. fetch and verify its bootstrap units, then the remaining direct-route unit
   set with at most four response bodies active for the asset;
6. acquire page decoder and candidate byte leases;
7. run the existing M6 all-routes preparation; and
8. publish animated `interactiveReady`, or release animation resources and
   publish `staticReady` with the existing fallback semantics.

The current static request is prioritized over animation bytes. Within one
priority, ranges are ordered by canonical file offset for deterministic traces
and cache-friendly HTTP access. M7 does not weaken the all-routes policy: all
encoded units required by the selected rendition are resident and verified
before animated readiness.

M7 distinguishes terminal animation failures from transient eligibility
blockers. It adds static reasons `visibility-suspended` and `decoder-queued`.
Those two origins may re-enter animation through the serialized fresh-readiness
path when the player becomes visible or receives its FIFO decoder lease. They
are not sticky failures. `resource-budget`, corruption, readiness failure, and
animation failure remain sticky for the current asset generation unless the
host explicitly starts a new preparation. The motion-policy coordinator stays
the owner of reduced/full intent; a small eligibility coordinator composes
motion intent with visibility and decoder-lease availability so these origins
cannot be confused.

## 5. Exact HTTP Contract

### 5.1 Common response requirements

Every Fetch call uses `GET`, the session signal, the narrow credential policy,
and browser-managed redirects. One operation deadline bounds redirects,
headers, and the complete body. The first successful response pins its final
`response.url`; every later response must resolve to the identical final URL.
An opaque response, status `0`, missing body, network rejection, or final-URL
change fails the session.

For any response whose bytes may become an RMA entity, `Content-Encoding` must
be absent or contain exactly one case-insensitive `identity` token after outer
HTTP whitespace is removed. An empty present value, a comma-list, or any other
coding is rejected. This applies to range and full responses because Fetch
normally exposes decoded bodies and exact offsets/digests require identity
representation bytes.

If `Content-Length` is present, it must be one canonical nonnegative decimal
safe integer with no sign, list, or internal whitespace. It must equal the
expected range length when that length is known and must never exceed the
active body/file cap. The observed stream length remains authoritative and is
always checked even when the header is present.

### 5.2 `206 Partial Content`

One range request is `Range: bytes=S-E`, where `S` and `E` are canonical
base-10 safe integers and `E >= S`. A usable response is exactly:

- status `206`;
- one `Content-Range` with grammar `bytes S-E/T` (case-insensitive unit,
  canonical decimal numbers, no wildcard or comma);
- returned start and end equal to the requested inclusive interval;
- concrete total `T` equal to the header's declared file length once known;
- observed body bytes exactly `E - S + 1`;
- absent-or-identity content encoding; and
- the pinned strong ETag once partial responses need to be combined.

Outer optional whitespace around a header value may be trimmed. Whitespace
inside the `Content-Range` grammar, leading zeroes other than the number zero,
suffix/multipart ranges, `*/T`, `S-E/*`, overflow, and multiple values are
rejected. The loader never accepts a helpful-looking subrange and slices it;
the response must be exact.

The initial `bytes=0-63` response establishes `T`. After parsing the header,
its `declaredFileLength` must equal `T`. Every later `206` repeats that same
total.

### 5.3 Strong ETag and `If-Range`

A strong ETag is one syntactically valid quoted entity tag that does not begin
with `W/`. Control characters, an unquoted value, a comma-list, or a weak tag
is not strong. The loader retains the normalized quoted value and compares
later tags by exact code units.

After the first usable partial response, the loader may issue another range
only when a strong ETag is available. Every subsequent request sends that tag
as `If-Range`; every `206` must repeat the identical strong ETag. A missing,
weak, malformed, or changed tag is `entity-changed`, and its body is canceled
without cache admission. `Last-Modified` is never used to combine entities.

The final response URL, strong ETag, declared total, and a session generation
form the range entity identity. Bytes from different identities are never
hashed together, used to complete one blob, or supplied to one player.

### 5.4 Bounded `200` behavior

A `200` can be accepted only as a standalone complete representation; it is
never concatenated with retained partial bytes. It must satisfy the common
encoding/length rules, remain at or below both the 32 MiB format cap and the
host's lower cap, and finish with exactly the length declared by its own valid
header. `validateCompleteAsset()` then rechecks the entire canonical layout.
For external-integrity mode only, the bounded observed bytes are hashed first;
the header length comparison and complete validation happen after that digest
succeeds, so no asset-controlled field is read before the authenticity gate.

The exact cases are:

- if the initial `bytes=0-63` request returns `200`, that response is read once
  as the bounded full representation;
- if an initial `206` has no strong validator, all partial bytes are discarded
  and one new request without `Range` or `If-Range` obtains a bounded `200`;
- if a later range request returns `200`, it may replace all partial state only
  when it carries the exact pinned strong ETag and final URL; otherwise the
  session fails `entity-changed`; and
- a deliberate full request rejects `206`, because accepting a partial body as
  complete would make integrity and length ambiguous.

Only one range-to-full restart is allowed per asset generation. A server that
oscillates between statuses, changes identity, or returns another unusable
response fails rather than causing a retry loop.

### 5.5 Front-index and payload range planning

Range startup first requests exactly bytes `0-63`. Once the header is valid,
it requests `[64, frontIndexEnd)` under the pinned ETag. The combined prefix is
exactly `frontIndexEnd` bytes and is passed to the platform-free
`parseFrontIndex()`; lengths and graph/schema relations are therefore checked
before payload allocation.

Payload requests operate on canonical storage spans. A storage span contains
the zero-padding range immediately before a blob plus the blob itself. The
padding is validated and discarded; only the exact descriptor range is
assembled for hashing. Deterministic adjacent required spans may be coalesced
up to a 4 MiB request target. A single larger legal blob is split into at most
4 MiB HTTP ranges and assembled under the same entity identity. No request or
assembly can exceed the declared file or active file cap.

This planning reduces request overhead while preserving digest boundaries.
Each sub-blob is promoted independently only after its complete digest passes.

## 6. Bounded Bodies, Cancellation, and Watchdogs

The body reader never calls `response.arrayBuffer()` or `blob()` on untrusted
network input. It reads a `ReadableStream` through one reader, checks every
chunk type/length and checked cumulative sum, and cancels immediately on
overflow, unexpected EOF, abort, timeout, or downstream rejection.

Known-length bodies reserve and allocate one exact destination before reading.
Unknown-length full bodies retain bounded chunks, reserving each chunk before
acceptance, then reserve one exact compact destination before copying. The
temporary double residency is charged. A legal 32 MiB full file can therefore
approach the 64 MiB per-player cap during compaction; no decoder/GPU allocation
occurs concurrently with this phase.

There are three deadlines:

- the caller's overall operation deadline, defaulting to the existing
  `prepare()` deadline;
- a two-second default header/first-byte watchdog for each request; and
- a two-second default idle-body watchdog, reset only when a non-empty chunk is
  accepted.

Hosts may lower these values. Raising them is allowed as an explicit runtime
policy but never removes the overall finite deadline. Empty chunks do not keep
a body alive. All timers use an injected monotonic clock/timer host in tests.

Abort linkage is one-way and leak-free: the session controller follows caller
abort, `src` replacement, disconnect, supersession, or disposal. Every
terminal path clears timers, removes abort listeners, calls `reader.cancel()`
when reading has not ended, releases transient byte leases, and awaits the
reader's retirement. A late Fetch, read, or digest completion checks its
generation and releases its result without publishing it.

## 7. Integrity Model

### 7.1 Internal unit and static digests

Manifest SHA-256 values remain lowercase 64-character hexadecimal strings.
For every complete unit or static blob, M7 computes SHA-256 through an
injectable Web Crypto adapter over the exact descriptor bytes. The comparison
decodes both digests to 32 bytes and accumulates XOR differences without an
early mismatch return.

Network assembly memory is quarantine, not cache. Promotion order is:

1. verify exact length and canonical padding;
2. compute and compare SHA-256;
3. for a static blob, run the M6 strict PNG structural/profile validation;
4. commit the persistent cache lease and immutable owned bytes; and
5. allow strict static decode or worker sample copies.

On mismatch, the quarantine bytes and leases are released, all waiters reject
with `integrity-mismatch`, and the blob returns to `absent`. No corrupt byte
reaches a persistent cache, browser PNG decoder, AVC inspector, or worker.

These hashes remain internal consistency checks because the expected values
came from the same untrusted front index.

### 7.2 External whole-file integrity

The host syntax is exactly `sha256-` followed by canonical RFC 4648 standard
Base64 for 32 bytes: 44 characters with the required trailing `=`. Whitespace,
multiple tokens, URL-safe alphabet, options, other algorithms, and noncanonical
padding are rejected before Fetch.

When this value is present:

- the loader sends no `Range` or `If-Range` request;
- it reads one bounded full `200` identity response into quarantine;
- it computes and compares SHA-256 before reading the format header or parsing
  any asset-controlled metadata;
- only a successful comparison promotes the complete byte array and invokes
  `validateCompleteAsset()`; and
- internal unit/static digest and strict profile checks still run as defense in
  depth before those payloads are used.

The external digest's trust root is the host document/application. Version 0
does not provide authenticated early range playback. Trusted per-unit
manifests, signatures, and Merkle proofs remain out of scope.

## 8. Shared Page Resource Manager

### 8.1 Default limits and policy

One manager instance is shared per JavaScript realm/page composition. Tests
and embedding hosts may inject another manager. Defaults are:

- at most two active decoder leases page-wide;
- at most one active decoder lease per player;
- at most `192 * 1024 * 1024` physical tracked bytes page-wide; and
- at most `64 * 1024 * 1024` logical tracked bytes per player.

Hosts may lower any limit. Raising a reference limit requires
`allowUncertifiedHigherLimits: true` and marks manager snapshots
`referenceProfile: false`; no runtime or evidence may label that session
certified.

Players receive opaque monotonic participant IDs. Asset identifiers, URLs,
ETags, and state names are not manager keys and do not appear in shared
diagnostics.

### 8.2 Byte categories and leases

Every simultaneously live allocation is represented before allocation by one
idempotent lease in a closed category:

- metadata/front-index bytes and sparse/full asset storage;
- response/quarantine/assembly and worker-transfer bytes;
- verified encoded unit and compressed static bytes;
- decoder output credits and live decoded surfaces;
- persistent reversible/runway arrays and streaming textures;
- staging/copy buffers;
- strict PNG copies, zlib ownership, inflater scratch, and decoded statics;
- current and incoming static surfaces;
- animated/static canvas backing stores; and
- other explicitly enumerated M6 resource-plan terms.

The manager uses checked integer arithmetic. `reserve()` is transactional: it
either returns a lease for the complete amount or changes no counters. A
resource is allocated only after its lease exists. Allocation failure releases
the lease. Resizing reserves the positive delta before growing and releases
the negative delta only after the old allocation is gone.

Snapshots report per-category reserved bytes, per-player logical totals, page
physical total, decoder owners/queue, pending reclamations, and lease counts.
There is no untracked generic bucket in the reference path.

M7 does not share byte allocations across players. If later work introduces a
page-wide content cache, each player's 64 MiB logical share and the page's
single physical charge must remain distinct.

### 8.3 Decoder leases

A player requests a decoder lease only while visible, full-motion eligible,
and ready to create its worker/decoder candidate. Visible requests form a FIFO
ticket queue. Hidden or disposed participants cannot hold or receive a lease.

When a player hides, falls back, loses its context, replaces its asset, or
disposes, it closes the decoder/worker and releases the lease before another
ticket is granted. The manager never hands one live decoder object between
players. Equal-priority visible players are not periodically preempted; a third
player resolves statically with transient reason `decoder-queued` while its
generation-tagged ticket remains waiting. When one of the two leases becomes
available, the manager grants the oldest visible ticket and triggers a fresh
readiness rebuild behind the static cover. This avoids visible animation thrash
while guaranteeing FIFO progress when a lease is released. Hidden, replaced,
reduced-motion, or disposed players remove their tickets.

### 8.4 Deterministic reclamation

Each participant publishes immutable status:

- visibility: `visible` or `hidden`;
- phase: `loading`, `preparing`, `animated`, `static`, or `suspended`;
- a manager-issued last-touch sequence; and
- exact reclaimable categories/bytes.

On byte pressure, reclamation proceeds in this order:

1. unpinned decoded static surfaces, oldest first;
2. abandoned candidate/transient and unused encoded animation bytes;
3. hidden participants' animation candidates, workers, decoded frames, and GPU
   arrays after their current static cover is committed;
4. lower-priority static/preparing participants' optional caches; and
5. the requester's own optional animation allocation, causing static fallback.

Within one class, the lowest last-touch sequence then participant ID wins.
The current visible static surface, an incoming surface during atomic cover,
front-index metadata needed for state semantics, and verified compressed
statics required for `staticReady` are pinned. A requester cannot evict an
equal-priority visible animation merely to take its place. If the exact
reservation still cannot fit, it fails `resource-rejection` and the requesting
player remains or becomes statically ready.

Reclamation is generation-tagged and serialized. The manager does not hold its
decision lock while awaiting a participant callback. It marks a victim/token,
awaits owner cleanup, then rechecks current counters and requester generation;
late or reentrant callbacks cannot grant stale capacity.

## 9. Static Surface Eviction

Every state static is internally verified and strictly validated before
`staticReady`, but M7 need not retain one decoded `ImageBitmap` per state.
Verified compressed PNG bytes remain pinned fallback material. The decoded
surface cache retains:

- the current covered surface;
- at most one incoming surface during an atomic state swap; and
- optional recently used unpinned surfaces while their byte leases fit.

Unpinned surfaces use deterministic LRU by manager sequence and close on
eviction. Re-requesting an evicted state runs the already validated PNG bytes
through the strict M6 decoder again, reserves the incoming surface, draws it,
then releases the previous current surface. No raw network bytes bypass digest
or PNG validation on re-decode.

If the incoming surface cannot be reserved or decoded, the current surface
stays covered and the request rejects with `PlaybackFallbackError`. There is
never a clear-between-surfaces operation.

## 10. Visibility Suspension and Rebuild

M7 adds a host visibility seam to the integrated player. M8 will feed it from
document/element observation. All visibility changes run through the same
serialized generation lane as preparation, motion-policy transitions,
recovery, and disposal.

On transition to hidden:

1. freeze the rational logical clock at the last committed presentation and
   cancel future animation callbacks;
2. coalesce any hidden-time state requests with latest-wins semantics;
3. ensure the newest committed semantic state's strict static surface covers
   the animation plane;
4. abort speculative payload/decode work and invalidate its generation;
5. close frames, worker, decoder, renderer resources, and persistent arrays;
6. release decoder and animation byte leases; and
7. enter `suspended` while retaining metadata, all verified compressed
   statics, current static pixels, and semantic graph state.

Initial preparation while hidden performs metadata/static preparation and
resolves in static mode with transient reason `visibility-suspended` without
requesting a decoder lease.

On return to visible under full-motion policy, the current static remains
covered while the player obtains a fresh decoder lease, refetches any required
evictable unit bytes under the same pinned entity, creates a fresh candidate,
and reruns complete all-routes readiness. It activates the current semantic
state at canonical body frame zero, does not replay its initial intro, and does
not advance through elapsed wall time. Only a successful first animated draw
reveals the animated plane and restarts logical time. Failure remains usable
static mode under the M6 sticky-failure rules.

Hide/show, reduced/full, context loss, and disposal races are latest-generation
wins. At most one rebuild candidate exists.

## 11. WebGL Context Loss and Recovery

The browser presentation owner registers `webglcontextlost` and
`webglcontextrestored` listeners on the animated canvas and removes them on
disposal. Loss calls `preventDefault()` so restoration is possible, immediately
covers with the already retained current static surface, freezes logical time,
invalidates worker/scheduler output, closes CPU-side frames, and releases
decoder/GPU leases. GL deletion is attempted when meaningful but accounting is
released even when the browser has already destroyed the context.

Restoration never reuses old programs, textures, buffers, frames, candidate
tokens, or decoder output. If the player is visible, full-motion eligible, and
has not entered sticky animation failure, restoration performs the same fresh
body-frame-zero readiness rebuild as visibility resume. The static plane stays
visible until a complete first draw. If loss recurs during restoration or the
fresh preparation fails, the player settles in static mode and does not retry
in a loop.

Context events after supersession/disposal are inert. Static-canvas context
failure is reported as a fallback failure and leaves the host/light-DOM layer
for M8; it is not mislabeled as successful static recovery.

## 12. Errors and Diagnostics

M7 adds stable runtime failure codes for:

- `load-failure`;
- `range-response-invalid`;
- `entity-changed`;
- `integrity-mismatch`; and
- `context-loss`.

It retains `resource-rejection`, `watchdog-timeout`, `abort`, `invalid-asset`,
`renderer-failure`, and the M6 fallback codes. HTTP status, request ordinal,
phase, expected/observed byte counts, declared total, player/page byte totals,
and generation are bounded structured numbers. Messages never interpolate a
URL, ETag, header value, response body, or asset identifier into HTML.

Diagnostics distinguish:

- initial range, front index, payload range, and full fallback;
- internal consistency versus external authenticity failure;
- decoder-count rejection versus byte-budget rejection;
- eviction, hidden suspension, and context recovery; and
- user abort, timeout, entity change, corruption, and unsupported transport.

Snapshots are observations only. They do not expose mutable maps, buffers,
responses, readers, leases, or manager control methods.

## 13. Complete Cleanup and Race Rules

Ownership is hierarchical:

```text
page participant
  -> asset session generation
      -> fetch controllers/readers/timers
      -> quarantine and verified byte leases
      -> sparse catalog and static surfaces
      -> candidate worker/decoder/frame/GPU leases
      -> visibility/context listeners and animation callbacks
```

`src` replacement creates a new generation only after aborting the old one;
old bytes are never reused based on URL alone. Disposal first marks the root
terminal so no callback can publish, then aborts network/digest waits, stops
the realtime driver, closes candidate resources, closes static surfaces,
releases byte/decoder leases, removes listeners, unregisters the participant,
and settles queued operations. Pending public-facing waits reject once with
`AbortError`.

Every close/release is idempotent. Every transferred `ArrayBuffer` has one
owner at a time. Every decoded `VideoFrame` and `ImageBitmap` counter reaches
zero. Every body reader, timer, request waiter, decoder ticket, reclamation
token, animation callback, and event listener retires before `dispose()`
resolves. Cleanup exceptions are normalized and do not stop later cleanup.

## 14. Verification and Evidence

### 14.1 Unit and property coverage

Deterministic fake Fetch/stream tests cover:

- exact header/front-index range startup and request headers;
- every malformed `Content-Range`, `Content-Length`, encoding, status, URL,
  and ETag class;
- initial and later bounded `200`, no-validator full fallback, and the one
  restart limit;
- truncation, overflow, empty-chunk stalls, late chunks, read rejection,
  redirect-final-URL change, abort at every phase, and watchdog expiry;
- internal unit/static corruption before cache/decode;
- valid, malformed, mismatched, and tampered external integrity;
- range coalescing/splitting, padding validation, and out-of-order completion;
- concurrent waiters, generation replacement, and stale digest completion;
- exact byte/decoder lease arithmetic and reservation rollback;
- three or more competing players, FIFO decoder progress, deterministic
  victim order, equal-visible non-preemption, and lower host caps;
- decoded static eviction/redecode with uninterrupted coverage;
- hide during every preparation/playback phase, hidden state requests,
  repeated hide/show, and no elapsed-time fast-forward;
- context loss before/during/after readiness and repeated-loss stickiness; and
- disposal/resource snapshots at zero after every rejection.

Mutation/property tests generate response grammar, chunk boundaries, body
lengths, entity changes, reservation/release schedules, and lifecycle event
orders. All arithmetic and allocation remain bounded under hostile inputs.

### 14.2 Real browser proof

A deterministic local HTTP fixture serves one compiler-produced M6 asset with
configurable response behavior. The Chromium proof uses real Fetch streams,
Web Crypto, module worker, `VideoDecoder`, WebGL2, strict PNG decode, canvas
readback, visibility calls, and synthetic context loss/restoration.

The successful report records exact requested ranges, statuses, totals,
validators, response/body peaks, digest counts, first-static timing order,
selected rendition residency, decoder/page peaks, eviction order, suspend and
resume traces, canonical resume frame, context rebuild, underflows, and final
cleanup. Separate scenarios prove ignored ranges, missing strong ETag, entity
change, corrupted unit/static bytes, external-integrity mismatch, stalled body,
and three-player decoder pressure.

The browser result is functional M7 conformance on its recorded environment.
It does not claim observed-display continuity or named-device performance.

## 15. Non-goals

M7 does not include:

- a compiled wire revision or authenticated range extension;
- signatures, trusted manifests, Merkle trees, or per-unit host integrity;
- multi-range/multipart HTTP responses;
- resumable partial blobs across asset sessions;
- persistent or cross-player byte caches;
- a reusable decoder-object pool or more than one decoder per player;
- fast-forward after hidden time;
- automatic DOM visibility/engagement/media-query wiring;
- a public custom-element name or framework wrapper;
- service workers, offline authoring, CDN configuration automation, or
  telemetry transport; or
- M9 certification or compositor scan-out claims.
