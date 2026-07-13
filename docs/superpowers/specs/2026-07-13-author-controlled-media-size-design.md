# Author-controlled media size design

## Goal

Remove the pre-production product-policy ceilings that prevent authors from
compiling and playing large Rendered Motion assets. The compiler must preserve
the exact canvas and rendition dimensions requested by the author. It must
never silently resize, shorten, sample, or otherwise reduce authored media.

Wire format `0.1` changes in place because it has not entered production. The
reader continues to identify the format as `0.1`; no compatibility promise is
made for earlier prototype readers that reject the newly valid values.

## Scope

Remove fixed media-size ceilings from every layer that currently enforces them:

- 512-pixel canvas, rendition, PNG, alpha-plane, and presentation limits;
- 4,096-pixel source dimensions;
- 30-second and 1,800-frame source limits;
- 900 referenced-unit-frame and direct-loop limits;
- 24-frame reversible-unit limits;
- 32 MiB compiled-file and runtime media-byte limits where they act as asset
  validity checks; and
- fixed probe/decode output ceilings whose only purpose is to recreate those
  media-size policies.

Graph-complexity limits such as state, edge, unit, rendition, port, and binding
counts remain. Trace capacities, diagnostic message lengths, network batch
sizes, process stderr limits, and other operational bounds unrelated to media
dimensions or duration also remain.

## Authoritative dimensions and timing

Project `canvas`, `renditions`, `frameRate`, source timing mode, and unit frame
ranges remain explicit author input. The compiler follows those values exactly.
A source may be larger than a chosen canvas only when the project explicitly
requests that canvas, which is an author-directed resize rather than automatic
downscaling. The compiler never invents a smaller rendition.

All frame ranges remain half-open and integral. Representational boundaries
remain where the wire encoding or JavaScript requires them: nonnegative safe
integers, PNG's unsigned 32-bit dimensions, and checked offset/length arithmetic.
These are format correctness constraints, not small product-policy ceilings.

## Compiler architecture

Media probing must scale with authored duration instead of accumulating an
arbitrarily capped JSON response. Constant-frame-rate video can derive its
canonical grid from validated stream metadata and bounded incremental checks.
Variable-frame-rate normalization must process frame timing records
incrementally or through a private spool so memory does not grow solely because
the source is long. PNG sequence discovery must iterate exact declared names
without directory-size multiplication limits.

RGBA materialization, alpha audit, encoding, decode-back validation, and build
reporting may consume substantial author-machine memory or disk. Each
allocation and byte calculation must be checked before use, and allocation or
tool failures must identify the operation and requested size. They must not be
converted into a smaller output.

## Format and static decoding

The `FormatBudgets` contract stops treating file bytes, total unit frames, and
reversible frames as validity ceilings. Header, layout, index, manifest, writer,
AVC inspection, and graph adaptation retain exact checked arithmetic and
representational validation.

Strict PNG validation derives the exact inflated byte count from the validated
IHDR dimensions, color format, and scanline layout. Deflate decoding receives
that exact expected length and rejects short, long, or overflowing output. It
must not allocate from unchecked compressed data or use a fixed 512-derived
output buffer.

## Browser runtime behavior

The player accepts the authored dimensions and media lengths from a valid
asset. Before allocating, it checks arithmetic and queries actual browser or
GPU capabilities where available. WebCodecs configuration rejection, WebGL
texture-size/layer limits, typed-array allocation failure, GPU allocation
failure, and page resource exhaustion produce explicit normalized failures.

The runtime never retries with a smaller canvas, lower rendition, shortened
path, reduced frame cache, or altered frame rate. An author who selects media
larger than a target browser can support receives a fallback/error result and
must publish a different asset if broader support is desired.

Page-wide resource accounting remains accurate, but fixed 32 MiB admission
policy cannot make an otherwise representable asset invalid. Accounting may
still reject when a concrete browser allocation or configured host policy
cannot be satisfied. No new implicit host default cap is introduced.

## Public documentation

Add a compiler authoring guide that documents:

- accepted `.mov`, `.mp4`, `.m4v`, and numbered PNG inputs;
- constant-frame-rate, progressive, square-pixel, zero-rotation expectations;
- transparent-source guidance;
- timeline layout and half-open frame ranges;
- `sources`, `units`, `states`, `edges`, posters, and bindings with a complete
  multi-state example;
- compile, development, inspect, and validate commands;
- exact author-controlled canvas/rendition behavior; and
- platform-dependent failure behavior for large assets.

Update the compiler, project, format, performance, browser-support, and
security documentation so none claims the removed ceilings and all distinguish
author responsibility from structural validation.

## Failure handling

Malformed or malicious assets must still fail before unsafe arithmetic or an
out-of-bounds read. Size-related failures must use the narrowest available
category: invalid representation, unsupported codec/device capability,
allocation/resource exhaustion, or external tool failure. Generic rejection
solely because a valid value crosses a former policy constant is prohibited.

The compiler writes atomically as before. A failed large compilation must not
replace an existing output or retain private spools after cleanup.

## Verification

- Unit tests cross every former dimension, duration, frame-count, unit-frame,
  reversible-frame, and file-byte ceiling.
- Parser and decoder tests retain hostile overflow, truncation, excessive
  output, and digest checks using dimensions beyond 512.
- Compiler integration proves exact dimensions and frame ranges above the old
  limits without implicit resizing.
- Browser tests prove a representable asset above 512 pixels and a deterministic
  device-limit failure without downscaling.
- Existing ordinary-size fixtures remain byte-valid and playable.
- Documentation examples are checked by the repository documentation gate.

## Non-goals

- Removing graph-complexity limits unrelated to media size.
- Guaranteeing that every browser can decode or allocate every authored asset.
- Automatically choosing responsive renditions or adapting quality.
- Changing frame-rate semantics, state-graph semantics, or the public element
  control API.
