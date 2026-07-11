# M2 Resident Reversible Interaction Design

**Date:** 2026-07-11

**Status:** Approved implementation slice of the [Web Rendered Motion Format Design](./2026-07-11-web-rendered-motion-format-design.md)

## 1. Objective

M2 proves that a short authored interaction can reverse on the next eligible
content-frame boundary without seeking, decoding backward, or waiting for a
decoder. It also proves that either endpoint body can recover while a bounded
resident runway is being presented.

This milestone is an internal browser experiment. It accepts arbitrary source
and target state identifiers, but it does not expose the public graph, route
promises, or DOM events. Those belong to M3 and M8.

## 2. Chosen Architecture

M2 is a new vertical slice beside the M1 loop experiment:

1. a browser-independent resident-frame plan validates and freezes texture
   layers before any GPU allocation;
2. a WebGL2 renderer owns one immutable `RGBA8` texture array, one reusable
   tightly packed RGBA staging buffer, and bounded streaming slots;
3. a generation-aware sequential path decoder submits only one selected body
   path through one configured `VideoDecoder`;
4. a pure reversible controller turns queued intent into one presentation
   command per content tick; and
5. a thin player coordinates the rational clock, renderer, decoder, visibility,
   context recovery, and diagnostics.

The M1 `ContinuousLoopDecoder` and `LoopCanvasPlayer` remain unchanged. Their
single-unit, chronological contracts are already proven and are not suitable
places for branching, resident layers, or WebGL state.

Rejected alternatives are an `HTMLVideoElement` seek/reverse path, which can
stall at every direction change; an `ImageBitmap` array, which does not prove
the specified GPU layout or accounting; and retaining every body frame, which
would avoid rather than prove bounded decoder recovery.

## 3. Resident Frame Plan

The plan receives three ordered sequences of stable source-frame identities:

- source endpoint runway;
- reversible clip; and
- target endpoint runway.

Identity is semantic: rendition, unit, and local frame index. Frames are never
deduplicated by pixel comparison. Repeated identities share one array layer.
The complete mapping is frozen before WebGL allocation.

The plan rejects work before allocation unless all of these hold:

- the reversible clip contains 1–24 frames;
- each endpoint runway contains 6–12 frames;
- the reversible clip's raw RGBA bytes do not exceed 24 MiB;
- unique resident layers do not exceed 128 or the device's
  `MAX_ARRAY_TEXTURE_LAYERS`;
- width and height do not exceed `MAX_TEXTURE_SIZE`;
- deduplicated resident texture bytes do not exceed the 48 MiB edge cap; and
- the player working set does not exceed 64 MiB.

For M2, the tracked player working set is deliberately conservative:

```text
(resident texture bytes + three streaming frames) × 1.25
  + one width × height × 4 staging buffer
```

The 24 MiB clip cap and 48 MiB edge cap apply to logical deduplicated RGBA
texture bytes. The conservative allocation estimate and staging buffer count
toward the 64 MiB player cap. Page-wide arbitration remains M7 scope.

## 4. Upload and Rendering Contract

Every decoded frame must have the exact declared display and visible
dimensions. Padded H.264 coded dimensions are accepted under the existing M1
bounds. `VideoFrame.copyTo()` copies only the visible rectangle into the one
reused buffer using `format: "RGBA"` and a tight `width × 4` stride.

Upload is sequential. The borrowed `VideoFrame` stays open until `copyTo()` and
`texSubImage3D()` complete, then closes in `finally`, including every error and
stale-generation path. Presentation uses only resident layer handles or a
generation-tagged streaming handle; it never reads a closed `VideoFrame`.

The renderer draws a full-canvas triangle through a `sampler2DArray`. Packed
alpha is not introduced until M6. GPU readback may validate which layer was
drawn, but it is runtime correctness evidence rather than physical scan-out
evidence.

## 5. Reversible Controller

The controller has no DOM, codec, GL, or timer imports. Its two endpoint names
are opaque creator-supplied strings. Its internal phases are:

- stable source or target;
- waiting for an endpoint portal;
- active clip, forward or reverse; and
- source or target runway.

Requests received between content ticks are sequence-numbered and coalesced at
the next tick, with at most 32 retained inputs and the newest intent preserved.
Diagnostic history is a bounded 256-tick ring. That tick is the next eligible
content frame. The controller performs no direction change between ticks.

The exact frame rules are:

- stable source to target waits for an injected source-portal signal, then
  draws clip frame zero;
- stable target to source waits for a target portal, then draws clip frame
  `N - 1`;
- inverse intent while merely waiting cancels without drawing a clip frame;
- after clip frame `k > 0` was drawn while moving toward target, inverse intent
  makes the next eligible tick draw `k - 1`;
