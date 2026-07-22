# React integration

Use the custom tag for reflected configuration and a typed ref for methods,
object targets, and custom events. No React wrapper is required.

The runnable example at `examples/react-ref` pins its React, TypeScript, and
Vite versions. Once the workspace packages are available locally, install the
exact element release alongside the example dependencies, then typecheck and
build it:

```sh
cd examples/react-ref
npm install @pixel-point/aval-element@1.0.0
npm run typecheck
npm run build
```

The repository release gate substitutes the exact packed local element
tarball for that install. This document does not claim that version 1.0.0 is
already available from a public registry.

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import {
  defineAvalElement,
  type AvalElement,
  type AvalErrorDetail
} from "@pixel-point/aval-element";

export function StatusMotion({
  state,
  onVisualState
}: {
  state: string;
  onVisualState?: (state: string | null) => void;
}) {
  const current = useRef<AvalElement | null>(null);
  const [failed, setFailed] = useState(false);
  const attach = useCallback((node: AvalElement | null) => {
    if (node === null) return;
    current.current = node;
    const listener = () => onVisualState?.(node.visualState);
    const readiness = () => {
      if (node.readiness === "interactiveReady") setFailed(false);
    };
    const failure = (event: CustomEvent<AvalErrorDetail>) => {
      if (event.detail.fatal) setFailed(true);
    };
    const detach = () => {
      node.removeEventListener("visualstatechange", listener);
      node.removeEventListener("readinesschange", readiness);
      node.removeEventListener("error", failure);
      if (current.current === node) current.current = null;
    };
    node.addEventListener("visualstatechange", listener);
    node.addEventListener("readinesschange", readiness);
    node.addEventListener("error", failure);
    try {
      defineAvalElement();
    } catch (error) {
      detach();
      throw error;
    }
    return detach;
  }, [onVisualState]);
  return (
    <>
      <aval-player ref={attach} state={state}>
        <source
          src="/status.h264.avl"
          data-codec="h264"
        />
      </aval-player>
      {failed && <span aria-hidden="true">{state}</span>}
    </>
  );
}
```

The React 19 callback ref runs during the commit that connects the node. It
installs listeners before registration and before a pre-defined element's
queued connection work, including on remount, while server rendering remains
free of DOM global access. Its returned cleanup removes the listeners. Assign
an object-only target in a separate effect when needed:

```tsx
useEffect(() => {
  const node = current.current;
  if (node) node.interactionTarget = buttonRef.current;
  return () => {
    if (node) node.interactionTarget = null;
  };
}, []);
```

Add this local declaration to a `.d.ts` file included by your TypeScript
configuration. It combines normal React HTML/ARIA/ref props with the element's
closed public attribute contract:

```ts
import type {
  AvalElement,
  AvalElementAttributes
} from "@pixel-point/aval-element";
import type { DetailedHTMLProps, HTMLAttributes } from "react";

type AvalReactProps = DetailedHTMLProps<
  HTMLAttributes<AvalElement>,
  AvalElement
> & AvalElementAttributes;

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "aval-player": AvalReactProps;
    }
  }
}
```

Keep custom DOM events on `addEventListener`; React custom-event prop naming is
not the element contract. Do not mirror every visual-state event back into a
controlled `state` prop; application semantics should own that prop. Keep the
consumer-owned alternate content outside `<aval-player>` and decide from the
fatal `error` event or `AvalPlaybackError` whether to render it.
