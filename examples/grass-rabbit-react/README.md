# Grass Rabbit for React

This example renders the canonical Grass Rabbit AVAL asset in a statically
exported Next.js App Router page styled with Tailwind CSS. It demonstrates the
public `@pixel-point/aval-react` entry point, authored hover and focus behavior,
and React-facing runtime state.

## Run it

From the repository root:

```sh
npm run grass-rabbit-react
```

Open `http://localhost:3000`. The root command builds the public AVAL packages
before starting Next.js. Hover the rabbit, or focus it with the keyboard, to
enter its authored hover state.

Create a production export with:

```sh
npm run build:public-packages
npm run build -w @pixel-point/aval-grass-rabbit-react-example
```

The static site is written to `examples/grass-rabbit-react/out`.

## Hook recipe

The component and its reactive controller come from one hook call:

```tsx
"use client";

import { useAval } from "@pixel-point/aval-react";

const sources = {
  av1: "/grass-rabbit/av1.avl",
  vp9: "/grass-rabbit/vp9.avl",
  h265: "/grass-rabbit/h265.avl",
  h264: "/grass-rabbit/h264.avl"
};

function Rabbit() {
  const { aval, AvalComponent } = useAval({
    sources,
    autoplay: true,
    autoBind: true
  });
  const interactive = aval.readiness === "interactiveReady";
  const inactive = aval.readiness === "staticReady" ||
    aval.readiness === "disposed" ||
    aval.readiness === "error";

  return (
    <>
      <AvalComponent
        width={640}
        height={360}
        tabIndex={interactive ? 0 : -1}
        role="img"
        aria-label="Grass rabbit animation"
        aria-hidden={inactive}
      />
      <p>{aval.readiness}</p>
      <p>{aval.visualState}</p>
      <p>{aval.isTransitioning ? "Transitioning" : "At rest"}</p>
    </>
  );
}
```

`AvalComponent` owns the player host and its codec sources. With automatic
bindings enabled, the asset's engagement graph handles hover and focus input;
the React component does not recreate those pointer events.

The `aval` controller is a reactive React snapshot. Changes to `readiness`,
`visualState`, and `isTransitioning` rerender the status strip, while decoded
frames remain outside React's rendering work.

## Assets and application-owned UI

The canonical compiled files remain in `examples/grass-rabbit`. The example's
`predev` and `prebuild` scripts copy the four codec renditions and interaction
marker into its generated `public` directory. Do not edit the copies; update the
canonical asset and rerun either command instead.

AVAL owns motion playback, authored state changes, and input bindings. The app
owns the surrounding instructions, reactive status labels, and fatal-error
message. When AVAL reports `staticReady`—for reduced motion, visibility, or
decoder-admission policy—the page suppresses interaction and presents its own
cause-neutral static explanation.
