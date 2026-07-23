# @pixel-point/aval-react

React integration for AVAL interactive motion. The package wraps the public
AVAL custom element without duplicating runtime ownership.

```tsx
import { useAval } from "@pixel-point/aval-react";

export function FavoriteMotion() {
  const { aval, AvalComponent } = useAval({
    sources: {
      av1: "/motion/favorite/av1.avl",
      vp9: "/motion/favorite/vp9.avl",
      h265: "/motion/favorite/h265.avl",
      h264: "/motion/favorite/h264.avl"
    },
    state: "idle",
    autoplay: true,
    autoBind: true
  });

  return (
    <>
      <AvalComponent width={160} height={160} aria-hidden />
      <button onClick={() => void aval.setState("favorite")}>Favorite</button>
    </>
  );
}
```

`sources` requires at least one codec URL and accepts URL strings only. The
browser preference order is AV1, VP9, H.265, then H.264. Changing a URL updates
the same player element in place.

`AvalComponent` is stable and bound to its `useAval()` call. Mount one instance
of that returned component at a time. It accepts ordinary HTML and ARIA props,
`className`, `style`, `width`, `height`, and `bindTo` for associating authored
automatic input bindings with another semantic element. The adapter owns its
direct `<source>` children, so child content and `dangerouslySetInnerHTML` are
intentionally not component props.

The reactive `aval` object exposes readiness, requested and visual state,
transition status, pause and visibility state, authored names, the last error,
and commands for preparation, state, events, and playback. Snapshot changes
rerender React; decoded frames do not.

The root export is safe to import during server rendering. It emits inert
`<aval-player>` markup with direct source children and performs registration
only during client ref commit after direct error listeners are installed.
React Strict Mode cleanup never terminally disposes the AVAL element.

AVAL does not render fallback UI. Applications own sibling alternate content
and should reveal it only for fatal errors, then recover according to their
interactive-readiness policy.
