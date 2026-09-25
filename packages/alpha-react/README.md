# @pixel-point/aval-alpha-react

React 18.3 / 19 bindings for small transparent videos. The player uses the
browser's native decoder and one WebGL canvas. It shares playback and lifecycle
code with the JavaScript and Svelte packages; it ships no WASM, demuxer or
interactive AVAL runtime.

This is a 0.1.0 preview package. React is a peer dependency supplied by the
application. Install it in your React project:

```sh
npm install @pixel-point/aval-alpha-react
```

```tsx
'use client';

import { useAvalAlpha } from '@pixel-point/aval-alpha-react';
import sources from './generated/sources.js';

export function Motion() {
  const { alpha, AvalAlphaComponent } = useAvalAlpha({
    sources,
    autoplay: true,
    loop: true,
    onError(error) { console.error(error); }
  });

  return <>
    <AvalAlphaComponent width={640} height={360}
      role="img" aria-label="Animated illustration" />
    <button onClick={() => void alpha.play()}>Play</button>
    <button onClick={() => alpha.pause()}>Pause</button>
    <span>{alpha.status}</span>
  </>;
}
```

`sources` is the compiler's ordered `AlphaSource[]`, supporting AV1, VP9, HEVC
and H.264 alternatives. Import the generated `sources.js` default export, or use
the `sources` field of `sources.json`. `AvalAlphaComponent` has stable identity
across hook renders. Mount one component per hook instance.

The hook accepts all core options plus `onReady(source)`. It returns reactive
`status`, `playing`, `source` and `error`, together with stable `ready()`, `play()`,
`pause()`, `seek(seconds)` and `getVideo()` commands. `ready()` resolves after
the first transparent draw. Commands requiring a player reject while unmounted.

Equivalent source arrays and callback changes preserve the video. Changed URLs,
layouts, source order, CORS or timeout replace it. Loop changes apply immediately;
enabling autoplay requests playback. Disabling autoplay does not pause an already
playing video. `onAutoplayBlocked` lets the app show a play button.

Standard canvas attributes, events, class and style pass through. Width/height
props set CSS display dimensions; the runtime owns the canvas backing dimensions.
Children and `dangerouslySetInnerHTML` are excluded. SSR emits an inert canvas
and idle status; media starts after mount. Cleanup supports React Strict Mode.

The complete minified runtime is approximately 4.95 kB gzip, including the shared
player and binding, excluding the application's React peer and the video file.
The adapter adds approximately 1.35 kB gzip over the core. Reproduce with
`npm run alpha:size`.

See the [shared framework contract](../../docs/alpha/frameworks.md),
[compiler and delivery instructions](../alpha/README.md), and
[verification evidence](../../docs/alpha/verification.md).
