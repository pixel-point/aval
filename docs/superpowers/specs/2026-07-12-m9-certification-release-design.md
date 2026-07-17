# M9 Certification and 1.0 Release Design

**Date:** 2026-07-12

**Status:** Approved roadmap refined into the final certification and release
slice

**Authority:**

- [AVAL Format Design](2026-07-11-aval-format-design.md)
- [AVAL Implementation Plan](../plans/2026-07-11-aval-implementation.md)
- [M5.5 Integrated Scheduler and Readiness Design](2026-07-12-m55-integrated-scheduler-readiness-design.md)
- [M6 Transparency and Static Fallback Design](2026-07-12-m6-transparency-static-fallback-design.md)
- [M7 Loader, Integrity, and Resource Manager Design](2026-07-12-m7-loader-integrity-resource-manager-design.md)
- [Public element contract](../../element-api.md)

## 1. Outcome and Claim Boundary

M9 turns the completed web-only runtime, compiler, format library, graph
engine, and public element into a reproducible `1.0.0` release candidate. It
adds release-quality continuous integration, deterministic fixture and
provenance verification, hostile-input and lifecycle hardening, public API
reports, consumer/package checks, named headed-browser certification, and an
auditable publication and rollback process.

M9 proves four different things without collapsing them into one claim:

1. **Repository conformance** proves that pure logic, parsers, compilation,
   types, packaging, examples, and deterministic browser behaviors pass in
   controlled CI jobs.
2. **Runtime scheduling certification** proves on one exactly recorded browser,
   OS, hardware, display mode, power state, asset, and package build that the
   browser decoded and submitted the required content-frame sequence by the
   defined eligible deadlines.
3. **Observed-display continuity** proves only what an independent compositor
   trace or calibrated external high-speed capture actually observed at the
   display layer. It is a separate, optional certification layer.
4. **Authored visual continuity** reports source-boundary quality metrics and
   declarations. It does not prove scheduling or physical display timing.

The `1.0.0` package version stabilizes the documented JavaScript, TypeScript,
custom-element, CLI, project-file, and diagnostic contracts. It does not
change the compiled wire format: `.avl` remains version `0.1`, and the editable
compiler project remains version `0.2`. Package semver, project schema version,
and wire-format version are independent version spaces.

M9 does not claim hard real-time behavior, universal browser support, future
browser-version support, patent safety, publisher authenticity without an
external trust root, or physical scan-out continuity from `requestAnimationFrame`,
decoder callbacks, GPU fences, or canvas readback alone.

## 2. Decisions and Alternatives

### 2.1 Build one immutable final candidate, then publish those bytes

The final candidate uses package version `1.0.0` before certification. A clean,
locked checkout produces one tarball per public package, one browser harness
bundle, one fixture set, one documentation bundle, one SBOM set, and one
candidate manifest. SHA-256 and registry integrity values identify every
artifact. Named-profile reports refer to those exact digests.

After all gates pass, the registry workflow publishes the already certified
tarballs. It does not rebuild them. Earlier `1.0.0-rc.N` packages may be used
to gather feedback, but their evidence cannot certify `1.0.0` because changing
the version changes the artifact bytes.

Rebuilding at publication time was rejected because source identity alone
does not prove package-byte identity. Certifying an RC and assuming the final
version is equivalent was rejected for the same reason.

### 2.2 Keep CI conformance and manual performance certification separate

CI runs reproducible correctness and bounded stress on pinned toolchains. It
does not certify timing on shared virtual runners. Named-device certification
runs headed, visible, and locally controlled on real branded browsers. The
same versioned harness and JSON schema serve both paths, but only the manual
path can emit a named runtime scheduling certificate.

A single large browser job was rejected because host contention turns timing
noise into false product failures and hides which claim failed. Browser-name
detection was rejected; every production-codec and graphics decision remains
an exact capability probe.

### 2.3 Treat certification reports as validated data, not prose

Every report has a canonical JSON source validated against a versioned schema.
Human-readable Markdown is generated from that JSON and must contain the JSON
digest. Raw traces, logs, frame ledgers, and external-capture annotations are
content-addressed attachments. Reports are append-only: a failure,
inconclusive run, unsupported result, or withdrawn certificate remains visible.

