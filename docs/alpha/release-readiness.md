# aval-alpha release readiness audit

Audited 2026-09-05 against the repository's React/Svelte implementation plans,
publication runbook, release package model, CI, API, consumer, documentation and
security checks. This is a release-completeness audit following the
[code quality review](./code-quality-review.md).

The implementation has useful local preview evidence. It does not yet have the
release coverage used for the existing public packages. No packages were
published and no release versions or publication policies were changed here.

## Work needed before publication

### 1. Make the existing alpha tests required and retain their evidence

- [ ] Run `test:alpha:browser` in CI. The current alpha job runs the framework
  suite only; the separate core/element suite covers source fallback, CORS,
  timeout, context loss and operation without WebCodecs/video frame callbacks.
- [ ] Run `test:alpha:media` in CI with the requested FFmpeg encoders installed.
  Its six integration cases are skipped by default. `alpha:fixtures` generates
  media but does not replace the integration suite.
- [ ] Add an aggregate alpha verification command to the applicable release
  gate. The existing release gate invokes neither alpha browser suite, the
  opt-in media suite, nor the alpha size/pack checks.
- [ ] Upload alpha browser reports, failure artifacts, compiler reports and
  bundle measurements. The alpha CI job currently has no artifact upload step.

Existing coverage: workspace unit discovery includes alpha tests, and source CI
runs alpha typechecking, size gates and packed-consumer checks. The framework
browser job generates media and exercises Chromium, Firefox and WebKit.

### 2. Add public API snapshots for every alpha entry

- [ ] Add API Extractor configurations and checked-in reports for the core,
  `./element`, `./adapter`, React and Svelte exports.
- [ ] Include these entries in API verification and experimental API
  classification without tying their version to the interactive package set.

The compiler's `./alpha` report is already included. Running the existing API
extractor and classification commands passed, but they reported six packages
and eight entry points; none of the three alpha runtime packages is included.
Typechecking consumers does not detect all accidental public API changes.

### 3. Complete the independent alpha release transaction

- [ ] Define version bump, prepare, inspection, publish, registry verification,
  promotion and rollback handling for the three alpha packages.
- [ ] Reuse the existing release machinery's fresh-build provenance and stale
  output rejection, immutable archive/index checks and dependency validation.
- [ ] Include package notices and per-package SBOM generation/validation, and
  connect archive scanning to the alpha gate.
- [ ] Document which compiler release supplies `avl alpha` and the
  `@pixel-point/aval-compiler/alpha` export.

Keeping alpha at its own 0.1.0 version was intentional. Adding it blindly to the
six-package synchronized release is not the fix. The current `alpha:pack`
script validates local archives and consumers; it is not an independent
publication transaction. The existing release/SBOM tools derive their package
set from the six-package model and therefore omit alpha.

All three packages contain an MIT license. They do not contain the
`THIRD_PARTY_NOTICES.md` included by the existing release packer. Applicable
notice contents should reflect actual distributed code and declared peers.

### 4. Execute the delivered artifacts end to end

- [ ] Install the alpha archives in isolated applications and run their
  production browser output through transparent playback and hydration tests.
- [ ] Add a packed compiler `avl alpha` smoke test that compiles media and feeds
  the generated source descriptors to the packed runtime.
- [ ] Add TypeScript NodeNext consumer coverage where applicable, alongside
  the existing bundler-resolution checks.

Current core/element browser tests resolve source files through Vite aliases.
Framework browser tests use workspace-built package exports through a Vite dev
server. Packed tests verify imports, declarations, SSR and production bundle
creation, but do not execute that production bundle in a browser. Previous
release tooling separately checks reference and production execution.

### 5. Finish the public documentation and repair failing shared gates

- [ ] Add a release note and independent versioning/publication instructions.
- [ ] Link alpha from the compiler, quick-start and browser-support guides;
  clarify the separate package versions in `docs/versioning.md`.
- [ ] Add consumer recipes for reduced motion, poster/error presentation and
  hosting/CSP. Keep application policy out of the small runtime.
- [ ] Include alpha examples in packed example verification and the required
  documentation list. Current package READMEs, framework contract, demo and
  verification report already cover the main APIs and compiler options.
- [ ] Repair the existing documentation version assumptions and stale
  `react-ref` lock root. Re-running `docs:check` produced eight failures.
- [ ] Resolve the existing license-policy records through the repository's
  review process. `licenses:check` reports 16 failures; evaluating the committed
  lockfile and policy produces exactly the same 16, with no additions from
  alpha. They still prevent a completely green workspace gate.

The release metadata file also remains pending. This audit did not change or
approve publication identity or license-policy records.

## Qualification beyond a local preview

- [ ] Test shipping Safari/iOS, Android and Windows on the intended devices.
  Playwright engines running on one Mac do not establish those combinations.
- [ ] Measure representative production clips: bytes received before first
  transparent draw, startup latency under throttling, dropped frames, upload
  cost, memory and repeated/background playback.
- [ ] Exercise React 18.3 and the intended Svelte minimum, or narrow documented
  support to the tested versions. Current browser evidence uses React 19.2.7
  and Svelte 5.56.8.
- [ ] Execute the optional libaom encoder and qualify 10-bit browser playback.
  Existing evidence covers SVT-AV1 and 10-bit compilation.

These limits were already disclosed in [verification evidence](./verification.md).
They matter to broad compatibility and performance claims. Interactive AVAL
graph routing and wire-format mutation certification do not apply wholesale to
the alpha runtime, which delegates container parsing and decoding to browsers.

## Skills

No AVAL-specific `SKILL.md`, `AGENTS.md` or skill bundle was found in tracked
repository files or its available Git history. The checked local skill
directories also contain no AVAL-specific skill. There is therefore no
identified existing release skill to update here. A dedicated consumer skill
could guide compilation, source ordering and JS/React/Svelte integration, but
would be a new deliverable rather than a missing update to a located skill.

## Checks performed for this audit

- Existing API reports: passed, six packages/eight entry points; alpha runtime
  packages excluded as described above.
- API classification: passed, six packages.
- Security artifact scanner: passed for all three current alpha tarballs.
- Documentation gate: failed with eight example/version/lock-root findings.
- License gate: failed with 16 policy findings, identical to committed HEAD.

Previously passed runtime, media and browser results remain recorded in the
verification report. They were not rerun for this documentation-only audit.
