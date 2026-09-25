# Safari 26 Svelte hotfix: 1.0.3

This targeted release carries the change merged in [PR #6](https://github.com/pixel-point/aval/pull/6) to the currently published interactive packages. The source checkout still describes the older 1.0.1 package shape, while npm 1.0.2 includes public `/lazy` entries. Rebuilding directly from this checkout would remove those entries. The release therefore starts from the immutable npm 1.0.2 archives and applies only the reviewed Safari changes.

## Release set

| Package | Baseline | Release | Other package changes |
| --- | --- | --- | --- |
| `@pixel-point/aval-element` | `1.0.2` | `1.0.3` | Upgrade a disconnected host once before rejecting a missing snapshot API. |
| `@pixel-point/aval-svelte` | `1.0.2` | `1.0.3` | Define the element during controller creation for both standard and `/lazy` imports; depend on element `1.0.3`. |

The element package retains its exact graph and format `1.0.2` dependencies. The other published packages keep their existing versions. This matches the earlier targeted compiler release approach and avoids changing unrelated published packages.

## Reproduce and inspect

```sh
node scripts/release/prepare-safari-hotfix.mjs
node scripts/release/verify-safari-hotfix.mjs
```

The preparation script verifies the baseline SHA-512 values against pinned registry archives, checks the precise changed-file allowlist, packs each release archive twice to confirm identical bytes, and requires the archive file lists to remain identical. It writes tarballs and `package-index.json` to ignored `artifacts/safari-hotfix/1.0.3/`. It refuses to overwrite that output.

The verification script installs the tarballs into a fresh consumer, checks Svelte declarations, builds a production Vite app, and exercises eager and lazy imports, template-created hosts, and disconnected hosts in Chromium and WebKit. `node scripts/release/verify-safari-hotfix.mjs --baseline` demonstrates that the published 1.0.2 packages fail the template-host case in WebKit with the reported snapshot API error.

The candidate archives have these SHA-256 digests:

| Archive | SHA-256 |
| --- | --- |
| `pixel-point-aval-element-1.0.3.tgz` | `5a896d3ad7a8dbc0f8e8a07d86fad8f14ada010cb84b802feb9f4a0a085ea98b` |
| `pixel-point-aval-svelte-1.0.3.tgz` | `337b49f9ad9516ed720ab0d3d0454bf0bba6ca6eaff8ea9db5c1632052ec312b` |

Publish element then Svelte under `next`. Verify both exact registry integrity values and install them into a fresh consumer before moving either `latest` tag. Registry tags should only change after both packages pass.