Free-form reports were rejected because they permit omitted environment fields
and ambiguous use of terms such as "presented" or "seamless." One combined
runtime/display report was rejected because it encourages canvas-submission
timestamps to be mislabeled as scan-out evidence.

### 2.4 Synchronize public packages at 1.0

The release set is:

- `@pixel-point/aval-graph`;
- `@pixel-point/aval-format`;
- `@pixel-point/aval-compiler`;
- `@pixel-point/aval-player-web`; and
- `@pixel-point/aval-element`.

M9 resolves the M8 prototype naming gate: the package scope and default
`aval-player` tag become the stable 1.0 names unless one coordinated naming
change lands before the final candidate is built. Public
packages use synchronized versions and exact internal package dependencies for
the 1.0 line, so an untested mixture cannot be installed silently. The root
workspace and playground remain private.

Publishing only the element and compiler was considered. It would reduce the
surface initially, but it would leave already documented lower-level APIs in
an ambiguous support state and make independent tooling unnecessarily depend
on private paths. Publishing every internal module was also rejected: worker,
renderer, loader, lease, scheduler, and cache implementation modules remain
private behind package exports.

## 3. Evidence Vocabulary and Status

Every automated and manual result uses these closed statuses:

- `passed`: every required assertion for that exact claim layer passed;
- `failed`: at least one supported required assertion failed;
- `unsupported`: an exact prerequisite probe failed or the browser/platform
  does not expose the feature; no relevant animated claim is made;
- `inconclusive`: the measurement itself was invalid, incomplete, perturbed,
  or insufficient;
- `not-run`: the scenario was outside that report's declared profile; and
- `withdrawn`: a previously published result is retained but no longer relied
  upon, with a reason and replacement link.

`unsupported` is not `passed`, and `inconclusive` is not `unsupported`.
Unknown hardware-decode status is recorded as `unknown`, not as software or
hardware decode. A static-fallback scenario can pass even when its animated
production profile is unsupported; the report must show those as separate
results.

Normative timing terms remain those in the master design:

- an **eligible runtime deadline** is the first animation-frame callback at or
  after a rational content-frame presentation time for which the event and
  prepared frame existed before the measured canvas-submission cutoff;
- an **eligible observed-display deadline** is the first independently
  observed display refresh after that cutoff;
- a **format-induced underflow** is an eligible runtime deadline at which the
  required content frame was unavailable because of this format/runtime's
  bounded loader, decoder, scheduler, cache, or renderer path;
- a **host interruption** is an independently recorded OS/browser suspension,
  device loss, navigation, power transition, or harness fault and invalidates
  that timed run rather than being silently excluded; and
- a **boundary** is the half-open change from the last content frame of one
  occurrence to the first required content frame of the next occurrence or
  route unit.

Expected repetition of a 24/30 fps content frame on a 60/120 Hz display is not
an accidental duplicate. Runtime submission, observed refresh, and authored
source ordinals always use distinct field names.

## 4. Candidate/Release Manifests and Artifact Identity

M9 uses two immutable canonical manifests to avoid a self-referential digest:

- the **candidate manifest** identifies every executable or content artifact
  before named certification; every runtime/display report refers to this
  digest; and
- the **release manifest** embeds that candidate digest and adds the validated
  reports, review decisions, release notes, and rollback target.

The candidate and release manifests together record:

- candidate/release-manifest schema versions and package release version;
- git commit and tree IDs, with a clean-tree assertion;
- exact Node, npm, TypeScript, Vitest, Playwright, and packaging-tool versions;
- every package name, dependency edge, tarball filename, byte length, SHA-256,
  SHA-512 registry integrity, unpacked size, entry points, and file list digest;
- API-report and declaration-rollup digests;
- browser-harness bundle and schema digests;
- fixture asset, source, generator, provenance, compiler, and toolchain digests;
- documentation/example bundle digests;
- SPDX SBOM and license-report digests;
- required CI run IDs and result-artifact digests;
- required named-profile report IDs and attachment digests in the release
  manifest only;
- known limitations, security exception IDs, and legal-review record IDs; and
- the previous known-good release and rollback dist-tag target.

Neither manifest contains credentials, registry token, URL query, local absolute
path, ETag, device serial number, user name, or unredacted browser profile. Both
use canonical JSON with stable key ordering and newline behavior. The candidate
digest appears in every certification report; both digests appear in the final
release notes.

