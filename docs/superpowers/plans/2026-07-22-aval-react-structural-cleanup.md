# AVAL React Structural Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the approved AVAL React API while making element snapshots atomic, React lifecycle state explicit, tests properly isolated, and release-package policy canonical.

**Architecture:** Replace sampled snapshot invalidation with a canonical public-state controller and semantic transitions. Represent React attachment and readiness work with explicit records, keep element configuration policy in the element package, move browser fakes into package test support, and derive release behavior from complete package contracts.

**Tech Stack:** TypeScript 7, React 18.3/19, Web Components, Vitest, Playwright, Node.js ESM release scripts

---

## File structure

- `packages/element/src/element-snapshot-store.ts`: canonical observable public state and atomic transitions.
- `packages/element/src/aval-element.ts`: runtime orchestration that invokes semantic public-state transitions.
- `packages/element/test/support/element-test-realm.ts`: reusable fake DOM realm for element integration tests.
- `packages/element/test/aval-element-snapshot.test.ts`: snapshot behavior and atomicity proofs.
- `packages/react/src/aval-binding.ts`: attachment, preparation, commands, and callback routing.
- `packages/react/src/sources.ts`: React-owned source normalization only.
- `packages/react/src/use-aval.tsx`: hook/component rendering and narrowly typed ARIA normalization.
- `packages/react/test/browser/*`: typed synthetic element and React lifecycle browser fixture.
- `scripts/release/release-set-model.mjs`: complete reviewed package contracts.
- `scripts/release/local-package-archives.mjs`: shared offline dependency-closure packing.

### Task 1: Make element snapshots canonical and atomic

**Files:**

- Modify: `packages/element/src/element-snapshot-store.ts`
- Modify: `packages/element/src/aval-element.ts`
- Modify: `packages/element/src/public-types.ts`
- Move: `packages/element/src/element-snapshot-store.test.ts` to `packages/element/test/element-snapshot-store.test.ts`
- Move: `packages/element/src/aval-element.test.ts` to `packages/element/test/aval-element-snapshot.test.ts`
- Create: `packages/element/test/support/element-test-realm.ts`

- [ ] **Step 1: Add failing atomic lifecycle tests**

Capture every synchronous snapshot published during disconnect and disposal and
assert that no snapshot combines a disconnected element with visible state:

```ts
const observed: AvalSnapshot[] = [];
element.subscribe(() => observed.push(element.getSnapshot()));
element.isConnected = false;
element.disconnectedCallback();
await Promise.resolve();
expect(observed).not.toContainEqual(expect.objectContaining({
  connected: false,
  effectivelyVisible: true
}));
```

- [ ] **Step 2: Run the focused test and confirm the old publication order fails**

