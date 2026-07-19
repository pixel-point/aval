# @pixel-point/aval-player-web

Web-only AVAL runtime: checked range/integrity loader, WebCodecs
scheduler and worker, WebGL packed-alpha presentation, logical motion-state
coordination, and page-wide decoder/byte resource arbitration. It does not
decode or retain poster images and does not own alternate presentation UI.
Reduced motion, hidden visibility, and decoder admission may intentionally
produce `staticReady`; capability, readiness, renderer, worker, timeout, and
active-playback failures instead reject with `RuntimePlaybackError` and leave
the runtime in terminal `error` readiness for consumer-owned fallback handling.

Most applications should prefer `@pixel-point/aval-element`. See the repository
[performance and budget guide](../../docs/performance-and-budgets.md) and
[authoring guide](../../docs/compiler/authoring-video-and-states.md).
