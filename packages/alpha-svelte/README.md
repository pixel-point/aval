# @pixel-point/aval-alpha-svelte

Svelte 5 bindings for small transparent videos. Native decoding, one WebGL
compositor and the controller lifecycle are shared with the JavaScript and React
packages. No WASM, demuxer or interactive AVAL runtime is shipped.

This is a 0.1.0 preview package. Svelte is a peer dependency supplied by the
application. Use a Svelte-aware bundler such as SvelteKit or Vite with the Svelte
plugin, and install it in your Svelte project:

```sh
npm install @pixel-point/aval-alpha-svelte
```

```svelte
<script lang="ts">
  import { AvalAlphaComponent, createAvalAlpha } from '@pixel-point/aval-alpha-svelte';
  import sources from './generated/sources.js';

  let loop = $state(true);
  const alpha = createAvalAlpha(() => ({
    sources,
    autoplay: true,
    loop,
    onError(error) { console.error(error); }
  }));
</script>

<AvalAlphaComponent {alpha} width={640} height={360}
  role="img" aria-label="Animated illustration" />
<button onclick={() => void alpha.play()}>Play</button>
<button onclick={() => alpha.pause()}>Pause</button>
<span>{$alpha.status}</span>
```

Pass an **option getter** so changes to sources and options are reactive. Each
controller owns one mounted component. It is also safe to hold the controller in
`$state` and replace it; the component releases the old player and attaches the
new one. Controllers can be created during SSR without accessing the DOM.

`sources` is the compiler's ordered `AlphaSource[]`, supporting AV1, VP9, HEVC
and H.264 alternatives. Import `sources.js`'s default export or the `sources`
field of `sources.json`. Options include autoplay, loop, CORS, timeout and
`onReady(source)`, `onError(error)`, `onAutoplayBlocked(error)` callbacks.

`$alpha` contains `status`, `playing`, `source` and `error`. The controller provides
`ready()`, `play()`, `pause()`, `seek(seconds)` and `getVideo()`. Readiness means
the first transparent draw; commands requiring a player reject while unmounted.
Equivalent source arrays and new callbacks preserve playback. Changes to source
content/order, CORS or timeout replace the player. Loop updates in place;
enabling autoplay requests playback and disabling it does not pause playback.

Canvas attributes, events, class and style pass through. Width/height props are
CSS display dimensions; the player owns intrinsic canvas dimensions. SSR emits
an inert canvas and idle status; mounting starts media and unmounting releases it.

The complete minified runtime is approximately 5.14 kB gzip, including the shared
player and binding, excluding the application's Svelte peer and the video file.
The adapter adds approximately 1.53 kB gzip over the core. Reproduce with
`npm run alpha:size`.

See the [shared framework contract](../../docs/alpha/frameworks.md),
[compiler and delivery instructions](../alpha/README.md), and
[verification evidence](../../docs/alpha/verification.md).
