# Grass Rabbit React Demo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dedicated Next.js and Tailwind Grass Rabbit example that demonstrates the public `useAval()` React API and its reactive controller state.

**Architecture:** Add a static-exportable App Router workspace with a server-rendered page and one client-only rabbit component. Synchronize compiled assets from the canonical plain-JavaScript example during development and production builds, then verify the real Next.js bundle and authored hover behavior.

**Tech Stack:** Next.js 16.2.11, React 19.2.7, TypeScript 6.0.3, Tailwind CSS 4.3.2, `@pixel-point/aval-react`, Playwright 1.61.1

---

### Task 1: Scaffold the Next.js workspace

**Files:**
- Create: `examples/grass-rabbit-react/package.json`
- Create: `examples/grass-rabbit-react/next.config.ts`
- Generate and ignore: `examples/grass-rabbit-react/next-env.d.ts`
- Create: `examples/grass-rabbit-react/postcss.config.mjs`
- Create: `examples/grass-rabbit-react/tsconfig.json`
- Create: `examples/grass-rabbit-react/.gitignore`
- Modify: `package.json`
- Modify: `package-lock.json`

- [x] **Step 1: Add an exact, private package manifest**

Use `@pixel-point/aval-grass-rabbit-react-example` as the workspace name. Pin
Next 16.2.11, React 19.2.7, Tailwind 4.3.2, Next-compatible TypeScript 6.0.3,
the repository React/Node types, local Inter 5.2.8, and
`@pixel-point/aval-react` 1.0.0. Add `predev`,
`dev`, `prebuild`, `build`, and `typecheck` scripts.

- [x] **Step 2: Add the App Router configuration**

Configure `output: "export"` and strict React behavior without exposing AVAL's
transitive dependency graph through `transpilePackages`. Configure Tailwind
through `@tailwindcss/postcss` and use strict bundler-oriented TypeScript
options.

- [x] **Step 3: Register root commands**

Add the example to root workspaces, production build, and a
`grass-rabbit-react` development command that first builds the public packages.

- [x] **Step 4: Install the new exact dependencies**

Run: `npm install --ignore-scripts --no-audit --no-fund`

Expected: the root lockfile records Next 16.2.11 and the example workspace with
no audit or lifecycle-script failure.

### Task 2: Synchronize the canonical compiled assets

**Files:**
- Create: `examples/grass-rabbit-react/scripts/prepare-assets.mjs`
- Modify: `examples/grass-rabbit-react/.gitignore`
- Source only: `examples/grass-rabbit/public/grass-rabbit/*.avl`
- Source only: `examples/grass-rabbit/public/interaction-hotspot.svg`

- [x] **Step 1: Implement deterministic asset preparation**

Resolve both examples relative to `import.meta.url`, create
`public/grass-rabbit`, and copy exactly `av1.avl`, `vp9.avl`, `h265.avl`,
`h264.avl`, and `interaction-hotspot.svg`. Validate every source with `stat`
before copying and report a compact JSON success result.

- [x] **Step 2: Ignore generated public files**

Ignore `.next`, `out`, `next-env.d.ts`, the copied codec directory, and the
copied interaction asset. Keep the preparation script and all authored source
tracked. The typecheck command runs `next typegen` before `tsc`, following the
Next.js 16 generated-type contract on a fresh checkout.

- [x] **Step 3: Exercise the preparation contract**

Run: `npm run prebuild -w @pixel-point/aval-grass-rabbit-react-example`

Expected: five files are generated and the script prints
`{"status":"prepared","assets":5}`.

### Task 3: Build the React experience

**Files:**
- Create: `examples/grass-rabbit-react/app/layout.tsx`
- Create: `examples/grass-rabbit-react/app/page.tsx`
- Create: `examples/grass-rabbit-react/app/globals.css`
- Create: `examples/grass-rabbit-react/components/rabbit-demo.tsx`

- [x] **Step 1: Create the server-rendered document shell**

Import local Inter and global styles, export page metadata and viewport color,
and render a language-tagged body with antialiasing.

- [x] **Step 2: Create the static recipe page**

Render a compact header, two-column hero, exact `useAval()` sample, live demo
slot, ownership explanation, and footer. Use a warm stone canvas, dark stage,
forest accent, responsive single-column fallback, balanced headings, and one
filled repository action.

