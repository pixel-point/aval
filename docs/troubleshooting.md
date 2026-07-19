# Troubleshooting

- `static` mode is a nonfatal reduced-motion, visibility, or decoder-admission
  policy result. It is not playback-failure fallback UI.
- Terminal capability or playback failure rejects with `AvalPlaybackError` and
  raises one fatal `error` event. Branch on `failure.code`, then inspect bounded
  `runtime.decoderDiagnostics`; do not parse browser exception text.
- Range errors usually indicate transformed encoding, missing/malformed
  `Content-Range`, or a changing/missing strong ETag.
- External integrity mismatch means the complete fetched bytes are not the
  declared asset. Do not retry from a different range cache silently.
- `AbortError` commonly means a newer state/source superseded an operation.
- A request can wait for a decoder under page pressure. It must settle or abort;
  queues are bounded and FIFO.
- After a real disconnect, reconnect starts a fresh source generation. A final
  `dispose()` makes that element instance inert.
- If `getDiagnostics().cleanup.completed` is false, inspect its participant
  ownership and `failureCount`. Do not treat page totals as a leak while peer
  elements are active. A failed receipt blocks replacement/final disposal
  until a later lifecycle operation observes a completed receipt.

Capture the bounded diagnostics snapshot and public event order. Do not include
signed URLs, cookies, response bodies, local paths, or device serial numbers in
a support report.