- after clip frame `k < N - 1` was drawn while moving toward source, inverse
  intent makes the next eligible tick draw `k + 1`;
- inverse intent after forward clip frame zero draws source runway frame zero
  next, while inverse intent after reverse clip frame `N - 1` draws target
  runway frame zero next;
- the previously displayed frame is never deliberately repeated at a reversal;
- a duplicate request for the current prospective endpoint continues the clip
  without restarting its cursor;
- after clip frame `N - 1`, the next tick draws target runway frame zero and
  commits the target visual state;
- after clip frame zero in reverse, the next tick draws source runway frame
  zero and commits the source visual state; and
- clip frames and runway frames are separate half-open authored sequences.
  The compiler will later validate both seams and reject duplicated endpoint
  images.

M2 permits one opaque latest follow-on intent during an active clip only when
an injected `canFollow(prospectiveEndpoint, destination)` policy accepts it.
The controller emits that token after endpoint commit. It does not route it.
This proves coalescing without prematurely implementing M3.

## 6. Decoder Recovery

All resident frames are prepared before interaction. Preparation may create,
flush, and close decoders because no advancing playback is yet promised.

Interactive playback owns one configured path decoder. On transition start it
submits the prospective body from its frame-zero key access unit with monotonic
decoder timestamps and a new path generation. Cached runway frames
`[0, R)` cover the same semantic body interval; matching decoder outputs are
closed as warm-up duplicates. Body frame `R` must be decoded, uploaded into the
streaming ring, and ready before the presentation cutoff of the content tick
immediately following cached runway frame `R - 1`.

An active reversal increments the path generation, bounds any obsolete input
horizon, closes stale outputs, and submits the opposite body. It never resets,
reconfigures, or flushes at that runtime boundary. M2's reference fixture uses
fixed eight-frame runways and gates readiness on a sequential preflight of both
directions, including one content-frame margin. If either measured direction
needs more than eight frames, readiness fails instead of weakening the
guarantee. Selecting the shortest passing runway from 6 through 12 frames is a
compiler responsibility in a later milestone.

## 7. Lifecycle

Logical time freezes while hidden, rebuilding, context-lost, or paused. Hiding
may release resident textures. WebGL context loss invalidates every GPU handle
without changing the committed semantic endpoint. M2 restoration performs
fresh preparation from that committed endpoint and reapplies the newest
requested intent before advancing the clock. It does not claim exact in-flight
clip-cursor restoration; context loss itself is outside the continuous visual
guarantee.

Resource generation is distinct from path generation. A late asynchronous
upload from an old resource generation and a decoder output from an old path
generation are both closed and ignored. Disposal is idempotent and removes
listeners, cancels animation callbacks, closes decoder outputs, deletes GL
resources, and settles preparation without use-after-close.

## 8. Fixture and Playground

The browser fixture chooses one supported codec configuration and encodes three
compatible independently decodable units: source body, reversible clip, and
target body. The reference interaction uses a 12-frame clip and 8-frame
runways at 256 × 256. Tags encode both unit identity and local frame index.

The playground presents a semantic host control whose hover/focus engagement
drives arbitrary fixture states such as `resting` and `engaged`. It shows phase,
direction, clip cursor, requested and visual states, path generation, recovery
lead, resident layers and bytes, closed source frames, stale outputs, context
generation, and underflows. A deterministic accelerated action runs a separate
controller against the same renderer to validate cached layer ordering without
waiting in real time; it is not a realtime decoder-recovery proof.

## 9. Verification Gate

M2 passes only when unit and Chromium tests prove:

- active inverse intent draws the adjacent reverse clip frame on the next tick;
- pending inverse intent draws no clip frame;
- multiple inputs in one interval converge to the newest accepted intent;
- one valid latest follow-on token survives and invalid tokens do not mutate
  state;
- exact resident and streaming frame-key order contains no deliberate endpoint
  duplicate, missing layer, or underflow;
- both endpoint bodies recover before their measured runways end;
- the interactive decoder records one configure, zero reset, and zero boundary
  flush calls;
- cache planning rejects every layer, dimension, clip, edge-byte, and
  player-byte overflow before allocation;
- source frames close exactly once after upload and are never used again;
- injected and real `WEBGL_lose_context` paths freeze and rebuild correctly;
- hide/rebuild and dispose-during-prepare cannot resume stale work; and
- all GPU, decoder, callback, and frame counts reach zero after disposal.

The evidence report will separate controller/renderer correctness from actual
display scan-out, just as M1 did.

## 10. Non-goals

M2 does not freeze the binary container, expose a public state graph, implement
promise settlement or public events, compile user media, add packed alpha,
arbitrate page-wide memory, or claim mobile or physical-display certification.