## 5. Continuous-Integration Architecture

CI uses least-privilege, SHA-pinned actions and a lockfile-only install. Jobs
have explicit timeouts, cancellation for superseded branches, read-only source
permissions by default, and no persisted checkout credentials. Untrusted pull
requests never receive release, attestation, or registry authority.

### 5.1 Required pull-request lanes

| Lane | Environment | Required work |
| --- | --- | --- |
| source | pinned minimum Node on Linux | lockfile install, generated-file check, formatting/diff hygiene, typecheck, public API extraction |
| unit | pinned minimum Node on Linux | all Vitest suites, seeded property tests, parser/PNG/HTTP mutation smoke corpus |
| cross-platform | pinned Node on macOS and Windows | typecheck, unit smoke, compiler CLI/path/process behavior, package consumer smoke |
| browser-reference | Playwright Chromium, Firefox, and WebKit engines | reference-profile graph, rendering, element, accessibility, loader, lifecycle, and cleanup conformance |
| browser-production | capability-probed Playwright engines | exact AVC configurations where supported; explicit unsupported artifacts otherwise |
| package | Linux | clean build, API reports, five tarballs, contents/exports/types/bin checks, install-and-run consumer fixtures |
| security | Linux | audit, license policy, secret/path scan, fixture limits, SBOM validation, action/dependency pin checks |

The comprehensive lane runs on the repository's exact minimum Node version.
An additional pinned newer supported Node version may run advisory first and
become required only after the support policy and lockfile record it. CI never
uses a floating `node`, `latest`, browser, FFmpeg, or action version for a
release claim.

### 5.2 Main-branch, scheduled, and release lanes

Main adds the complete deterministic mutation corpus and three consecutive
browser-reference repetitions. A scheduled job rotates recorded fuzz seeds,
runs long resource/lifecycle stress, and exercises tool-backed compilation
against explicitly recorded FFmpeg/FFprobe installations. It files evidence;
it never rewrites a golden fixture.

The release workflow consumes an immutable source commit, runs every required
lane again, packages once, uploads the artifact set, and waits for named-device
reports against that set. Publication is a separate protected environment with
human approval and registry trusted publishing. It downloads and verifies the
same tarballs instead of checking out and rebuilding source.

## 6. Deterministic Fixtures and Provenance

All golden conformance assets have checked source projects, source generators,
source-frame digests, asset digests, canonical manifest/index digests,
per-unit/static digests, expected graph/profile summaries, and path-free
provenance. A single verifier checks:

- every provenance schema and cross-reference;
- every on-disk digest and byte length;
- strict complete-asset, AVC, packed-geometry, alpha, and PNG validation;
- compiler/project/wire-version compatibility;
- all declared state, edge, port, route, static, and rendition expectations;
- absence of absolute paths, nondeterministic timestamps, credentials, URLs,
  host-specific metadata, and undeclared files; and
- deterministic serializer ordering.

Golden verification does not require FFmpeg. A tool-backed regeneration lane
uses an exact recorded native-tool fingerprint and fixed compiler controls to
prove byte identity only when that complete fingerprint matches the golden's
provenance. Other supported FFmpeg builds perform semantic regeneration:
strict inspection, decoded frame identity, geometry, quality thresholds, graph
coverage, and deterministic repeatability within that build. They never
silently replace the reviewed bytes.

Every release fixture is compiled twice in fresh bounded temporary directories
and must be byte-identical for the same recorded tool fingerprint. Temporary
paths and process environment cannot enter output or provenance.

## 7. Parser, Graph, Compiler, and Runtime Hardening

The release gate retains every earlier milestone suite and adds a stable corpus
plus seeded generation around all public trust boundaries.

### 7.1 Mutation and property testing

Mutation owners cover:

- header, canonical manifest, JSON token, UTF-8, index, layout, alignment,
  digest, arithmetic, overlap, count, and feature-flag boundaries;
- AVC start codes, NAL types/sizes, SPS geometry/crop, references, B-frames,
  access-unit flags, sample tables, decoded outputs, and worker messages;
- strict PNG signature/chunks/order/CRC/zlib/Huffman/back-reference/filter,
  inflated length, dimensions, and allocation bounds;
