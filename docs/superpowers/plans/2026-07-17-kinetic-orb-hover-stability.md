# Kinetic Orb Rapid-Hover Stability Implementation Plan

**Goal:** Eliminate rapid hover enter/leave freezes and error fallbacks by
restoring decoder scheduling and ownership invariants, then prove continuous
forward progress with real pointer input.

**Architecture:** Keep the serial decoder, graph, and public interaction
contracts unchanged. Extract pure route planning and priority-aware prepared-run
admission from `PlayerImpl`; give the decoder host and worker an explicit shared
protocol plus independent lifecycle state machines; make the kinetic-orb
regression self-building and required in CI.

## Task 1: Shared decoder protocol and lifecycle

- Add an internal typed protocol module shared by host, worker, and tests.
- Validate exact commands/events and make worker error global rather than
  generation-scoped.
- Replace host collection-membership inference with idle/running/closing/
  terminal lane state.
- Replace worker protocol booleans with discriminated lifecycle state and a
  monotonic retirement floor.
- Test both flush/close race outcomes, stale terminal idempotency, delayed close
  across multiple later generations, and strict stale-nonterminal rejection.

## Task 2: Pure route planning

- Extract snapshot-to-plan logic with no resource side effects.
- Represent required pending and follow-on departures, current target bodies,
  detached-body resume, reversible residency, completion speculation, and loop
  speculation in an ordered plan.
- Add table-driven tests for pending, follow-on, and speculation suppression.

## Task 3: Priority-aware prepared-run scheduler

- Load wanted unit bytes concurrently but serialize decoder admission by the
  latest plan, waiting for a required load instead of admitting ready
  speculation.
- Store loading, admitted, ready, and scheduler-owned state in one entry.
- Make `claim()` synchronously transfer cancellable readiness/close ownership
  before awaiting the run.
- Split player orchestration into plan/reconcile, active retirement, and
  departure/hold evaluation.
- Preserve a detached handoff across same-boundary route replacement, and
  prioritize body reacquisition when the replacement departs later.
- Keep one integration regression for the real player/graph boundary and remove
  duplicated fake-runtime scaffolding.

## Task 4: Self-contained real-pointer regression

- Split artifact, ordinary interaction, and rapid-hover coverage.
- Exercise at least 40 rapid enter/leave edges near the reproduced 45 ms cadence.
- Verify every generated edge reaches the public send boundary and cannot all
  degrade into rejected no-ops.
- Assert settlement, readiness, failure/static state, transition status,
  underflow count, reuse, consecutive cursor/pixel progress, and clean
  console/page output.
- Build graph and element distributions inside the suite command, run headless
  in CI, and add a required Chromium CI job.
- Prove runtime trace and/or rendered pixels continue advancing after the final
  settled state.

## Task 5: Engagement-level convergence

- Track a rejected `engagement.on` or `engagement.off` as the desired current
  level without replaying pointer/focus edge bindings.
- Retry the pending level after `transitionend` in an owned microtask guarded by
  the current binding epoch.
- Clear or replace it on acceptance, level change, rebind, and teardown.
- Add a focused unit test for rejected leave during finite entry and retain the
  strict final-pointer-out browser assertion.

## Task 6: Integration verification

- Rebuild `@pixel-point/aval-element` so the demo consumes the changed ignored
  `dist` output.
- Run focused and full unit tests, typechecking, the kinetic-orb Playwright
  suite repeatedly, and `git diff --check`.
- Start a fresh kinetic-orb server and use the in-app browser to repeat rapid
  real-pointer churn, verifying both state settlement and continued frames.
- Review the final diff for resource leaks, stale-generation interference, and
  tests that can pass through unrouteable no-op events.
