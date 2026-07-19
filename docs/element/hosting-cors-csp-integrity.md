# Hosting, ranges, CORS, CSP, and integrity

Serve `.avl` as `application/vnd.aval` (or
`application/octet-stream`). Range startup requires identity-encoded exact
`206`, `Content-Length`, `Content-Range`, `Accept-Ranges: bytes`, and one stable
strong `ETag`. Do not dynamically compress partial responses. A standalone
complete `200` may use browser-supported HTTP compression: the runtime ignores
encoded length metadata, bounds the decoded stream, and validates the complete
decoded asset. Compression is usually low-value because AVAL media payloads are
already compressed.

The element requires a secure context and callable
`window.crypto.subtle.digest` before it opens any source. HTTPS satisfies that
origin requirement. Browsers also treat HTTP loopback addresses such as
`localhost` and `127.0.0.1` as potentially trustworthy, but a private-network
URL such as `http://192.168.x.x` does not become trustworthy merely because it
is local. Opening that URL from a phone therefore fails once as
`unsupported-browser` during `configure`, before codec qualification. Use an
HTTPS tunnel or a locally trusted HTTPS certificate for physical-device
testing; adding or preferring an H.264 source cannot repair an insecure origin.

`crossorigin="anonymous"` uses Fetch `credentials: same-origin`: cross-origin
cookies are not sent. `use-credentials` uses `credentials: include` and
requires an explicit credentialed CORS response. Never use wildcard origin
with credentials. Opaque/no-CORS responses are rejected.

Permit the asset origin in `connect-src` and the packaged module worker in
`worker-src`. The implementation creates no blob worker, dynamic code, inline
script, or remote runtime import. It requires neither `unsafe-eval` nor a
`blob:` worker source. Presentation uses a constructed shadow stylesheet and
mutates only its bounded CSSOM rules; it creates no `<style>` element or style
attribute. A self-hosted baseline therefore needs no inline-script or
inline-style exception:

```text
default-src 'none'; script-src 'self'; style-src 'self';
connect-src 'self' https://assets.example; worker-src 'self';
img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
```

Replace the asset origin and tighten unrelated directives for the host
application. Serve application scripts and any consumer-owned alternate images as files
allowed by those directives; an inline `<script>`, inline `<style>`, style
attribute, `data:` resource, or blob worker is not needed. No remote origin is
needed when modules and assets are same-origin.

An external `integrity="sha256-..."` token intentionally changes version-0
startup to one bounded full fetch so the whole entity can be authenticated
before parsing. Internal blob digests remain mandatory with or without the
external token.
