# Grass Rabbit React Demo Design

**Date:** 2026-07-22

## Purpose

Add a dedicated, runnable React showcase for AVAL using Next.js App Router and
Tailwind CSS. The page must demonstrate the approved Rive-like React contract:
`useAval()` returns both an `aval` controller and an `AvalComponent`, while the
compiled asset remains responsible for authored interaction behavior.

## Chosen direction

The example lives at `examples/grass-rabbit-react` as a first-class workspace.
It is a static-exportable Next.js application with one small client component.
The surrounding page, metadata, explanatory copy, and code sample remain server
components; only the live rabbit experience carries `"use client"`.

The example pins TypeScript 6.0.3 locally because Next.js 16.2.11 loads the
classic TypeScript JavaScript compiler API during production builds, while the
workspace's TypeScript 7 package intentionally exposes only the native CLI API.

The visual direction is a restrained, editorial React recipe rather than a
second copy of the existing AVAL launch page. A warm stone canvas, dark motion
stage, forest accent, compact header, live status row, and an exact usage sample
keep the rabbit and the API as the focus. On narrow screens the layout becomes a
single column without hiding behavior or controls.

## Runtime ownership

The hook is configured with four direct `.avl` URLs, `autoplay: true`, and
`autoBind: true`. It does not pass JSON, bundle version, integrity, a controlled
state, or a custom interaction target.

The compiled Grass Rabbit graph owns:

- its initial intro and looping idle presentation;
- pointer, keyboard-focus, and touch engagement bindings;
- entering, hover, and exiting transition routes;
- codec selection across AV1, VP9, H.265, and H.264 sources.

React owns:

- mounting the returned `AvalComponent`;
- rendering `aval.readiness`, `aval.visualState`, and
  `aval.isTransitioning` as live UI;
- remembering whether the first interaction occurred so the visual hint can be
  dismissed;
- presenting consumer-owned fatal-error and cause-neutral static-policy
  messages.

The experience badge says `Live` only at `interactiveReady`. A `staticReady`
result is labeled `Motion inactive`, removed from the tab order, and covered by
a cause-neutral app-owned explanation rather than presented as an interactive
success. Static readiness may reflect reduced motion, visibility suspension, or
decoder admission.

This avoids duplicating the state machine with React pointer handlers and shows
the intended adapter boundary directly.

## Asset strategy

The canonical compiled assets remain in
`examples/grass-rabbit/public/grass-rabbit`. A small preparation script copies
only the four `.avl` files and the existing interaction hint into the Next
example's ignored `public` directory during `predev` and `prebuild`.

This was selected over three alternatives:

1. Checking in a second binary bundle is the easiest local layout, but creates
   almost 2 MB of duplicate source-of-truth assets.
2. Serving sibling files through a route handler avoids copies, but makes a
   static example server-dependent and obscures normal public asset URLs.
3. Symlinking public assets is concise, but is less reliable in deployment and
   archive workflows.

Generated copying keeps deployment conventional, preserves static export, and
maintains one checked-in bundle.

## Component boundaries

- `app/layout.tsx` owns metadata, the local Inter variable font import, and the
  document shell.
- `app/page.tsx` owns all non-interactive page structure and the exact hook
  sample.
- `components/rabbit-demo.tsx` owns `useAval()`, the returned component, live
  controller state, the interaction hint, and alternate UI.
- `app/globals.css` owns Tailwind, shared page tokens, the AVAL host display
  contract, focus treatment, and the small hint animation.
- `scripts/prepare-assets.mjs` owns deterministic asset synchronization.

## Accessibility and motion

`AvalComponent` becomes keyboard-focusable only at `interactiveReady`, has an
image role and neutral accessible name, and references a readiness-aware visible
instruction. This lets the authored engagement bindings work with the keyboard
without advertising unavailable input while loading or static. Status values
are readable text rather than color-only indicators. Focus rings are visible on
both the player and links. At `staticReady`, the page explains that motion is
inactive under the current runtime policy without guessing which policy
produced the result; this is not treated as failure. Fatal runtime errors
replace only the motion surface with consumer-owned alternate content.

The page uses responsive type, minimum 44-pixel interactive targets, balanced
headings, restrained shadows, and one filled page action. Decorative motion is
removed under `prefers-reduced-motion`.

## Verification

The example is part of the root workspace and root production build. It has its
own strict TypeScript check. Focused Chromium, Firefox, and WebKit tests start
the Next app and prove that the page reaches interactive readiness, owns four
direct codec sources, binds interaction to the returned host, and drives both
focus and hover routes to `hover` and back to `idle`. A reduced-motion contract
also verifies the static presentation. Documentation guards recognize the sixth
public React example and skip generated Next output.

The final verification sequence is:

1. prepare assets;
2. build public AVAL packages;
3. typecheck the Next example;
4. create the static Next production export;
5. run documentation checks and the focused browser test;
6. inspect the rendered desktop and mobile layouts.
