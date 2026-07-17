# Publication runbook

Publication uses the already certified tarballs. It never checks out source or
rebuilds packages.

1. Verify candidate and release manifests, report index, tarball SHA-256 and
   registry integrity, API reports, SBOMs, notices, and reviewer approvals.
   Before the first public publish, add the canonical public repository,
   homepage, and issue-tracker URLs to package metadata once those real URLs
   exist; never publish invented or placeholder links.
   Confirm `config/release/legal-review.json` is approved by a qualified human;
   tooling never approves licensing or patent questions automatically.
2. In the protected npm environment, read each exact `name@1.0.0` and `next`
   tag before mutation.
3. If the version exists, continue only when integrity is exactly identical.
4. Publish dependency order under `next`: graph, format, element, player-web,
   compiler.
5. Install exact registry versions into clean consumers and run browser smoke.
6. With a separate approval, promote all exact versions to `latest`.
7. Preserve the publication ledger and registry verification digest.

A partial publish must not reach `latest`. Never overwrite or unpublish an
immutable version.

Trusted npm OIDC publishing currently requires Node 22.14.0 or newer and npm
11.5.1 or newer. OIDC authenticates `npm publish` but not `npm dist-tag`.
Therefore the automated protected workflow stops after exact `next` publication
and registry consumers; the separate `latest` promotion command must run in a
protected operator session with short-lived authorization and a recorded
approval. Do not store a long-lived promotion token in the repository or
workflow.
