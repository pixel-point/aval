# Latest-Only Architecture Cleanup Design

## Status

Approved by the user on 2026-07-20. AVAL is in technical preview and makes no
backward-compatibility promise for earlier library APIs or wire formats.

## Goal

Make the repository describe and implement only the architecture exercised by
the current compiler and working demos. Remove legacy parsers, codec spellings,
compatibility aliases, frozen old-format fixtures, and contradictory release or
documentation policy without weakening the current AV1 -> VP9/HEVC -> H.264
runtime fallback ladder.

## Sources of truth

- Compiler project schema: `1.0`.
- AVAL wire format: `1.1` only.
- Compiler build-report schema: `1.0`.
- Browser support: the rolling 24-month certification policy in
  `scripts/browser-compatibility/certification-policy.json`.
- Codec declarations in manifests and source MIME types: the exact canonical
  strings emitted by the current compiler.

Other uses of the number `1.0`, such as worker or report protocol versions, are
not legacy merely because they share that number.

## Architecture

### One format model

`@pixel-point/aval-format` owns the wire header, manifest model, canonical JSON,
codec-string validation, and asset parsing rules. Wire-1.0 model variants and
writer support are deleted. A wire-1.0 header is rejected at the format boundary
as an unsupported version; no old manifest is parsed or migrated.

Element and player packages consume the current format types. Element retains
HTTP range acquisition, integrity verification, resource accounting, and
lifecycle ownership, but must not define an alternative wire or codec schema.
Where the element loader needs prefix parsing that the format package does not
currently expose, the smallest bounded parser primitive is added to the format
package rather than copying validation logic.

### Canonical codec declarations

The supported runtime ladder remains AV1, VP9, HEVC, then H.264. H.264 uses the
compiler's constrained-baseline declarations. Legacy H.264 High-profile public
types and lookup helpers are removed. Abbreviated VP9 and AV1 strings are not
valid manifest or source declarations.

Current libx264 constrained-baseline normalization remains because it is part of
the active compiler pipeline, not backward compatibility.

### Current public APIs only

Compatibility-only aliases, no-op constants, optional flags, restoration modes,
standalone queue paths, and nullable legacy decoder metadata are deleted when no
working demo or current production owner uses them. Canonical call sites are
updated before aliases disappear.

### Preview release policy

Release metadata must state the current project and wire versions and must not
classify the entire technical-preview API as stable by default. The release
browser matrix is derived from, or directly consumes, the canonical rolling
browser policy so two authorities cannot drift.

Documentation and examples describe only the current compiler output and codec
ladder. Historical design/evidence records remain historical unless an active
test or user workflow treats them as current instructions.

## Error behavior

Unsupported wire versions and unsupported codec declarations fail early with a
typed terminal error. AVAL does not render owned fallback media. Applications
remain responsible for images, non-interactive video, or other fallback UI.

## Deletion boundaries

Remove:

- wire-1.0 public models, parser/writer branches, tests, and conformance fixtures;
- H.264 High-profile and short AV1/VP9 declaration support;
- duplicated element schema logic once canonical format APIs replace it;
- compatibility-only player APIs and tests;
- stale release matrices, version metadata, and current-facing documentation.

Keep:

- project/report/protocol versions that are still the single current contract;
- AV1 -> VP9/HEVC -> H.264 selection and failover;
- HTTP full-fetch fallback when range transport is unavailable;
- integrity, payload inspection, browser qualification, and typed errors;
- historical specs/evidence that are clearly records rather than live guidance.

## Verification

Each deletion slice starts with focused tests, updates current fixtures and
examples, and then runs package tests, type checks, builds, docs/release gates,
fixture validation, and browser-facing demo smoke tests. The final strict review
must confirm that compatibility branches were deleted rather than renamed or
moved and that no new large duplicate parser was introduced.
