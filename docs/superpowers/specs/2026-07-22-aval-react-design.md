# AVAL React Integration Design

**Date:** 2026-07-22  
**Status:** Approved for implementation

## Objective

Add a dedicated `@pixel-point/aval-react` package that gives React applications a Rive-like integration:

```tsx
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

return <AvalComponent />;
```

The hook owns one AVAL element binding. It returns a reactive controller and a stable component already bound to that controller. Consumers do not write custom-element markup, install native listeners, augment JSX, or translate React booleans into AVAL attributes.

## Decisions

### One explicit source map

`sources` is a codec-keyed object with at least one URL:

```ts
type AvalSources = Readonly<{
  av1?: string;
  vp9?: string;
  h265?: string;
  h264?: string;
}> & AtLeastOneSource;
```

Values are strings only. The React API does not accept a JSON manifest, bundle version, integrity metadata, source arrays, or compiler reports. The compiler and runtime formats remain unchanged.

The package renders direct `<source src="..." data-codec="...">` children in AVAL's fixed codec-priority order and keys them by codec. Updating a URL updates the existing host in place and creates a new element source generation; it does not remount the host.

### Rive-like hook result

```ts
interface UseAvalResult {
  readonly aval: AvalReactInstance;
  readonly AvalComponent: React.ComponentType<AvalComponentProps>;
}
```

`AvalComponent` has stable identity for the lifetime of the hook call. One returned component instance may be mounted at a time. The hook and component are intentionally paired; rendering the same returned component in two places is a development-time usage error.

`aval` is an immutable render snapshot plus stable commands:

```ts
interface AvalReactInstance {
  readonly mounted: boolean;
  readonly readiness: RuntimeReadiness;
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly isTransitioning: boolean;
  readonly paused: boolean;
  readonly effectivelyVisible: boolean;
  readonly stateNames: readonly string[];
  readonly eventNames: readonly string[];
  readonly lastError: Readonly<AvalErrorDetail> | null;

  prepare(options?: Readonly<AvalPrepareOptions>): Promise<RuntimeReadinessResult>;
  setState(name: string): Promise<void>;
  send(event: string): boolean;
  readyFor(state: string): boolean;
  play(): Promise<void>;
  pause(): void;
  getDiagnostics(
    options?: Readonly<{ trace?: boolean }>
  ): Readonly<AvalDiagnostics> | null;
}
```

`play()` is the React-facing name for the element's `resume()` command. Before mount, asynchronous commands reject with a clear not-mounted error, boolean commands return `false`, `pause()` is a no-op, and diagnostics return `null`.

### Hook options

```ts
interface UseAvalOptions {
  readonly sources: AvalSources;
  readonly state?: string;
  readonly autoplay?: boolean;
  readonly autoBind?: boolean;
  readonly motion?: AvalMotion;
  readonly fit?: AvalFit;
  readonly crossOrigin?: AvalCrossOrigin;

  readonly onReady?: (result: Readonly<RuntimeReadinessResult>) => void;
  readonly onRequestedStateChange?: (
    detail: Readonly<AvalRequestedStateChangeDetail>
  ) => void;
  readonly onVisualStateChange?: (
    detail: Readonly<AvalVisualStateChangeDetail>
  ) => void;
  readonly onTransitionStart?: (
    detail: Readonly<AvalTransitionDetail>
  ) => void;
  readonly onTransitionEnd?: (
    detail: Readonly<AvalTransitionDetail>
  ) => void;
  readonly onError?: (detail: Readonly<AvalErrorDetail>) => void;
}
```

Defaults are `autoplay: true` and `autoBind: true`. React maps these to `autoplay="visible"`/`autoplay="manual"` and `bindings="auto"`/`bindings="none"` respectively.

### Component props

`AvalComponent` accepts normal React HTML, ARIA, `className`, and `style` props plus `width`, `height`, and an advanced `bindTo` target:

```ts
type AvalBindingTarget = Element | React.RefObject<Element | null> | null;

interface AvalComponentProps
  extends Omit<React.HTMLAttributes<HTMLElement>, "children"> {
  readonly width?: number;
  readonly height?: number;
  readonly bindTo?: AvalBindingTarget;
}
```

By default, automatic authored bindings target the player element itself. `bindTo` sets the element's object-only `interactionTarget`; it replaces the earlier public proposal of `interactionTarget={buttonRef}`. `autoBind` decides whether automatic bindings run at all.

## State semantics

`state` is declarative intent. React rendering itself performs no AVAL mutation; only a committed attribute update reaches the element. A source generation change reapplies the current state intent.

The reactive fields have distinct meanings:

