# aval-alpha code quality review

Reviewed the current alpha runtime, compiler, React/Svelte adapters and their
repository integration using the thermo-nuclear code quality review criteria.
The changes below address reproduced defects and clear structural improvements.

## Fixed findings

1. **Player ownership was split across unrelated mutable fields.** The binding
   tracked the player, event controller and numeric generation separately. It
   announced loading before installing the player, retained failed players and
   listeners, and could deliver an old error to a replacement's callback.
   `adapter-binding.ts` now owns a single session containing the player and its
   listeners. Installation precedes notification, one release path disposes both,
   and session identity rejects stale completions. Regression tests reproduced
   all three failures before the change.

2. **Pending element commands could affect a replacement player.** The element
   awaited readiness, then read its mutable player field again. A seek issued for
   one source could therefore seek its replacement. Commands now capture the
   player they prepared. Readiness and disposal checks share one path. Autoplay
   reads the current attribute after loading, so removing it during startup is
   respected; stale autoplay failures do not dispatch into a new player.

3. **Validation did not establish a stable input boundary.** Sparse rectangle
   arrays passed checks because `Array.some()` skips holes. Startup validation
   was also repeated between the player and framework configuration. Both now
   use one validation function, including dense source traversal. Element layout
   parsing constructs explicit tuples instead of double-casting array slices.
   The compiler now detaches validated optimization thresholds, CRF arrays and
   preset arrays before asynchronous work, preventing later caller mutation from
   changing an already validated compile.

4. **Horizontal packing performed a redundant full-frame conversion.** The alpha
   compiler first created a vertical packed frame, then allocated and copied a
   second packed frame for portrait clips. The existing canonical surface
   composer now honors either validated mask position directly. The horizontal
   repacking function and its extra full-frame allocation are deleted. Existing
   vertical composition, neutral padding and color dilation remain covered by
   tests; horizontal placement has a direct pixel test and real encoding checks.

5. **Compression and selection used the wrong boundaries.** The alpha encoder
   fabricated AVAL rendition objects and cast them into the normalized project
   model just to obtain compression arguments. The canonical argument helper now
   accepts only the compression fields and CRF it actually consumes. Candidate
   selection is a pure operation on one codec's attempts, with stable ties and
   Pareto marking; it no longer mutates a global cross-codec report. Encoder
   naming has one definition, and selection reuses the winning probe and byte
   count instead of launching another FFprobe process and reading file size again.

6. **Packaging repeated the same transaction.** The old scripts packed the core
   twice. One orchestrator now packs each package once and uses those archives
   for both the isolated core consumer and framework consumers. Dependency
   checks derive the expected core version from its manifest instead of embedding
   another release-version constant.

No handwritten changed file crossed 1,000 lines. Generated API reports and the
lockfile were already above that size and are not decomposition candidates.
The existing React/Svelte API shape, framework peer boundaries, codec controls
and publication isolation remain intact. No additional runtime dependency was
introduced.

## Verification

- Alpha unit/SSR checks: 57 passed; six opt-in media checks skipped in this run.
- Opt-in compiler checks with real FFmpeg: 31 passed, including all six media
  integration cases, all four codecs, portrait/10-bit output and quality search.
- Architecture and affected canonical compiler tests: 62 passed.
- Full workspace TypeScript/Svelte checking passed.
- Core/element browser suite: all six Chromium/Firefox/WebKit runs passed,
  including runs without WebCodecs/video frame callbacks and the new element
  command/autoplay regressions.
- Framework browser suite: all six runs passed. An earlier run overlapped a
  package rebuild and one test was interrupted by Vite reloading the page; the
  complete suite passed after builds finished.
- Packed consumers, SSR, production bundle checks and architecture gate passed.
- Original size gates passed without relaxing their limits: core 3,606 gzip
  bytes; core plus element 4,600; React 4,952; Svelte 5,139. Framework totals
  include player/binding code and exclude framework peers and media files.

No unresolved blocking finding remains from this review. This is a maintainability
and local regression review, not additional physical-device certification. The
previously recorded unrelated docs/release version-pin failures remain outside
this change. See [verification evidence](./verification.md) for device limits and
the complete byte measurements.