- [x] **Step 3: Create the client component around the public API**

Declare the four source URLs once, call:

```tsx
const { aval, AvalComponent } = useAval({
  sources: RABBIT_SOURCES,
  autoplay: true,
  autoBind: true,
  onVisualStateChange: handleVisualStateChange,
});
```

Render `AvalComponent` at 640×360 with a descriptive image role and keyboard
focus while interactive. Reflect readiness, visual state, and transition state
from `aval`; do not reimplement pointer events or pass `bindTo`. Dismiss the
interaction hint after the first non-idle visual state. Remove static/error
states from the tab order and keep reduced-motion and fatal alternate UI outside
AVAL ownership.

- [x] **Step 4: Add focused global styling**

Import Tailwind, define the Inter feature settings and page colors, ensure
`aval-player` is a block-level responsive surface, and add a subtle interaction
hint animation disabled by reduced-motion preference.

### Task 4: Document and guard the example

**Files:**
- Create: `examples/grass-rabbit-react/README.md`
- Modify: `scripts/docs/check-docs.mjs`
- Modify: `tests/docs/examples.test.ts`

- [x] **Step 1: Write the runnable example guide**

Document root development/build commands, the exact hook code, asset
synchronization, authored interaction ownership, reactive controller fields,
reduced-motion behavior, and the static export location.

- [x] **Step 2: Add executable documentation assertions**

Check exact React/Next/Tailwind/AVAL versions and public-root import usage. Keep
source, binding, and focus behavior in the browser contract instead of freezing
source spelling. Skip `.next` and `out` in recursive boundary collection.

- [x] **Step 3: Update the checked public-example count**

Change the documentation checker and its Vitest expectation from five to six.

### Task 5: Add a focused browser contract

**Files:**
- Create: `playwright.grass-rabbit-react.config.ts`
- Create: `tests/grass-rabbit-react/grass-rabbit-react.spec.ts`
- Modify: `package.json`

- [x] **Step 1: Configure a cross-browser Next.js test server**

Use a dedicated port, Chromium, Firefox, WebKit, one worker, retained traces on
failure, and the root `grass-rabbit-react` command as the web server.

- [x] **Step 2: Prove the hook and asset graph work together**

Assert the page heading, direct codec sources, automatic self-binding, and
reactive readiness. Drive both focus and hover through `Hover` and back to
`Idle`, and prove reduced motion produces a non-focusable static experience.

- [x] **Step 3: Register the focused test command**

Add `test:grass-rabbit-react` to the root scripts.

### Task 6: Verify and review the finished demo

**Files:**
- Verify: `examples/grass-rabbit-react/**`
- Verify: `package.json`
- Verify: `package-lock.json`
- Verify: `scripts/docs/check-docs.mjs`
- Verify: `tests/docs/examples.test.ts`

- [x] **Step 1: Build public AVAL packages**

Run: `npm run build:public-packages`

Expected: all seven public packages build successfully.

- [x] **Step 2: Typecheck the example**

Run: `npm run typecheck -w @pixel-point/aval-grass-rabbit-react-example`

Expected: TypeScript exits successfully with no diagnostics.

- [x] **Step 3: Create the Next production export**

Run: `npm run build -w @pixel-point/aval-grass-rabbit-react-example`

Expected: Next emits `out/index.html` plus a decoder worker asset and reports a
fully static route.

- [x] **Step 4: Run executable documentation checks**

Run: `npm run docs:check && npx vitest run --config vitest.m9.config.ts tests/docs/examples.test.ts`

Expected: both commands pass and report six checked public examples.

- [x] **Step 5: Run the authored interaction test**

Run: `npm run test:grass-rabbit-react`

Expected: Chromium, Firefox, and WebKit reach interactive readiness, pass the
focus and hover round trips, and verify the reduced-motion presentation.

- [x] **Step 6: Inspect desktop and mobile rendering**

Start the app, capture 1440×1000 and 320×844 views, and verify hierarchy,
player focus, no overflow, readable status, and the one-column mobile layout.

- [x] **Step 7: Run React and strict maintainability reviews**

Review all new TSX and integration changes, fix every actionable issue, then
rerun the focused typecheck, build, documentation, and browser commands.