- graph identifiers, maps, ports, cycles, inverse pairs, portal/finish/cut
  bounds, latest-wins ordering, promises, and operation limits;
- compiler JSON schemas, file/path inputs, subprocess arguments, cancellation,
  native-tool output, quality arithmetic, and publication atomicity;
- HTTP status/header/range/entity/body/chunk/redirect/digest/watchdog cases;
- page/player lease arithmetic, eviction order, decoder queueing, visibility,
  source replacement, context generations, and cleanup; and
- element attributes/properties/events, engagement sources, media-query changes,
  connect/disconnect/adoption, fallback DOM, and hostile re-entrant listeners.

All generators have bounded sizes and operations. Every failure asserts the
stable error family, no parser/media use before its integrity gate, no stale
publication, and exact terminal ownership counters. Seeds, generator version,
case count, rejection count, maximum allocation, and minimized failures are
artifacts.

### 7.2 Boundary stress

Pure and fake-clock suites run at least 1,000 occurrences around every integer,
timeline, queue, portal-wait, operation-count, frame-count, dimension, body,
and byte cap. They include values immediately below, at, and above each bound,
plus `Number.MAX_SAFE_INTEGER` arithmetic. These tests are correctness stress,
not a substitute for the named real-time 1,000-boundary suite.

## 8. Browser Functional Conformance

Playwright runs the browser-independent reference profile in Chromium,
Firefox, and WebKit. It validates public imports and the custom element through
served package builds, not source-private modules. The suite covers:

- zero-configuration loop, user-defined states, direct triggers, engagement,
  pause/resume, reduced motion, fallback, sizing, and diagnostics;
- exact graph/media/event/promise order for every route class;
- packed-alpha rendering and strict static decode on representative
  backgrounds and presentation geometries;
- bounded range/full loading, entity and integrity behavior, visibility,
  eviction, source replacement, context recovery, and disposal;
- no stale draw/event/promise after replacement or disconnect; and
- zero live internal counters after each isolated scenario.

The production AVC profile runs only after the exact `VideoDecoder` and WebGL2
probes succeed. An unsupported result still runs and must pass the static
fallback contract. Playwright WebKit is functional engine evidence, not Safari
certification; bundled Chromium is not branded Chrome or Edge certification;
and Firefox automation is not a claim about an untested Firefox build.

GPU readback and machine-readable pixel tags are permitted in functional
correctness tests. They are disabled in timing benchmarks because synchronous
readback changes the pipeline being measured.

## 9. Named Runtime Scheduling Certification

Named certification uses a headed branded browser in a visible foreground
document with the final packaged build and final fixture bytes. The harness
warms the selected rendition, confirms `interactiveReady`, records capability
and resource snapshots, then runs the following independent scenarios.

### 9.1 Exact boundary suites

- **Loop:** 1,000 consecutive loop boundaries with exact frame identifiers,
  one decoder configuration, zero seek/reset/boundary flush/reconfigure, and
  zero format-induced underflow.
- **Transition:** 1,000 consecutive authored route boundaries across portal,
  finish, cut, locked, reversible, looping, finite, and held origins. Every
  route stays inside its declared maximum wait and begins at its required port.
- **Active reversal:** 1,000 seeded requests distributed over every active
  reversible phase and both directions. A valid inverse request reverses onto
  the adjacent resident layer on the next eligible content frame and both
  continuation runways recover within their bounds.
- **Portal bound:** at least 1,000 portal selections across all eligible body
  frame positions, including wrap and finite/held origins. No route exceeds
  its authored maximum wait.
- **Rapid input:** at least 10,000 seeded event operations with a 1,000-operation
  headed subset; the committed state converges to the newest accepted target,
  and every superseded/joined promise and event has deterministic order.

The compact certification fixture may make each occurrence short, but it may
not omit a route class or replace the real compiler/worker/renderer/element
path. Each named profile runs the timing suite three consecutive times after a
fresh browser start. A failed or host-interrupted repetition is retained and
cannot be replaced invisibly.

### 9.2 Runtime pass criteria

After `interactiveReady`, each supported scenario requires:

- zero `underflow` events and zero format-induced missing deadlines;
- exact consecutive content-frame identity through every boundary;
- zero wrong content identities and no renderer command that targets
  uninitialized or cleared storage;