Run:

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/aval-element-snapshot.test.ts
```

Expected: the new disconnect atomicity assertion fails before implementation.

- [ ] **Step 3: Give the store an atomic transition API**

Use immutable patches against the store-owned state:

```ts
public transition(
  update: (current: Readonly<ElementSnapshotState>) => ElementSnapshotState
): boolean {
  const next = update(this.#state);
  if (sameState(this.#state, next)) return false;
  this.#state = freezeState(next);
  this.#snapshot = freezeSnapshot(this.#snapshot.revision + 1, this.#state);
  this.#notify();
  return true;
}
```

Expose focused semantic methods or patches for connection, generation reset,
metadata, readiness, playback intent, transition state, visibility, failure, and
disposal. The store, not `AvalElement.#snapshotState()`, owns the retained values.

- [ ] **Step 4: Replace sampled publications with atomic transitions**

Delete `#snapshotState()` and `#publishSnapshot()`. Update related runtime fields
first, then perform exactly one state transition. Restore readiness to a
single-purpose transition:

```ts
if (from === value) return;
this.#readiness = value;
this.#commitPublicState({ readiness: value });
this.#dispatch("readinesschange", { from, to: value, ...reasonDetail });
```

Disconnect/dispose must tear down visibility inputs before committing their final
connection/visibility patch.

- [ ] **Step 5: Remove duplicated error state**

Delete `#lastFailure`. Derive diagnostics from the canonical snapshot:

```ts
lastFailure: this.#snapshots.getSnapshot().lastError?.failure ?? null
```

- [ ] **Step 6: Extract and reuse the element fake realm**

Move reusable fake `Window`, `Document`, `HTMLElement`, observers, and stylesheet
classes into `packages/element/test/support/element-test-realm.ts`. Import the
fixture from both snapshot and lifecycle regression tests instead of maintaining
a second realm implementation.

- [ ] **Step 7: Run element verification**

```bash
npx vitest run --config vitest.m9.config.ts packages/element/test/element-snapshot-store.test.ts packages/element/test/aval-element-snapshot.test.ts packages/element/test/element-lifecycle-regressions.test.ts
npm run typecheck -w @pixel-point/aval-element
```

Expected: all tests and element typechecks pass.

### Task 2: Replace `AvalBinding` flags with lifecycle records

**Files:**

- Modify: `packages/react/src/aval-binding.ts`
- Modify: `packages/react/src/aval-binding.test.ts`

- [ ] **Step 1: Add failing record-lifecycle tests**

Cover attachment cleanup, stale preparation completion, target replacement, and
single-mount enforcement using a typed element port rather than browser globals.

- [ ] **Step 2: Introduce explicit records**

```ts
interface Attachment {
  readonly node: HTMLElement;
  readonly element: AvalElement;
  readonly unsubscribe: () => void;
  finalized: boolean;
  target: Element | null;
}

interface Preparation {
  readonly attachment: Attachment;
  readonly sourceKey: string;
  readonly controller: AbortController;
}
```

Keep only `#attachment: Attachment | null` and
`#preparation: Preparation | null`; remove node/element/target duplicates,
`#readySequence`, `#readyController`, and `#mountFinalized`.

- [ ] **Step 3: Centralize cleanup and operation identity**

Use one `#closeAttachment(attachment)` function. A readiness completion is valid
only when `this.#preparation === operation`, the attachment is still installed,
and its source key is current. Cancellation aborts and clears the exact operation.

- [ ] **Step 4: Select status from snapshot identity**

Cache the React projection by `AvalSnapshot` object identity and remove the
field-by-field `sameStatus()` comparison.

- [ ] **Step 5: Run React binding tests**

```bash
npx vitest run --config vitest.m9.config.ts packages/react/src/aval-binding.test.ts
npm run typecheck -w @pixel-point/aval-react
```

Expected: lifecycle and type tests pass.

### Task 3: Restore the element/React option boundary

**Files:**

- Modify: `packages/react/src/sources.ts`
- Modify: `packages/react/src/sources.test.ts`
- Modify: `packages/react/src/use-aval.tsx`
- Modify: `packages/react/src/ssr.test.tsx`

- [ ] **Step 1: Delete duplicate element enum policy**

Remove React-owned `MOTIONS`, `FITS`, and `CROSS_ORIGINS` sets and their runtime
branches. Retain validation for `sources`, `autoplay`, and `autoBind` only.

- [ ] **Step 2: Keep exact host-property types**

Type `state`, `motion`, `fit`, and `crossorigin` from
`NormalizedAvalRenderOptions` instead of widening them to `string`.

- [ ] **Step 3: Isolate the React custom-element ARIA workaround**

```ts
function stringifyBooleanAria(
  properties: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(properties).map(([name, value]) => [
    name,
    name.startsWith("aria-") && typeof value === "boolean" ? String(value) : value
  ]));
}
```

Keep the unavoidable cast inside this helper only; do not cast the complete host
model at its return boundary.

- [ ] **Step 4: Run source and SSR tests**

```bash
npx vitest run --config vitest.m9.config.ts packages/react/src/sources.test.ts packages/react/src/ssr.test.tsx
```

Expected: source validation and deterministic SSR pass.

### Task 4: Move browser infrastructure out of the example

**Files:**

- Create: `packages/react/test/browser/fake-aval-element.ts`
- Create: `packages/react/test/browser/fixture.tsx`
- Create: `packages/react/test/browser/index.html`
- Create: `packages/react/test/browser/listener-timing.spec.ts`
- Create: `packages/react/test/browser/vite.config.ts`
- Create: `packages/react/test/browser/playwright.config.ts`
- Create: `packages/react/test/browser/tsconfig.json`
- Modify: `packages/react/package.json`
- Modify: `package.json`
- Modify: `examples/react-ref/src/StatusMotion.tsx`
- Modify: `examples/react-ref/src/main.tsx`
- Modify: `examples/react-ref/tsconfig.json`
- Delete: `examples/react-ref/vite.listener-timing.config.ts`
- Delete: `examples/react-ref/playwright.listener-timing.config.ts`
- Delete: `examples/react-ref/src/listener-timing-element.ts`
- Delete: `examples/react-ref/src/listener-timing-test.tsx`
- Delete: `examples/react-ref/test/listener-timing.spec.ts`
- Delete: `examples/react-ref/listener-timing-test.html`
- Modify: `scripts/docs/check-docs.mjs`

- [ ] **Step 1: Type the fake against the real contract**

Return `Readonly<AvalSnapshot>` from `getSnapshot()`, use imported event detail
types, and type the fake as the required `Pick<AvalElement, ...>` surface. When it
emits an error, stage the same `lastError` in its snapshot first.

- [ ] **Step 2: Expose one typed browser harness**

```ts
declare global {
  interface Window {
    avalReactHarness: AvalReactBrowserHarness;
  }
}
```

Move source replacement, target replacement, preparation resolution, callback
counts, and remount operations behind that single object.

- [ ] **Step 3: Simplify the real example**

Keep only real `sources`, `state`, `bindTo`, `onError`, and `onVisualState` props.
Render fallback from `aval.lastError?.fatal === true`; remove test-only callback
props and mirrored `failed` state.

- [ ] **Step 4: Stop checking implementation spelling in docs**

Delete checks for literal `onError:` and `setFailed(true)`. For the removed JSX
augmentation file, only `ENOENT` proves absence; rethrow every other filesystem
error.

- [ ] **Step 5: Run example browser and documentation checks**

```bash
npm --prefix examples/react-ref run typecheck
npm --prefix examples/react-ref run build
npm run typecheck -w @pixel-point/aval-react
npm run test:browser -w @pixel-point/aval-react
npm run docs:check
```

Expected: the real example stays small, includes only its own source, and browser
lifecycle coverage is configured, typed, and executed by the React package.

### Task 5: Make release package policy data-driven

**Files:**

- Modify: `scripts/release/release-set-model.mjs`
- Modify: `scripts/release/public-entry-authority.mjs`
- Modify: `apps/playground/vite.production-entries.ts`
- Modify: `scripts/release/publish-manifest.mjs`
- Modify: `scripts/release/fresh-public-build.mjs`
- Modify: `packages/certification/src/compatibility.ts`
- Create: `scripts/release/local-package-archives.mjs`
- Modify: `scripts/docs/test-examples.mjs`
- Modify: `scripts/release/test-consumers.mjs`
- Modify: `scripts/release/test-packed-dev.mjs`
- Modify: `tests/package/release-set.test.ts`
- Modify: `tests/package/fresh-public-build.test.ts`
- Modify: `packages/certification/test/compatibility.test.ts`
- Modify: `packages/certification/test/release-manifest.test.ts`

- [ ] **Step 1: Extend every package specification**

Add frozen `peerDependencies`, `exports`, `sideEffects`, `bin`, `buildConfig`,
`buildInfo`, and production-entry fields. React's peer range appears once in the
producer contract; element/compiler exceptions become ordinary data. Model
TypeScript source selection as a discriminated `files` or `globs` record.

- [ ] **Step 2: Derive publishing and builds from specifications**

Replace package-name conditionals and the `BUILD_INFO`/`RELEASE_CONFIG` maps with
lookups on the selected specification. Certification uses an exact typed contract
record, including peers, without a `name === "@pixel-point/aval-react"` branch.
Derive production-entry identities, Vite resolution, and source-directory
rejection from the same release model; compiler explicitly declares no browser
entry.

- [ ] **Step 3: Extract offline closure packing**

```js
export async function packInstalledClosure({ root, destination, packages }) {
  const pending = [...packages];
  const packed = new Map();
  while (pending.length > 0) {
    const name = pending.shift();
    if (packed.has(name)) continue;
    const manifest = await readInstalledManifest(root, name);
    packed.set(name, packLocalDependency(manifest.directory, destination));
    pending.push(...Object.keys(manifest.dependencies ?? {}));
  }
  return Object.freeze([...packed.values()]);
}
```

Use this helper for React, `@types/react`, and their locked dependency closures in
all three callers. Remove the three local `packLocalDependency` copies and the
hard-coded `csstype` entry.

- [ ] **Step 4: Run release-policy tests**

```bash
npx vitest run --config vitest.m9.config.ts tests/package/release-set.test.ts tests/package/fresh-public-build.test.ts packages/certification/test/compatibility.test.ts
```

Expected: all package contracts and release builds validate generically.

### Task 6: Full verification and final audit

**Files:**

- Regenerate: `etc/api/element.api.md`
- Regenerate: `etc/api/react.api.md`
- Verify unchanged: `config/release/api-classification.json`

- [ ] **Step 1: Run formatting and focused suites**

```bash
git diff --check
npm run typecheck
npm run test:unit
```

- [ ] **Step 2: Run browser and package gates**

```bash
npm run test:browser
npm run build
npm run api:check
npm run docs:check
npm run check:generated
```

- [ ] **Step 3: Run packed proofs**

```bash
npm run test:packed
```

Expected: six exact public packages install and all React peer dependencies
resolve offline.

- [ ] **Step 4: Repeat the strict structural audit**

Confirm there are no sampled snapshot invalidations, React lifecycle flag bags,
duplicated element enum sets, fake runtime files in the example, package-name peer
branches, or duplicate local packing helpers. Confirm no modified file crosses
1,000 lines and `test-packed-dev.mjs` stays below that threshold.
