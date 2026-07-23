# React integration

Install the dedicated adapter:

```sh
npm install @pixel-point/aval-react@1.0.0
```

The package owns custom-element registration, source markup, native event
listeners, and React lifecycle integration. Its root is SSR-safe.

## Basic usage

```tsx
import { useAval } from "@pixel-point/aval-react";

const FAVORITE_SOURCES = {
  av1: "/motion/favorite/av1.avl",
  vp9: "/motion/favorite/vp9.avl",
  h265: "/motion/favorite/h265.avl",
  h264: "/motion/favorite/h264.avl"
} as const;

export function FavoriteMotion({ state }: { state: string }) {
  const { aval, AvalComponent } = useAval({
    sources: FAVORITE_SOURCES,
    state,
    autoplay: true,
    autoBind: true,
    onError: ({ fatal, failure }) => {
      if (fatal) reportPlaybackFailure(failure.code);
    }
  });

  return (
    <>
      <AvalComponent width={160} height={160} aria-hidden />
      {aval.lastError?.fatal && <img src="/favorite.png" alt="" />}
    </>
  );
}
```

`sources` requires at least one codec URL. Values are URL strings; there is no
React JSON manifest, bundle-version, or integrity-descriptor API. Browser
selection always follows AV1, VP9, H.265, then H.264 regardless of object key
order. Changing a URL updates the existing player in place.

`AvalComponent` is bound to its `useAval()` call and has stable identity. Mount
one instance of that returned component at a time. It accepts ordinary HTML,
ARIA, `className`, and `style` props plus `width`, `height`, and `bindTo`. The
adapter exclusively owns its direct `<source>` children, so child content and
`dangerouslySetInnerHTML` are not accepted.

## State and authored events

The `state` option is application-owned declarative intent. AVAL does not write
runtime state back into it. Do not mirror every `visualState` change into the
option.

```tsx
const { aval, AvalComponent } = useAval({
  sources: CHECKOUT_SOURCES,
  state: "idle"
});

return (
  <>
    <AvalComponent aria-hidden />
    <button
      disabled={!aval.readyFor("loading")}
      onClick={() => {
        void aval.setState("loading").catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") {
            return; // a newer valid state intent won
          }
          throw error;
        });
      }}
    >
      Load
    </button>
    <output>
      requested: {aval.requestedState ?? "none"}; visual:{" "}
      {aval.visualState ?? "none"}
    </output>
  </>
);
```

`requestedState` changes when the graph accepts an intent. `visualState`
changes when destination pixels commit. `setState()` resolves at that visual
commit. A newer different request rejects an older pending request with
`AbortError`.

Authored events are synchronous:

```ts
const accepted = aval.send("retry.requested");
```

`false` means the event was not currently routable or the runtime was not
ready.

## Playback and automatic bindings

`autoplay: true` maps to visibility-aware playback; `false` starts in manual
mode. Use `aval.pause()` and `await aval.play()` to control manual playback.

`autoBind: true` enables authored pointer, focus, activation, and visibility
bindings. They target the motion element by default. Associate them with a
semantic control through `bindTo`:

```tsx
const buttonRef = useRef<HTMLButtonElement>(null);
const { AvalComponent } = useAval({
  sources: FAVORITE_SOURCES,
  autoBind: true
});

return (
  <button ref={buttonRef} type="button" aria-pressed={favorite}>
    <AvalComponent bindTo={buttonRef} aria-hidden />
    <span>Favorite</span>
  </button>
);
```

Set `autoBind: false` when application code sends all state and event intent.

## Reactive updates, SSR, and cleanup

`aval` exposes `mounted`, readiness, requested and visual state, transition
status, pause and effective-visibility state, authored state/event names, and
the latest normalized error. React rerenders only for semantic snapshot
changes, never for decoded frames.

Server rendering emits inert `<aval-player>` and direct `<source>` children.
On the client, the adapter installs the direct error listener before defining
the custom element. React Strict Mode cleanup removes adapter listeners and
subscriptions but never terminally disposes the element; DOM disconnection
remains AVAL's resource-retirement authority.

`staticReady` is a successful reduced-motion, visibility, or decoder-admission
outcome, not a fatal fallback signal. AVAL renders no alternate UI and never
hides itself. Applications retain ownership of sibling fallback content.
