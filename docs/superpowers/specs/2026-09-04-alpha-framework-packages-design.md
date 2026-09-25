# aval-alpha framework packages

The requested implementation adds `@pixel-point/aval-alpha-react` and
`@pixel-point/aval-alpha-svelte`, both at the alpha runtime's 0.1.0 preview version.
They depend only on `@pixel-point/aval-alpha` and their framework peer. The
existing interactive AVAL packages and publication transaction remain separate.

## Boundary and API

The existing alpha package already owns native decoding, source fallback,
compositing and resource disposal. An optional `@pixel-point/aval-alpha/adapter`
entry owns the common controller lifecycle: committed option snapshots, source
comparison, live callbacks, status subscriptions, mount/unmount and commands.
The core and custom-element entries do not import it. Both framework components
mount a native canvas directly, avoiding the custom-element dependency and its
additional bytes. A fourth core package would add release coordination without
isolating any additional responsibility; separate lifecycle implementations in
each framework would duplicate the behavior most likely to need fixes.

React follows the existing AVAL pattern: `useAvalAlpha(options)` returns
`{ alpha, AvalAlphaComponent }` with a stable bound component and reactive status.
Svelte follows `createAvalAlpha(() => options)` and
`<AvalAlphaComponent {alpha} />`, with a readable status store. Options use the
existing ordered `AlphaSource[]`, autoplay, loop, CORS and startup timeout, plus
ready/error/autoplay-blocked callbacks. Commands are `ready()`, `play()`,
`pause()`, `seek(seconds)` and `getVideo()`. One controller owns one mounted
component. Commands that require a player reject while unmounted.

Status is `idle | loading | ready | error`, with playing, selected source and
error fields. It does not publish every video frame. Native timing and rate
remain accessible on the video. Equivalent source descriptors and callback-only
updates preserve the player; changed source order/layout/URL, CORS or timeout
replace it. Loop updates in place; enabling autoplay requests playback;
disabling autoplay does not pause an already playing video.

Rendering on the server is inert: deterministic canvas markup and idle status,
with no DOM access or media requests. Mount effects own resources and cleanup,
including React's Strict Mode effect replay and Svelte controller replacement.
Stale readiness, errors and autoplay completions cannot update a replacement.
Component width/height are CSS display dimensions; the runtime owns intrinsic
canvas dimensions. Accessibility and other canvas attributes pass through.

## Verification plan

1. Implement and unit-test the shared binding's meaningful state transitions,
   source equivalence, live callbacks, cancellation and ownership.
2. Add typed React and Svelte APIs, SSR tests and public consumer contracts.
3. Exercise both adapters with real compiled media in Chromium, Firefox and
   WebKit: playback, reactive sources, callbacks, remount and hydration.
4. Build and pack all three preview packages; check isolated consumer imports,
   declarations and package payloads. Do not publish.
5. Measure complete adapter bundles with framework peers externalized and
   report both total alpha bytes and increment over the existing core. Retain
   the existing core/element size gates and reject legacy AVAL/decoder imports.

Framework peer bytes belong to the host application and will be explicitly
excluded from adapter measurements. Media delivery and codec eligibility remain
the alpha runtime's existing contracts.
