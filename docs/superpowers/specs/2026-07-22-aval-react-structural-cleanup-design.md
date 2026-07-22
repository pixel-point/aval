# AVAL React Structural Cleanup Design

**Date:** 2026-07-22  
**Status:** Approved by the request to fix every thermo-nuclear review finding

## Objective

Keep the approved `useAval({ sources }) -> { aval, AvalComponent }` API and its
runtime behavior while removing the incidental state duplication, partial
updates, test-only production code, and release-package special cases exposed by
the maintainability review.

## Chosen architecture

### Canonical element public state

`ElementSnapshotStore` becomes the owner of every field published through
`AvalSnapshot`. `AvalElement` performs explicit atomic state transitions instead
of sampling its private fields through scattered `publishSnapshot()` calls.
Snapshot-visible getters delegate to the store where practical, and a transition
publishes at most one revision.

Lifecycle transitions update related fields together. Disconnect and disposal
therefore cannot expose a disconnected snapshot with stale effective visibility.
Readiness transitions only change readiness and dispatch readiness events; they
are no longer an implicit flush mechanism for unrelated generation or error
state. Diagnostics derive their last failure from the canonical retained error.

### Explicit React lifecycle records

`AvalBinding` owns one nullable attachment record rather than independent node,
element, subscription, mount, and target flags. The attachment record moves from
pending to mounted and owns its target and unsubscribe function. One close path
removes listeners, clears the target, cancels preparation, and resets status.

Ready preparation is represented by one identity-bearing operation record. A
completion is current only when that exact record is still installed, eliminating
sequence counters and multi-field stale checks. React status is selected from the
element's stable snapshot and cached once per snapshot identity.

### Single option-policy owner

The React adapter validates only its codec-keyed source object and React boolean
mappings. Element-authored values such as `state`, `motion`, `fit`, and
`crossOrigin` retain their exact public TypeScript types and are validated by the
element boundary. The React host no longer duplicates element enum sets.

React's required custom-element ARIA boolean conversion remains, but it is
isolated in a narrowly named helper instead of casting the entire host property
model through an untyped record.

### Dedicated browser-test support

The React example returns to being a small real consumer. The synthetic custom
element, lifecycle driver, and callback counters move under `packages/react/test`
and are typed against `AvalSnapshot`, event details, and the relevant
`AvalElement` surface. Browser tests communicate through one typed harness object
rather than multiple globals.

The element snapshot tests reuse an extracted fake-realm fixture instead of
introducing another copy of the DOM scaffolding. Documentation checks validate
public imports and documented behavior, not literal component implementation
spelling.

### Canonical release package contracts

Each entry in `RELEASE_PACKAGE_SPECS` describes its internal dependencies, peer
dependencies, export map, side effects, build configuration, and build-info file.
Release manifest validation and fresh builds consume that data generically.
Independent certification retains its fail-closed validation role but consumes a
reviewed contract representation rather than adding package-name conditionals.

One shared offline-package helper packs local peer dependency closures for
examples, consumers, and packed-development verification. It derives required
packages from installed manifests instead of naming React's current transitive
dependencies in each caller.

## Invariants

- The public React and element APIs do not change.
- Runtime/compiler formats and `.avl` sources do not change.
- Every semantic element transition exposes either the old or new complete
  snapshot, never a half-applied combination.
- One `AvalComponent` remains mountable once at a time and keeps stable identity.
- Strict Mode cleanup never disposes the element.
- Server rendering remains deterministic and DOM-global-free.
- Package validation remains exact and fail-closed.

## Verification

Focused tests cover atomic disconnect/disposal snapshots, one-revision state
transitions, attachment/preparation cleanup, stale ready suppression, canonical
option ownership, and typed browser lifecycle behavior. Full unit, browser,
build, API, documentation, packed-consumer, release-policy, and generated-file
checks must all pass before completion.
