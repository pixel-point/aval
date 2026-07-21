# Incremental Codec Validator Consolidation Implementation Plan

> **For agentic workers:** Execute this plan inline. The task explicitly forbids commits.

**Goal:** Make `@pixel-point/aval-format` the sole executable codec-payload admission authority while preserving element's lazy unit-by-unit validation behavior.

**Architecture:** A format-owned incremental validator will compose the existing AV1, VP9, H.264, and H.265 inspectors once per independently decodable unit. It will retain only immutable scalar continuity state between calls, while the element package becomes a thin error-boundary adapter.

**Tech Stack:** TypeScript, Vitest, npm workspaces

---

### Task 1: Add format-owned incremental validation tests

**Files:**
- Create: `packages/format/test/video-payload-validator.test.ts`
- Create: `packages/format/test/video-payload-validator-fixture.ts`

- [ ] Move the four-codec conformance, truncation, key/display assertion, cross-unit continuity, retired declaration, exact codec, VP9 completion, and HEVC byte-budget cases from the element-specific test.
- [ ] Add typed `FormatError`, validate-after-complete, complete-before-validate, timestamp/presentation-order, and non-retention coverage.
- [ ] Run the focused test and confirm it fails because `createVideoPayloadValidator` is not exported yet.

### Task 2: Implement the canonical incremental validator

**Files:**
- Create: `packages/format/src/video/payload-validator.ts`
- Modify: `packages/format/src/index.ts`

- [ ] Define `VideoPayloadValidationProfile`, `VideoPayloadValidationChunk`, and `VideoPayloadValidator`.
- [ ] Validate and clone the profile once, dispatching through `parseVideoCodecString`.
- [ ] Adapt each unit to its existing canonical inspector without retaining caller byte views.
- [ ] Preserve H.264/H.265 exact parameter-set continuity with the existing Annex-B and parameter-set parsers.
- [ ] Preserve timestamp-to-presentation ordering from inspector output.
- [ ] Preserve AV1 sequence continuity and exact codec admission.
- [ ] Preserve VP9 per-unit capacity admission and rendition-global exact codec derivation at `complete()`.
- [ ] Normalize every validation failure to `FormatError("PROFILE_INVALID", ...)` and keep `complete()` idempotent.
- [ ] Export the public API and run format typecheck plus focused tests.

### Task 3: Reduce element to a boundary adapter

**Files:**
- Replace: `packages/element/src/codec-validator.ts`
- Modify: `packages/element/test/codec-validator.test.ts`

- [ ] Replace local parsing with a wrapper around `createVideoPayloadValidator`.
- [ ] Map `FormatError` to the existing `Error("Invalid AVAL encoded payload")` boundary while preserving unexpected errors.
- [ ] Retain only end-to-end acceptance and boundary-mapping integration tests in element.
- [ ] Run element typecheck and codec/player-focused tests.

### Task 4: Verify the complete refactor

**Files:**
- Verify all files above.

- [ ] Run format and element typechecks.
- [ ] Run all format codec tests, element codec/asset/player selection and startup fallback tests.
- [ ] Run `git diff --check` and inspect the final diff for duplicate parser code or caller-owned byte retention.
- [ ] Do not commit.