- no boundary `canvasSubmissionGap` greater than the larger of 1.5 ideal
  content-frame intervals or the non-boundary p99 submission interval plus half
  one content-frame interval;
- no boundary seek, reset, flush, decoder reconfiguration, or `HTMLVideoElement`;
- no graph/media/event/promise divergence;
- active reversal and portal timing within the requirements above;
- upload-inclusive decoder output throughput of at least 1.5 times authored
  real time over at least 300 post-warm-up frames;
- no resource-cap violation, untracked owned bytes, stale publication, or
  nonzero terminal ownership counter; and
- a complete raw frame/deadline/route/diagnostic ledger.

The runtime report labels all interval and seam-gap distributions
`canvasSubmission*`. Passing that criterion says only that the browser-side
submission ledger was continuous; it cannot call those samples displayed-frame
or scan-out measurements.

## 10. Resource, Lifecycle, and Fault Certification

Hard correctness uses explicit ownership and manager counters, not browser heap
estimates. Each supported named profile runs:

- 100 create/prepare/play/dispose cycles with every tracked counter returning
  to the pre-cycle baseline;
- a 30-minute multi-player soak under the default two-decoder/192 MiB page and
  64 MiB player caps, with deterministic eviction and no cap overrun;
- repeated visible/hidden/reduced/full transitions from every preparation and
  playback phase, with frozen logical time and body-zero rebuild before resume;
- at least 100 source replacements and disconnect/reconnect/adoption cycles;
- repeated WebGL context loss/restoration where the extension or a real loss
  path is supported, including one restoration failure and sticky static mode;
- worker crash, decoder error/reclamation, bitmap/decode timeout, and renderer
  allocation failure behind the current static cover; and
- local controlled network faults: ignored/malformed/truncated/compressed/
  stalled ranges, missing or changing validators, redirects, corrupt internal
  blobs, external-integrity mismatch, abort at every read phase, and competing
  players.

Exact live resources, leases, readers, timers, listeners, callbacks, workers,
decoders, frames, bitmaps, textures, buffers, programs, shaders, surfaces, and
participants must settle to zero or the recorded shared baseline. Browser
process RSS, JS heap, GPU-process memory, and energy counters are recorded when
available as observational telemetry. They are never used to claim leak-free
ownership or cross-browser comparability unless the measurement API and error
model are documented for that profile.

## 11. Performance Benchmarks

Benchmarks are versioned but remain distinct from conformance. They include:

- metadata, first-static, visual, and interactive readiness latency;
- decoder output and upload-inclusive throughput after warm-up;
- canvas submission interval, callback-to-submit latency, and eligible-deadline
  slack;
- state-request-to-first-required-frame latency by route class;
- reduce/full, hide/show, and context-recovery rebuild latency;
- range request count, transferred bytes, first-static bytes, and verified
  residency;
- tracked peak bytes by category, decoder queue time, and static eviction count;
- compiler wall time, peak tracked working set, output bytes, and quality
  metrics for fixed fixtures; and
- minified package entry size and served starter-example transfer size.

The harness disables devtools, screenshots, synchronous readback, and verbose
console output during timed runs. It records warm-up, sample count, clock,
background load, power, thermal, refresh, and outlier policy before execution.
Raw samples are retained. Shared CI reports trends only; named-device hard
requirements are limited to the normative 1.5x throughput and deadline/boundary
criteria. Other regressions require explicit review against a same-profile
baseline rather than a universal threshold.

## 12. Named Device and Browser Matrix

The initial desktop matrix follows the master design and adds branded Edge:

- macOS 26 on Apple Silicon M1 or later: shipping Safari 26, current stable
  Chrome, current stable Firefox, and Edge when that exact configuration is
  supported;
- Windows 11 with Intel UHD 620-class graphics or better: current stable
  Chrome, Edge, and Firefox; Safari is recorded as unavailable; and
- 60 Hz and 120 Hz modes where the named display/platform exposes each mode.

"Current stable" is resolved only at run time and replaced in the report by an
exact full version/build/channel. Every exact production AVC configuration is
probed. A browser that lacks it receives an `unsupported` animated result plus
the required static-fallback conformance result. It is never silently tested
with VP8, a different H.264 profile, Playwright's engine, or another browser.

