# End-user playground

This permanent example exercises the public `@pixel-point/aval-element` API
with real checked-in AV1, VP9, H.265, and H.264 renditions of one two-state
asset. The browser selects the first qualifying family in the fixed AV1 → VP9
→ H.265 → H.264 ladder, independent of DOM order. From the repository root,
run:

```sh
npm install
npm run playground
```

Open the printed loopback URL (normally `http://127.0.0.1:5173`). Hover or
focus the favorite icon to exercise authored input bindings, or use either
button to toggle the `idle` and `engaged` states explicitly.

The animation uses workspace packages and does not require FFmpeg at runtime.
If the animated browser path is unavailable, the application handles the fatal
error and reveals its checked-in PNG outside the custom element.
