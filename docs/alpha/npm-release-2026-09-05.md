# Alpha npm release — 2026-09-05

All four packages are published publicly on npm and available through both
`latest` and `next`. Fresh registry installs and production browser verification
passed. The exact tested archives and registry receipts are retained in
`artifacts/alpha/0.1.0/`.

| Package | Version | Purpose |
| --- | --- | --- |
| `@pixel-point/aval-alpha` | `0.1.0` | Canvas player, custom element and shared adapter |
| `@pixel-point/aval-alpha-react` | `0.1.0` | React hook and canvas component |
| `@pixel-point/aval-alpha-svelte` | `0.1.0` | Svelte controller and canvas component |
| `@pixel-point/aval-compiler` | `1.1.0` | `avl alpha` and `@pixel-point/aval-compiler/alpha` |

The three alpha runtimes retain independent `0.1.0` preview versions. Compiler
`1.1.0` adds the alpha API and command to the existing compiler package, with its
three interactive dependencies pinned to their already published `1.0.2`
versions. The other interactive packages are not republished.

## Install and compile

Install the package appropriate to your application:

```sh
npm install @pixel-point/aval-alpha
# React application:
npm install @pixel-point/aval-alpha-react
# Svelte application:
npm install @pixel-point/aval-alpha-svelte
```

The framework packages install the alpha core automatically. The application
supplies React or Svelte. For compilation:

```sh
npm install --save-dev @pixel-point/aval-compiler@^1.1.0
npx avl alpha motion.mov --out public/motion
```

FFmpeg and FFprobe are installed separately on the compiler machine. The default
encoders are SVT-AV1, libvpx-vp9, libx265 and libx264. Use the generated source
descriptors with the runtime or either framework adapter.

## Verification

Host tools: Node 25.8.1 and npm 11.11.0. Framework browser execution used React
19.2.7 and Svelte 5.56.8; an additional isolated registry install passed React
18.3.1 server rendering. The existing device matrix remains separate from these
local Playwright runs.

- Fresh workspace builds, alpha/compiler typechecking, and architecture checks.
- Alpha unit suite: 57 passed; its six opt-in media tests were run separately.
- Compiler alpha media suite: all 31 passed, including actual FFmpeg encoding.
- Package consumer and bundle size gates passed.
- Local browser suites: all 12 cases passed across Chromium, Firefox and WebKit.
- Exact release tarballs packed twice with matching bytes, checked against the
  payload allowlist, installed outside the workspace, and verified against their
  SHA-512 integrity values.
- Installed package imports and TypeScript consumers passed under NodeNext and
  bundler resolution, including the Svelte export condition.
- The installed compiler executable generated AV1, VP9, HEVC and H.264 media.
  Those outputs fed production builds importing only the installed packages.
- Production core playback and framework SSR/hydration: all 12 cases passed.
  Coverage includes alpha/color pixels, fallback, pause/play/seek, source changes,
  unmount cleanup, and operation without WebCodecs/video frame callbacks.
- Repeated the full consumer flow using fresh public npm downloads and an empty
  npm cache: all version/integrity, import, TypeScript, compiler, production
  build, and 12 browser checks passed with no failures or retries. A separate
  core-only registry install verified there are no runtime or framework
  dependencies.

The first packed Firefox run could not save one report because the host disk was
full. That case passed after deleting this verification's temporary npm cache.
The production fixture server also needed explicit routes for the copied SSR
pages. Neither issue required a runtime change.

The broader compiler suite passed 292 tests, skipped nine opt-in tests, and had
one existing failure: the host FFmpeg lacks `libaom-av1`, required by the
interactive multi-codec bundle test. The alpha compiler's default SVT-AV1 path
and its other requested encoders passed. Optional libaom execution remains
unverified on this host.

## Release records

`package-index.json` records exact archive sizes, file lists and hashes.
`registry-before.json` preserves previous tags; `registry-published.json` records
verified publication; `registry-final.json` records final tags after registry
consumer verification. Local, packed and registry evidence is retained beside
the archives. The runtime dependency inventory is recorded as a CycloneDX SBOM.
New-package registry propagation took several minutes after successful publish
responses. npm assigned initial `latest` tags to the new runtime packages;
the existing compiler's `latest` tag moved from `1.0.2` to `1.1.0` after the
registry consumer checks passed.

The source checkout already had uncommitted alpha work and interactive package
manifests at `1.0.1`, behind npm's `1.0.2`. The compiler's `1.1.0` manifest and
`1.0.2` dependency pins are recorded in its immutable release archive; the
synchronized interactive workspace version was not bumped. This targeted
publication does not complete the future release-automation work listed in the
[release readiness audit](./release-readiness.md).
