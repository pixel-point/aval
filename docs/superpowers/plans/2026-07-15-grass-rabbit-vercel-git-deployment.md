# Grass Rabbit Vercel Git Deployment Implementation Plan

> **For agentic workers:** Execute each task in order and verify the Git-trigger and proxy contract before handoff.

**Goal:** Deploy the grass-rabbit demo from Git pushes while rebuilding it only when files under `examples/grass-rabbit` change, and keep it reachable at `pixelpoint.io/aval/`.

**Architecture:** Keep `aval-demo` as its own Vercel project rooted at `examples/grass-rabbit`. Its Vercel build first compiles the local workspace packages needed by the demo, then runs the existing Vite `/aval/` build. A repository-scoped ignored-build command skips commits with no changes inside the demo directory. The PixelPoint website continues to reverse-proxy `/aval` to the demo project's stable production alias.

**Tech Stack:** Vercel Git integration, npm workspaces, Vite, Vercel rewrites

---

### Task 1: Make the demo build reproducible on Vercel

**Files:**
- Modify: `examples/grass-rabbit/package.json`
- Modify: `examples/grass-rabbit/vercel.json`

- [x] Add a Vercel build script that builds required local workspace packages before Vite.
- [x] Declare the build command and output directory in version-controlled Vercel configuration.
- [x] Add an ignored-build command that proceeds only when `examples/grass-rabbit` changed.
- [x] Validate the JSON and run the exact production build locally.

### Task 2: Persist the public `/aval` proxy

**Files:**
- Preserve/verify: `/Users/alex/Projects/pixelpoint-website/vercel.json`
- Preserve/verify: `/Users/alex/Projects/pixelpoint-website/.gitignore`

- [x] Verify `/aval`, `/aval/`, and nested assets proxy to the `aval-demo` production alias.
- [x] Ensure the proxy and `.vercel` ignore rule remain as intentional website-repository changes.

### Task 3: Connect the existing Vercel project to GitHub

**Files:**
- Local-only: `examples/grass-rabbit/.vercel/project.json`

- [x] Link the local demo directory to the existing `pixelpoint/aval-demo` project.
- [x] Connect that Vercel project to `pixel-point/aval` on GitHub.
- [x] Confirm the project root is `examples/grass-rabbit` and the production branch is `main`.

### Task 4: Verify the complete deployment contract

- [x] Confirm the built HTML and assets use the `/aval/` base path.
- [x] Verify the production build includes the current Safari runtime fix.
- [x] Test the built demo in WebKit through the `/aval/` route.
- [x] Confirm unrelated commits are skipped by the ignored-build command and demo-directory commits proceed.
- [x] Report the exact files that need to be committed and pushed in each repository.
