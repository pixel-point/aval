# aval-alpha framework adapters

| Consumer | Package | Entry API |
| --- | --- | --- |
| JavaScript canvas | `@pixel-point/aval-alpha` | `createAvalAlpha(canvas, options)` |
| HTML | `@pixel-point/aval-alpha/element` | `defineAvalAlphaElement()` |
| React 18.3 / 19 | `@pixel-point/aval-alpha-react` | `useAvalAlpha(options)` → `{ alpha, AvalAlphaComponent }` |
| Svelte 5 | `@pixel-point/aval-alpha-svelte` | `createAvalAlpha(() => options)` and `AvalAlphaComponent` |
| Custom framework integration | `@pixel-point/aval-alpha/adapter` | `createAlphaConfiguration`, `createAlphaBinding` |

The framework packages depend on the shared alpha package and their framework
peer. Both components render a canvas. The alpha package's optional adapter
entry contains the common lifecycle; its core and element entries do not import
adapter code. There is one native decoder/compositor implementation and one
reactive controller implementation. The existing interactive AVAL package graph
is not part of this dependency tree.

Use the [React example](../../packages/alpha-react/README.md) or
[Svelte example](../../packages/alpha-svelte/README.md). Compilation and source
fallback use the [same contract as JavaScript](../../packages/alpha/README.md).
The source list can contain different codec/container combinations and different
packed layouts, in authored priority order. These wrappers add no format limits.

## Shared behavior

`AlphaAdapterOptions` extends core `AlphaOptions` with `onReady(source)`.
Options include `sources`, `autoplay`, `loop`, `crossOrigin`, `timeoutMs`,
`onError` and `onAutoplayBlocked`. Source rectangles and startup timeouts are
validated while creating an option snapshot; invalid configuration throws.
Loading, decoder and rendering failures report `onError` and error status.

| Status field | Meaning |
| --- | --- |
| `status` | `idle`, `loading`, `ready` or `error` |
| `playing` | Native media is playing and has not ended |
| `source` | Selected source after its first successful transparent draw |
| `error` | Terminal `AvalAlphaError`, otherwise `undefined` |

React returns these fields on `alpha`; Svelte exposes them through its readable
store (`$alpha`). Status does not update on every frame. Use `getVideo()` for
native timing, duration, playback rate or media events, and reacquire it after
source replacement. Do not change its `src` or remove the owned video manually.

`ready()` waits for the current mounted player's first transparent frame.
`play()` and `seek(seconds)` also wait for readiness. Calling them without a
mounted component rejects with a `disposed` error; they do not queue indefinitely.
`pause()` is harmless while detached. Unmounting or replacing the player aborts
pending media work. Framework cleanup releases media, frame callbacks and GPU
resources. Mount one component for each controller; multiple simultaneous mounts
throw instead of silently transferring ownership.

| Change | Result |
| --- | --- |
| Equal source values in a new array | Preserve the player and playback position |
| New callbacks or canvas styling | Preserve playback; subsequent events use current callbacks |
| Source URL, type, order, dimensions or rectangles | Replace the player and retry sources from the beginning |
| CORS or startup timeout | Replace the player |
| `loop` | Update the native loop setting |
| `autoplay: false` → `true` | Start playback, reporting policy rejection through `onAutoplayBlocked` |
| `autoplay: true` → `false` | Disable future automatic starts; use `pause()` to pause now |

SSR renders an inert canvas and idle status. No media is requested during server
rendering. React uses commit effects plus `useSyncExternalStore`; Svelte uses
effects with cleanup and keeps callbacks outside reactive dependency tracking.
The React component type stays stable across renders. Svelte controller identity
survives `$state` proxies. Both release the old instance before remount/replacement.
[React store contract](https://react.dev/reference/react/useSyncExternalStore),
[React Strict Mode](https://react.dev/reference/react/StrictMode),
[Svelte effects](https://svelte.dev/docs/svelte/$effect).

Canvas width/height props are CSS display dimensions in pixels; the runtime owns
intrinsic pixel dimensions. Other canvas attributes, events, class and style pass
through. Consumers own accessibility labels, loading/error presentation and
poster images. A poster can sit behind the transparent canvas while it loads.

## Custom bindings and maintenance

The optional adapter entry is also usable from plain JavaScript:

```js
import { createAlphaBinding, createAlphaConfiguration } from '@pixel-point/aval-alpha/adapter';

const binding = createAlphaBinding(createAlphaConfiguration({ sources, loop: true }));
const unsubscribe = binding.subscribe(() => console.log(binding.getStatus()));
const unmount = binding.mount(canvas);
await binding.commands.ready();

binding.commit(createAlphaConfiguration({ sources: nextSources, loop: true }));
// On cleanup:
unmount();
unsubscribe();
```

Creating a configuration or binding is pure with respect to the DOM. Frameworks
prepare configuration during render and call `commit` only after a committed
render, so abandoned renders cannot mutate playback. A mount's returned cleanup
is idempotent and cannot clean up a later mount. The low-level canvas API remains
the smallest option when a reactive controller is unnecessary.

```sh
npm run build:alpha
npm run typecheck:alpha
npm run test:alpha
npm run alpha:frameworks                 # SSR demos on :4189/react and :4189/svelte
npm run test:alpha:frameworks            # Generate media first with alpha:fixtures
npm run alpha:size
npm run alpha:pack
```

All three alpha packages use preview version 0.1.0. Their pack checks operate
separately from the existing six-package interactive AVAL release transaction.
Nothing is published by these commands. See [measured sizes and browser
evidence](./verification.md) for actual transfer totals and testing limits.