- `requestedState` changes when the graph accepts an intent.
- `visualState` changes when destination pixels commit.
- `isTransitioning` spans transition start through transition end.
- `setState()` resolves when its destination commits.
- Duplicate destinations join the same settlement group.
- A newer different destination rejects older pending requests with `AbortError`.
- `send()` is synchronous and reports whether the authored event was accepted.

Consumers must not copy every `visualState` update back into the declarative `state` option; that would create a feedback loop.

## Framework-neutral snapshot contract

React concurrent rendering needs a cached external store. The element therefore gains a framework-neutral contract rather than forcing the React adapter to reconstruct state from incomplete DOM events:

```ts
interface AvalSnapshot {
  readonly revision: number;
  readonly generation: number;
  readonly connected: boolean;
  readonly readiness: RuntimeReadiness;
  readonly mode: AvalMode;
  readonly assurance: "best-effort" | null;
  readonly staticReason: StaticReason | null;
  readonly requestedState: string | null;
  readonly visualState: string | null;
  readonly isTransitioning: boolean;
  readonly paused: boolean;
  readonly effectivelyVisible: boolean;
  readonly stateNames: readonly string[];
  readonly eventNames: readonly string[];
  readonly inputBindings: readonly Readonly<Binding>[];
  readonly lastError: Readonly<AvalErrorDetail> | null;
}

interface AvalElement {
  getSnapshot(): Readonly<AvalSnapshot>;
  subscribe(listener: () => void): () => void;
}
```

The snapshot is frozen and keeps the same object identity until a semantic field changes. Subscribers are notified for connection, generation, readiness and mode, metadata, state and transition staging, pause/autoplay intent, effective visibility, errors, and terminal disposal. Animation frames never publish revisions. `lastError` resets when a new source generation begins.

The element stages the new snapshot before dispatching the corresponding existing semantic DOM event. Subscriber failures are isolated and do not break playback.

## Lifecycle and rendering

The React package imports the SSR-safe root of `@pixel-point/aval-element` and never imports `/auto`.

Server rendering emits inert deterministic markup:

```html
<aval-player autoplay="visible" bindings="auto">
  <source src="/motion/av1.avl" data-codec="av1">
  <source src="/motion/vp9.avl" data-codec="vp9">
</aval-player>
```

At client ref commit, the adapter:

1. Attaches direct native semantic and error listeners to the raw node.
2. Calls idempotent `defineAvalElement()`.
3. Subscribes to the element snapshot.
4. Applies the current `bindTo` target.
5. Publishes the mounted snapshot to `useSyncExternalStore`.

Cleanup removes React listeners and subscriptions and clears the object binding target. It never calls terminal `dispose()`. Element disconnection remains runtime-retirement authority, which makes React Strict Mode setup/cleanup replay safe.

Only committed renders mutate DOM attributes or source children. Abandoned concurrent renders perform no registration or runtime commands.

## Errors and readiness

The package installs the direct `error` listener before custom-element registration, preserving early upgrade-time failure delivery. Native AVAL error details pass through without wrapping. Expected `AbortError` state supersession remains a rejected command promise and is not promoted to a fatal status.

`onReady` is driven by the element's `prepare()` result for the current source generation. A stale or aborted generation cannot invoke it. `staticReady` is a successful readiness outcome and must not be interpreted as fallback-worthy failure.

The React package renders no built-in fallback and never hides the player. Applications own alternate UI using `aval.lastError?.fatal` or their own policy.

## Package boundary

`@pixel-point/aval-react` is ESM-only and side-effect free. It has:

- An exact runtime dependency on the lockstep `@pixel-point/aval-element` package.
- A React peer dependency compatible with React 18.3 and 19.
- No React DOM, player-web, compiler, format, or graph runtime dependency.
- One SSR-safe root export and no auto-registration entry.
- TypeScript declarations and an API Extractor report.

It joins the existing lockstep technical-preview release set. Because AVAL is not yet production-stable, no API version fork or compatibility shim is required.

## Verification

Verification covers:

- Stable element snapshot identity and semantic-only notifications.
- Every promised reactive field, including pause and visibility.
- Source ordering, URL-only validation, and at-least-one typing.
- SSR import and deterministic server markup.
- Listener-before-registration timing.
- React Strict Mode attach/detach replay without disposal or duplicate callbacks.
- Stable returned `AvalComponent` identity and one-mounted-instance enforcement.
- Declarative and imperative state timing, latest-intent aborts, and authored events.
- In-place source changes without host remount.
- Workspace builds, API reports, packed consumers, release manifests, and the migrated React example.