The 1.0 release requires at least one supported animated runtime scheduling
certificate on the named macOS class and one on the named Windows class. Every
listed available branded browser must have a published `passed`, `failed`, or
`unsupported` report; failures in a claimed supported configuration block the
release. A 120 Hz result is required on each platform where the certification
hardware exposes 120 Hz. Unlisted desktop and mobile environments remain
best-effort/static and are not certified by similarity.

## 13. Runtime Certification Report Schema

Each runtime JSON report contains these required groups:

### 13.1 Identity

- schema version, report ID, status, start/end UTC, operator role, and review
  signatures;
- candidate-manifest digest, commit/tree, package/tarball/harness/fixture digests,
  and provenance IDs;
- scenario IDs, seeds, repetition ordinals, raw attachment digests, and the
  exact command/config digest; and
- supersedes/withdraws links without deleting prior reports.

### 13.2 Environment

- browser product, full version/build, channel, executable digest when policy
  permits it, engine version if exposed, command-line flags, and profile-clean
  assertion;
- OS product, version, build, architecture, patch state, and virtualization
  status;
- device vendor/model class, CPU, GPU(s), driver/Metal version, physical RAM,
  and hardware/software decoder status when observable;
- display vendor/model class without serial number, connection, native and
  tested resolution, requested and independently measured refresh, scale/DPR,
  color/HDR mode, and multi-display state;
- AC/battery source, charge range, OS power mode, browser energy mode, thermal
  state when observable, and background-load declaration; and
- WebCodecs, exact codec config, worker, WebGL2, texture/layer limit, context
  loss, external-integrity, and range capability results.

### 13.3 Results

- readiness milestones, selected rendition, dimensions, frame rate, and
  resource plan;
- exact boundary/request/route/frame/deadline counts and first failing ordinal;
- configure/reset/flush/reconfigure/seek, underflow, hold, stale, and error
  counters;
- reversal/portal/rapid-input distributions and deterministic trace digests;
- throughput and canvas submission statistics with raw sample links;
- network/resource/lifecycle peaks and final counters; and
- per-criterion `passed`, `failed`, `unsupported`, `inconclusive`, or `not-run`
  with an evidence pointer.

The schema rejects omitted required fields, unknown enum values, non-finite
numbers, unsafe integers, unbounded strings/arrays, local absolute paths, and a
runtime report containing observed-display pass fields.

## 14. Observed-Display Continuity

Observed-display evidence uses a separate schema and report. It references a
passed runtime report but does not change that report's result.

An observed-display run uses either:

1. an OS/browser compositor trace that demonstrably identifies the relevant
   surface at actual display refresh/scan-out, with the trace provider and
   interpretation documented; or
2. synchronized external capture at no less than four times the tested display
   refresh rate, with calibration, shutter/exposure, focus, region, capture
   clock, dropped-capture detection, frame-tag decoder, and raw recording
   digest documented.

A compositor submission trace that stops before scan-out is runtime/compositor
evidence, not observed display. `requestAnimationFrame`, `performance.now`,
`VideoFrame.timestamp`, decoder output, GPU fences, canvas readback, screen
recording at the display refresh, and an unsynchronized phone video are
insufficient by themselves.

The observed report records distinct displayed content-frame appearances and
refresh ordinals. It grades zero black, transparent-uninitialized, missing, or
accidental duplicate boundary appearances and no seam gap greater than the
larger of 1.5 ideal content-frame intervals or the non-seam p99 interval plus
half one content-frame interval. Expected refresh repetition is normalized
before duplicate detection. Capture uncertainty and ambiguous frames make the
result `inconclusive`, not passed.

Observed-display reports are optional for the 1.0 software release. Release
notes and support tables render the canonical `not-run` state as `not measured`
until one passes; they never turn runtime scheduling certification into a
physical-display statement.

## 15. Stable Public API and Semver

Every public package has one explicit export map, ESM JavaScript, declaration
rollup, API Extractor report, side-effect declaration, engine/browser support
statement, and tested consumer fixture. Deep imports outside the export map are
unsupported and package contents do not accidentally make them resolvable.

The 1.0 API report classifies each item as:

- stable public;
- public but explicitly experimental and excluded from compatibility promises;
- deprecated with replacement and removal floor; or
- internal and absent from the package declaration rollup.

