# AVAL React Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task.

**Goal:** Publish an SSR-safe `@pixel-point/aval-react` package whose `useAval()` hook returns a reactive `aval` controller and a stable bound `AvalComponent`.

**Architecture:** Keep `@pixel-point/aval-element` as the sole browser/runtime owner. Add a cached framework-neutral snapshot store to the element, consume it with React's `useSyncExternalStore`, and render codec-keyed direct `<source>` children from a URL-only `sources` object. Register the custom element only after native listeners are attached during client ref commit.

**Tech Stack:** TypeScript, React 18.3/19, Web Components, `useSyncExternalStore`, Vitest, Playwright, API Extractor, npm workspaces

---

## Task 1: Add the element external-store contract

**Files:**

- Modify: `packages/element/src/public-types.ts`
- Create: `packages/element/src/element-snapshot-store.ts`
- Modify: `packages/element/src/aval-element.ts`
- Modify: `packages/element/src/index.ts`
- Create: `packages/element/src/element-snapshot-store.test.ts`
- Modify: `packages/element/src/aval-element.test.ts`

- [ ] Write failing tests for frozen snapshot identity, idempotent unsubscribe, subscriber error isolation, and semantic equality.
- [ ] Add public `AvalSnapshot` and the `getSnapshot()`/`subscribe()` methods to `AvalElement`.
- [ ] Implement a small cached snapshot store that increments `revision` only when a public semantic field changes.
- [ ] Publish after connection/disconnection, source generation changes, readiness/mode/metadata changes, state and transition staging, pause/autoplay changes, visibility changes, failures, and disposal.
- [ ] Reset `lastError` when a new source generation begins and stage snapshots before corresponding DOM events.
- [ ] Verify no per-frame publication and that subscriber exceptions cannot interrupt playback.

Run:

```bash
npx vitest run --config vitest.m9.config.ts packages/element/src/element-snapshot-store.test.ts packages/element/src/aval-element.test.ts
```

Expected: all focused element tests pass.

## Task 2: Scaffold the React package and source model

**Files:**

- Create: `packages/react/package.json`
- Create: `packages/react/tsconfig.json`
- Create: `packages/react/tsconfig.release.json`
- Create: `packages/react/api-extractor.json`
- Create: `packages/react/LICENSE`
- Create: `packages/react/NOTICE`
- Create: `packages/react/README.md`
- Create: `packages/react/src/types.ts`
- Create: `packages/react/src/sources.ts`
- Create: `packages/react/src/sources.test.ts`

- [ ] Declare exact `@pixel-point/aval-element` runtime dependency and React `^18.3.0 || ^19.0.0` peer dependency.
- [ ] Keep the package ESM-only, root-only, side-effect free, and free of React DOM at runtime.
- [ ] Define `AvalSources` as a codec-keyed, URL-string-only object requiring at least one codec.
- [ ] Normalize and compare inputs in fixed `av1`, `vp9`, `h265`, `h264` order.
- [ ] Reject empty strings, unknown runtime keys, non-string values, and an empty source object with actionable errors.
- [ ] Test deterministic ordering and semantic equality for inline source objects.

Run:

```bash
npx vitest run --config vitest.m9.config.ts packages/react/src/sources.test.ts
```

Expected: source normalization tests pass.

## Task 3: Implement the React binding and `useAval()`

**Files:**

- Create: `packages/react/src/aval-binding.ts`
- Create: `packages/react/src/use-aval.tsx`
- Create: `packages/react/src/index.ts`
- Create: `packages/react/src/aval-binding.test.ts`
- Create: `packages/react/src/ssr.test.tsx`
- Create: `packages/react/src/public-api.compile.tsx`

- [ ] Build one stable binding controller per hook call with cached normalized options and stable command functions.
- [ ] Have `useAval()` consume the binding through `useSyncExternalStore` and return an immutable `aval` render snapshot.
- [ ] Create one stable bound `AvalComponent` per hook call and enforce a single mounted instance in development.
- [ ] Render `<aval-player>` with codec-keyed direct `<source>` children and normal HTML/ARIA/style props.
- [ ] Map `autoplay` booleans to `visible`/`manual` and `autoBind` booleans to `auto`/`none`.
- [ ] Install direct listeners before `defineAvalElement()`, then subscribe and publish the mounted snapshot.
- [ ] Forward current callbacks without ref churn and suppress stale `onReady` completion after source changes or detach.
- [ ] Resolve `bindTo` from either an `Element` or `RefObject`, update the object-only target after commit, and clear it safely on detach.
- [ ] Never import `/auto`, read DOM globals during module evaluation, or call terminal `dispose()` from React cleanup.
- [ ] Test stable controller methods, pre-mount command behavior, callback routing, SSR import, and exact server markup.
- [ ] Add compile-time examples for normal props, at-least-one sources, returned component usage, and rejected invalid inputs.

