# M3 Deterministic Graph Engine Implementation Plan

**Date:** 2026-07-11

**Design:** [M3 Deterministic Graph Engine Design](../specs/2026-07-11-m3-deterministic-graph-design.md)

## Outcome

Add a pure `@rendered-motion/graph` workspace package whose validated graph,
explicit inputs, and consecutive ticks produce deterministic presentations,
effects, and settlement descriptors for every version-0 route phase.

## Execution Order

1. Add the package boundary, strict TypeScript project, root reference, and
   explicit exports.
2. Define immutable graph definitions, snapshots, presentations, effects,
   results, and stable error codes.
3. Implement checked definition cloning and validation, including identifier,
   count, port geometry, direct/event ambiguity, start-policy, completion, and
   reversible-pair rules.
4. Implement lifecycle and static/preparing/intro/stable body cursors.
5. Implement portal, finish, cut, transitionless, locked, and reversible tick
   progression with explicit readiness.
6. Implement latest-wins input routing, inverse lookup, follow-ons, bounded
   inputs/operations, request groups, effects, settlements, and bounded trace.
7. Add compact golden fixtures for interaction, workflow, intro/finite, and
   static recovery traces.
8. Add validation boundary tests and seeded long-run fuzz invariants.
9. Run typecheck, all unit tests, production build, browser regressions,
   package audit, diff check, and a strict read-only M3 audit.
10. Record M3 evidence and commit only when the complete repository gate passes.

## Package Files

```text
packages/graph/
  package.json
  tsconfig.json
  tsconfig.test.json
  src/errors.ts
  src/model.ts
  src/validate.ts
  src/portal-search.ts
  src/request-ledger.ts
  src/engine.ts
  src/index.ts
  test/fixtures.ts
  test/validate.test.ts
  test/portal-search.test.ts
  test/engine-golden.test.ts
  test/engine-fuzz.test.ts
```

The production config uses only `lib: ["ES2023"]` and no ambient types, making
the DOM/media/timer exclusion compiler-enforced. The separate test config adds
Node/Vitest types; Vitest already discovers package tests.

## Commit Boundary

The design and this plan are committed before runtime code. M3 runtime code is
one later commit after all M0–M2 regressions and the M3 verification gate pass.