The custom element's tag name, observed attributes, reflected-property rules,
methods, promises, events, event detail, error codes, readiness/state enums,
CSS sizing behavior, and light-DOM fallback behavior are versioned public API.
Diagnostics are versioned data: new optional fields are minor-compatible, but
renaming/removing a field or changing its meaning is breaking.

After 1.0:

- patch releases may fix behavior inside the existing contract and add no
  required fields;
- minor releases may add exports, optional fields, states, diagnostics, or
  opt-in behavior without changing defaults;
- major releases are required for removal, required-field addition, wire
  reinterpretation, default semantic change, or incompatible element/CLI
  behavior; and
- wire/project support changes state their own compatibility separately from
  package semver.

Every API-report change needs a checked release classification. Stable removal
requires a major release; deprecation alone does not permit patch/minor
removal. The 1.0 migration document maps all 0.x names and behaviors or states
that no compatibility existed for an internal-only surface.

## 16. Package and Publish Contents

Each tarball contains only its package manifest, license/notices, package
README, built ESM, declaration files, and required runtime assets. The compiler
also contains its executable entry. The runtime package set contains the M8
module-worker URL/asset through documented exports. The element root remains
SSR-safe and side-effect-free; its documented `/auto` entry is the sole
intentional registration side effect.

Tarballs exclude source fixtures, tests, benchmark traces, local caches,
temporary media, TypeScript build info, coverage, source maps with local paths,
credentials, signing material, CI configuration, and bundled FFmpeg/FFprobe or
encoder libraries. Every declared `exports`, `types`, `bin`, `files`, engine,
dependency, license, and side-effect field is tested from the packed tarball in
fresh ESM and browser consumers.

The publication workflow first uploads `1.0.0` under the `next` dist-tag in
dependency order, installs every exact version into clean consumer projects,
and verifies registry integrity. Only then does a protected step move the five
packages to `latest`. A partial publish never promotes `latest`; the release
record lists which immutable versions exist and applies rollback tags.

## 17. Documentation and Executable Examples

The 1.0 documentation includes:

- a five-minute zero-configuration loop quick start;
- an idle/hover/focus starter with user-defined states and explicit triggers;
- imperative state requests, partial-loop semantics, reversal, portals,
  finite/held bodies, and latest-wins promise/event behavior;
- static fallback, reduced motion, pause/resume, visibility, sizing, light DOM,
  semantics, keyboard/focus, and business-action guidance;
- compiler install/init/compile/dev/inspect/unpack workflows, supported inputs,
  actionable diagnostics, quality reports, and the non-bundled FFmpeg model;
- CORS, exact range/ETag/Content-Encoding behavior, external integrity, CSP,
  CDN/cache configuration, and bounded full-fetch fallback;
- browser support and exact certification tables with unsupported and
  not-measured cells shown;
- performance, memory-budget, multi-player, context-loss, and troubleshooting
  guidance using public diagnostics;
- format/project/API versioning, migration from 0.x, changelog, security model,
  disclosure policy, license notices, and legal limitations; and
- the certification method, schemas, raw-evidence index, claim vocabulary, and
  instructions for reproducing a named run.

Every code sample typechecks. Starter projects build from packed tarballs and
run as browser smoke tests. Documentation links, headings, package names,
commands, event names, error codes, and JSON examples are machine-checked
against the release manifest and API reports.

## 18. Security and Supply Chain

M9 publishes a threat model covering untrusted assets/projects, compiler file
and subprocess boundaries, network/entity/integrity behavior, browser decoder
and GPU inputs, custom-element DOM/event boundaries, denial-of-service caps,
and non-goals such as publisher authenticity without external integrity.

Release security requires:

- a lockfile-only install with lifecycle scripts disabled except reviewed
  explicit tool steps;
- SHA-pinned CI actions and least-privilege workflow permissions;
- no long-lived registry token; protected OIDC/trusted publishing with
  provenance attestation;
- an SPDX 2.3 JSON SBOM for the workspace and each public tarball, generated by
  one pinned tool and validated against the packed dependency graph;
- a machine-readable third-party license/notices report and policy;
- dependency audit with no unwaived high/critical production finding;
- secret, private-key, credential, absolute-path, URL-query, and unexpected
  binary scans over source, fixtures, docs, tarballs, traces, and reports;
