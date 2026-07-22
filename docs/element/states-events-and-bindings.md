# User-defined states, events, and bindings

State names are asset data, not a runtime enum. The same API can drive
`idle`/`engaged`, `loading`/`success`/`error`, or any other validated graph.

```js
const motion = document.querySelector("aval-player");
await motion.prepare();
console.log(motion.stateNames, motion.eventNames, motion.inputBindings);
await motion.setState("success");
motion.send("retry.requested");
```

Declarative state is latest-wins and may be set before metadata:

```html
<aval-player state="loading">
  <source
    src="status.avl"
    data-codec="h264"
  >
</aval-player>
```

Automatic input never guesses a destination. It routes only the manifest's
binding from a fixed source (`pointer.enter/leave`, `focus.in/out`,
`engagement.on/off`, `activate`, `visible`, or `hidden`) to an authored event.
Pointer and focus are OR-aggregated for engagement. For touch and pen input,
the latest completed tap owns the engagement level: tapping the interaction
target engages it, while completing a tap elsewhere releases focus retained by
that target and disengages it. Raw `pointer.*` edges remain native-only; native
click supplies pointer and keyboard activation. `bindings="none"` removes
automatic routing while direct methods remain available.

Use `interaction-for` for a same-root semantic control ID, or assign the
non-reflected `interactionTarget` property. A missing explicit ID disables
interaction input rather than silently falling back to the animation host.
