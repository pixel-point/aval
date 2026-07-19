# Diagnostics and DOM events

Listen for `readinesschange`, `requestedstatechange`, `visualstatechange`,
`transitionstart`, `transitionend`, `underflow`, and `error`.
Events are noncancelable and contain an immutable positive source generation.
All events except `error` bubble and are composed. Register `error` directly on
the element so a motion load failure cannot become a page-wide error. Properties
are staged before dispatch.

```js
motion.addEventListener("error", ({ detail }) => {
  if (detail.fatal) showMessage(detail.failure.code);
});
const snapshot = motion.getDiagnostics({ trace: true });
```

Diagnostics are bounded observations and do not fetch, retry, prepare, reclaim,
or advance the graph. Traces cap at 512 records. Snapshots omit URLs, paths,
headers, ETags, integrity values, response text, consumer HTML, raw errors,
raw byte payloads, frames, workers, decoders, GL objects, and resource
capabilities. Numeric verified/resident byte counts remain available for
resource diagnosis.

A `staticReady` prepare result is limited to nonfatal reduced-motion,
visibility-suspension, or decoder-admission policy. Playback failures instead
set readiness to `error`, reject with `AvalPlaybackError`, and remain in
`lastFailure` until a newer source generation starts. Expected supersession,
disconnect, and disposal aborts are quiet.

`runtime.decoderDiagnostics` contains at most one terminal record per physical
decoder lane. It preserves sanitized phase/code/exception and first-frame
metadata without asset bytes, URLs, stack traces, decoder configs, or frame
objects. This bounded failure evidence is present even when verbose trace
capture is disabled.

`cleanup` is either `null` or the immutable receipt for the most recently
retired source and identifies both element and source generations. A receipt is
complete only when player disposal, participant unregistration, logical bytes,
leases, registered cleanup, tracked work, pending waits, decoder tickets,
workers, frames, runtime operations, source copies, staging bytes, loads,
transport bodies, interested waiters, renderer/context resources, and cleanup
failures all settle. `failureCount > 0` or any nonzero participant owner keeps
`completed` false and prevents a successor or terminal `finalDisposed` claim.
Page byte, participant, and decoder totals are contextual: they may remain
nonzero because other elements share the page runtime and are not part of this
element's zero-owner proof.