- package integrity, registry provenance, and release-manifest attestations;
- an email or hosted private disclosure route, response policy, and supported
  release table; and
- retained independent-design and legal-review records without making a
  patent-safety or codec-license claim.

Any exception is structured, scoped to an exact dependency/path, explains
reachability and mitigation, has an owner and expiry before the next release,
and appears in the release manifest. A critical production-path issue cannot
be waived for 1.0.

## 19. Final 1.0 Release Criteria

The final candidate may publish only when:

- M1 through M8 evidence is complete and no earlier contract is weakened;
- every required CI lane passes from the exact clean commit;
- all goldens/provenance/API reports/docs are deterministic and current;
- the full unit, mutation, browser-reference, production-capability, resource,
  lifecycle, context, visibility, network-fault, package, and consumer suites
  pass;
- five final `1.0.0` tarballs and their SBOMs pass contents/integrity scans;
- each listed branded browser has an exact published supported, failed, or
  unsupported report on the required OS class;
- supported named macOS and Windows profiles each pass three consecutive loop,
  transition, reversal, portal, rapid-input, throughput, and cleanup runs;
- required 60 Hz and available 120 Hz profiles meet runtime scheduling criteria;
- no claimed supported profile has an unexplained failure or inconclusive run;
- observed-display cells remain explicitly separate and may be not measured;
- no unwaived critical production or high production dependency finding exists;
- package names, licenses, notices, encoder-distribution decision, security
  contact, and counsel-required commercial-release checks are recorded;
- release notes enumerate limitations, unsupported profiles, failed reports,
  and the exact previous rollback target; and
- two reviewers independently verify the release manifest, report schemas,
  artifact digests, API change classification, and publication dry run.

The release is blocked by a functional failure, unsupported claim, missing
required data, artifact rebuild, digest mismatch, stale report, hidden failed
run, or ambiguous runtime/display terminology. The gate is not weakened to
meet a date.

## 20. Publication and Rollback

Publication uses a protected, resumable ledger. Each external mutation records
its package, version, tarball digest, registry response, dist-tag before/after,
operator approval, and verification result. A retry first reads registry state
and accepts only the exact already-published digest; it never overwrites a
version.

If verification fails before `latest`, publication stops and all new versions
remain under `next` or receive a `do-not-use` deprecation message. If a problem
is found after promotion:

1. stop further promotion and preserve all evidence;
2. move `latest` back to the recorded previous known-good versions in reverse
   dependency order;
3. deprecate the affected immutable versions with a concise reason and
   mitigation;
4. mark affected certification reports `withdrawn` without deleting them;
5. publish a security advisory when confidentiality or integrity is involved;
6. document host mitigations such as forcing static mode, pinning a previous
   package, or reverting asset/CDN bytes; and
7. fix forward with a new semver version and a complete new artifact and
   certification cycle.

Registry unpublish is not the rollback strategy. The runtime has no remote kill
switch and release infrastructure does not add telemetry or remote control.

## 21. Evidence Retention and Privacy

Committed evidence contains schemas, canonical reports, generated summaries,
small bounded machine-readable ledgers, digests, and public-safe environment
facts. Large raw traces and capture media may live in immutable release
artifacts; the repository records their digest, byte length, media type,
retention location, and access policy.

Reports omit user names, serial numbers, account IDs, home paths, IP addresses,
tokens, browsing data, unrelated processes, and video outside the calibrated
test region. Redaction happens before hashing the published attachment, and the
report states what was redacted. Evidence remains sufficient to identify the
tested class and exact software/display configuration without identifying an
individual operator.

## 22. Non-goals

M9 does not add:

- a wire-format revision, new codec, native runtime, framework wrapper, hosted
  optimizer, asset registry, service worker, or persistent browser cache;
- mobile certification or a claim about unlisted hardware/browser versions;
- a universal performance score or comparison between incomparable browser
  memory/energy APIs;
- automatic visual-naturalness, semantic-seam, or authored-quality approval;
- physical-display certification from callback, canvas, screenshot, or
  same-refresh-rate screen-recording evidence;
- bundled FFmpeg/libx264, patent clearance, codec license, or legal advice;
- remote telemetry, crash upload, feature flag, or kill switch; or
- deletion or rewriting of failed, unsupported, inconclusive, or withdrawn
  release evidence.