Run:

```bash
npx vitest run --config vitest.m9.config.ts packages/react/src/aval-binding.test.ts packages/react/src/ssr.test.tsx
npx tsc -p packages/react/tsconfig.json --noEmit
```

Expected: unit, SSR, and type-contract checks pass.

## Task 4: Integrate the sixth public package

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Modify: `vitest.m9.config.ts`
- Modify: `scripts/release/release-set-model.mjs`
- Modify: `scripts/release/publish-manifest.mjs`
- Modify: `scripts/release/fresh-public-build.mjs`
- Modify: `config/release/release-policy.json`
- Modify: `config/release/api-changes.json`
- Modify: release/certification fixtures and tests that enumerate the public package set

- [ ] Add the React project to workspace build order and TypeScript references.
- [ ] Add React and React DOM only as development dependencies needed for building and SSR testing; keep React a package peer.
- [ ] Extend Vitest discovery and fresh release builds from `.ts` to `.ts` plus `.tsx` without including tests in release output.
- [ ] Add `@pixel-point/aval-react` to the exact-dependency release DAG after `@pixel-point/aval-element`.
- [ ] Preserve and validate only the approved React peer dependency in publish manifests while continuing to strip development metadata.
- [ ] Update package-count assertions, API classification, API reports, public-entry authority, candidate/SBOM paths, ledgers, inspections, and consumer runners.
- [ ] Keep compiler output and runtime source formats unchanged.

Run:

```bash
npm install --package-lock-only
npm run build
npm run test
```

Expected: workspace installation is consistent and package enumeration tests recognize six public packages.

## Task 5: Migrate and expand the React example

**Files:**

- Modify: `examples/react-ref/package.json`
- Modify: `examples/react-ref/src/StatusMotion.tsx`
- Delete: `examples/react-ref/src/aval-player-jsx.d.ts`
- Modify: `examples/react-ref/test/listener-timing.spec.ts`
- Create or modify: `examples/react-ref/test/react-lifecycle.spec.ts`
- Modify: `examples/react-ref/README.md`
- Modify: `docs/element/react.md`
- Modify: root `README.md` and quick-start documentation where React integration is described

- [ ] Replace the local callback-ref wrapper with the public `useAval()` API.
- [ ] Remove consumer JSX augmentation and direct custom-element registration.
- [ ] Keep the existing early-fatal listener timing and remount regression.
- [ ] Add browser coverage for Strict Mode replay, no duplicate callbacks, no automatic disposal, state snapshot updates, and in-place source replacement.
- [ ] Document basic rendering, application state intent, authored events, manual playback, `bindTo`, fallback ownership, and requested-versus-visual timing.
- [ ] Ensure all documentation uses `sources` directly and contains no React JSON manifest, bundle version, or integrity API.

Run:

```bash
npm --prefix examples/react-ref install
npm --prefix examples/react-ref run build
npm --prefix examples/react-ref test
```

Expected: the example builds against the package and lifecycle browser tests pass.

## Task 6: Release and consumer verification

**Files:**

- Modify or create packed-consumer fixtures under the repository's existing release test directories
- Regenerate: API Extractor reports and release metadata expected by repository checks

- [ ] Pack `@pixel-point/aval-element` and `@pixel-point/aval-react` from fresh build output.
- [ ] Verify an isolated React consumer can install the tarballs with React satisfying the peer.
- [ ] Verify server import and `renderToString()` without DOM globals.
- [ ] Verify the packed package contains declarations, JavaScript, license/notices, and no tests/source maps outside release policy.
- [ ] Run public API, release policy, SBOM, and package inspection gates.

Run the repository's release verification commands discovered from `package.json` and `scripts/release`, then:

```bash
npm run build
npm run test
git diff --check
git status --short
```

Expected: all relevant gates pass and only intentional implementation/documentation changes remain.

## Task 7: Final contract audit

- [ ] Search for obsolete proposed names: `interactionTarget`, `bindings` as hook options, `bundleUrl`, React JSON manifests, React integrity descriptors, and standalone public `AvalPlayer` wrappers.
- [ ] Confirm `useAval()` returns exactly `{ aval, AvalComponent }`.
- [ ] Confirm `sources` accepts URLs only and requires at least one codec.
- [ ] Confirm source updates do not key or remount `<aval-player>`.
- [ ] Confirm Strict Mode cleanup never calls `dispose()`.
- [ ] Confirm snapshot identity remains stable between semantic updates.
- [ ] Confirm no compiler or `.avl` format change was introduced.
- [ ] Review the diff for accidental generated files, unrelated edits, secrets, and dependency drift.

