# Startup Codec Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qualify authored AVAL sources through their first real decoded and rendered frame, then fall through AV1 → VP9 → HEVC → H.264 when a provisional codec path fails.

**Architecture:** Keep source-list ownership inside `createPlayer()` until one provisional `PlayerImpl` completes its existing production `prepare()` path and validated initial draw. Each attempt receives a discardable publication gate and its own bounded preparation deadline; failed attempts fully retire before the selector opens the next authored rendition, while the first successful attempt is returned already prepared and becomes the permanent runtime player when the element activates it. Asset, integrity, network, abort, cleanup, renderer, transport, and watchdog failures remain terminal, and no codec switch occurs after `interactiveReady`.

**Tech Stack:** TypeScript, WebCodecs, custom elements, Vitest, Playwright, Vite, BrowserStack real-device Safari.

---

## File map

- Modify `packages/element/src/player.ts`: stateful candidate cursor, provisional publication ownership, startup qualification facade, retry classification, bounded attempt deadlines, and retained per-source decoder evidence.
- Modify `packages/element/test/player-selection.test.ts`: retain existing config-probe and resource-admission selection coverage.
- Create `packages/element/test/player-startup-source-fallback.test.ts`: deterministic positive-probe/failed-first-frame source-ladder coverage.
- Modify `packages/element/src/aval-element.ts`: reject insecure/missing-WebCrypto hosts before asset loading.
- Modify `packages/element/test/element-inputs.test.ts`: capability-guard unit coverage.
- Modify `examples/support/aval-browser-diagnostics.js`: report SubtleCrypto digest availability.
- Modify `tests/support/browser-diagnostic-capture.ts`: type and validate the new environment field.
- Modify `tests/browser/multicodec-sources.spec.ts`: require successful fallback instead of accepting Safari terminal error.
- Modify `docs/element/attributes-and-api.md`: document startup-only authored source failover and post-readiness terminal behavior.
- Modify `docs/evidence/2026-07-18-browser-compatibility.md`: correct the earlier broad Safari statement and append the fresh iPhone evidence.

### Task 1: Lock the startup-failure contract with deterministic tests

**Files:**
- Create: `packages/element/test/player-startup-source-fallback.test.ts`
- Reference: `packages/element/test/player-prefetch.test.ts`
- Reference: `packages/element/test/player-selection.test.ts`

- [ ] **Step 1: Build a one-frame candidate harness**

Create source-driven `Asset`, decoder-pool, and renderer fakes. The authored fixture must use this exact source order and codec identity:

```ts
const sources = Object.freeze([
  source("av1.avl", "av01.0.01M.08.0.110.01.01.01.0", 0),
  source("vp9.avl", "vp09.00.21.08.01.01.01.01.00", 1),
  source("h265.avl", "hvc1.1.6.L63.90", 2),
  source("h264.avl", "avc1.64001E", 3)
]);
```

The harness must record `open`, decoder disposal, renderer disposal, frame close, asset disposal, readiness publication, draw publication, diagnostics publication, and public playback failure calls. `Asset.open()` must reject if a successor opens before the prior attempt's cleanup has completed.

- [ ] **Step 2: Write the failing AV1 → VP9 → HEVC test**

Script every config probe as supported. Make AV1 fail startup with `output-validation/invalid-output`, VP9 fail with an `EncodingError`, and HEVC deliver/draw frame 0. Assert:

```ts
expect(await player.prepare()).toMatchObject({
  mode: "animated",
  report: { readiness: "interactiveReady" }
});
expect(player.snapshot(false).selectedCodec).toBe("hvc1.1.6.L63.90");
expect(harness.openedCodecs).toEqual([
  "av01.0.01M.08.0.110.01.01.01.0",
  "vp09.00.21.08.01.01.01.01.00",
  "hvc1.1.6.L63.90"
]);
expect(harness.openedCodecs).not.toContain("avc1.64001E");
expect(harness.publicPlaybackFailures).toEqual([]);
expect(harness.readiness).toEqual([
  "metadataReady",
  "visualReady",
  "interactiveReady"
]);
```

Also assert both rejected attempts fully disposed their decoder, renderer, asset, and delivered frames before the successor opened.

- [ ] **Step 3: Write the failing H.264-last test**

Make AV1, VP9, and HEVC fail only during startup qualification, and make H.264 succeed. Assert all four codecs open in authored order, H.264 is selected, no provisional error/readiness/draw event escapes, and the readiness report contains three rejected candidates followed by one selected candidate.

- [ ] **Step 4: Write the failing exhaustion and terminal-boundary tests**

Cover these exact outcomes:

```ts
it("publishes one canonical error only after every startup codec rejects");
it("does not advance after an integrity, network, malformed-asset, or cleanup failure");
it("does not advance when the source generation aborts");
it("joins concurrent prepare calls into one qualification transaction");
it("never switches codecs after interactiveReady");
```

For exhaustion, assert the `prepare()` rejection is the exact `AvalPlaybackError` returned by the sole `onPlaybackFailure` call.

- [ ] **Step 5: Run the focused file and verify the new tests fail**

Run:

```bash
npm test -w @pixel-point/aval-element -- player-startup-source-fallback.test.ts
```

Expected: the startup tests fail because the current player commits the first positive config probe and terminalizes its first-frame failure.

### Task 2: Add provisional source ownership and startup qualification

**Files:**
- Modify: `packages/element/src/player.ts`
- Test: `packages/element/test/player-startup-source-fallback.test.ts`

- [ ] **Step 1: Add explicit selector state and candidate identity**

Add these internal types beside `CandidateReport`:

```ts
interface SelectionCursor {
  readonly sourceInputIndex: number;
  readonly renditionIndex: number;
}

interface SelectionState {
  cursor: SelectionCursor;
  reports: Readonly<CandidateReport>[];
  decoderDiagnostics: readonly Readonly<PlayerDecoderDiagnostic>[];
}

interface ProvisionalPlayer {
  readonly player: PlayerImpl;
  readonly publications: PublicationGate;
  readonly sourceIndex: number;
  readonly rendition: Readonly<Rendition>;
  readonly rank: number;
}
```

Refactor `selectPlayer()` to return one `ProvisionalPlayer`, update `SelectionState.cursor` before returning, and reopen the same asset at the next rendition after a positive-probe attempt retires. Config-negative and pure resource-admission rejections continue inside `selectPlayer()` without constructing the facade's next transaction.

- [ ] **Step 2: Make publication gates commit or discard**

Give `PublicationGate` three states: `pending`, `active`, and `discarded`. `activate()` flushes only the winning queue; `discard()` clears the queue and makes later callbacks no-ops. Accept a provisional `onPlaybackFailure` callback in the constructor so a failed attempt can produce an internal `AvalPlaybackError` without invoking the element's canonical failure publisher.

Keep `onDecoderDiagnostics` observable for rejected attempts, but retain diagnostics by `(sourceIndex, lane)` rather than lane alone, with a fixed bound of two lanes per authored source.

- [ ] **Step 3: Qualify provisional players inside `createPlayer()`**

Keep the total selection deadline and `SelectionState` in `createPlayer()`. After `selectPlayer()` returns a positive-probe live candidate, call that candidate's existing production `prepare()` while its publication gate is still provisional. The loop must have this shape:

```ts
for (;;) {
  const publications = new PublicationGate(input, provisionalPlaybackFailure);
  const current = await selectPlayer(
    publications.input,
    totalDeadline,
    publications,
    state
  );
  try {
    await current.player.prepare();
    totalDeadline.complete();
    return current.player;
  } catch (error) {
    const code = startupFailureCode(error, totalDeadline);
    current.publications.discard();
    retainAttemptDiagnostics(current.player.snapshot(false));
    await current.player.dispose();
    if (!retryableStartupFailure(error, current.player) ||
      totalDeadline.timedOut) {
      throw publishTerminalOnce(code, "prepare");
    }
    state.reports.push(candidateFailureReport(current, code));
  }
}
```

Do not call `PlayerImpl.activate()` during qualification. The gate buffers metadata, initial graph events, readiness, and first-draw publication. The element activates only the winning already-prepared player, which flushes that gate; rejected candidates' gates are discarded. The element's subsequent `player.prepare()` joins the winning player's cached preparation result. No wrapper remains after `createPlayer()` returns, so later runtime failures cannot re-enter source selection.

- [ ] **Step 4: Separate total and attempt deadlines**

Keep the existing five-second generation deadline as the total bound. Create a child `PreparationDeadline` for each positive-probe attempt, parented by the total signal and capped at 2,500 ms or the remaining total time, whichever is smaller. Any watchdog remains generation-terminal; the child exists so rejected-candidate cleanup cannot abort the total selector controller. Disposing a rejected child must never abort the total deadline.

- [ ] **Step 5: Classify retryable startup failures narrowly**

Return `true` only for a pre-commit `worker-decode-failure` with retained codec-qualification evidence: `invalid-output`, `unsupported-config`, or an `EncodingError`/`NotSupportedError` raised during configure, decode, flush, or output validation. Keep worker transport, renderer/context, `invalid-asset`, `load-failure`, `range-response-invalid`, `entity-changed`, `integrity-mismatch`, `resource-rejection`, abort, cleanup failure, and watchdog failures terminal. Preserve current boolean `supported:false` advancement and support-probe transport-exception behavior.

- [ ] **Step 6: Run the focused startup and selection tests**

Run:

```bash
npm test -w @pixel-point/aval-element -- player-startup-source-fallback.test.ts player-selection.test.ts
```

Expected: all focused tests pass, including existing pure-preflight ordering and new real-startup failover coverage.

### Task 3: Make insecure-origin failure explicit

**Files:**
- Modify: `packages/element/src/aval-element.ts`
- Modify: `packages/element/test/element-inputs.test.ts`
- Modify: `examples/support/aval-browser-diagnostics.js`
- Modify: `tests/support/browser-diagnostic-capture.ts`

- [ ] **Step 1: Write capability-guard tests**

Extend `runtimeHostSupported()` tests with views where `isSecureContext` is false, `crypto.subtle` is absent, `subtle.digest` is non-callable, and a capability getter throws. All return false. A secure view with callable `crypto.subtle.digest` returns true.

- [ ] **Step 2: Implement the nonthrowing secure-context guard**

Change `runtimeHostSupported()` to require styles, a live window, `view.isSecureContext === true`, and callable `view.crypto.subtle.digest`, using a `try/catch` so hostile or partial capability getters return false. This makes plain `http://192.168.x.x` fail once as `unsupported-browser/configure` before `Asset.open()` rather than crashing later as generic `readiness-failure/prepare`.

- [ ] **Step 3: Expose WebCrypto capability in browser diagnostics**

Add this environment field and its capture-schema assertion:

```js
webCryptoSubtleDigest: (() => {
  try {
    return typeof window.crypto?.subtle?.digest === "function";
  } catch {
    return false;
  }
})()
```

Keep `secureContext` as a separate field so evidence distinguishes origin trust from an incomplete browser implementation.

- [ ] **Step 4: Run capability and diagnostic tests**

Run:

```bash
npm test -w @pixel-point/aval-element -- element-inputs.test.ts
npm test -- browser-diagnostic
```

Expected: all capability guards and diagnostic schema checks pass.

### Task 4: Verify lifecycle and failure-boundary regressions

**Files:**
- Modify: `packages/element/test/element-lifecycle-regressions.test.ts` only if a missing facade-level assertion is exposed
- Verify: `packages/element/test/player-prefetch.test.ts`
- Verify: `packages/element/test/playback-error.test.ts`

- [ ] **Step 1: Run the complete element suite**

Run:

```bash
npm test -w @pixel-point/aval-element
npm run typecheck -w @pixel-point/aval-element
```

Expected: all element tests and TypeScript checks pass.

- [ ] **Step 2: Verify exact terminal identity and post-readiness behavior**

Confirm existing tests still prove active decoder failure after `interactiveReady` rejects with the same `AvalPlaybackError` published by the fatal event and does not open another source. If the facade hides this boundary, add one regression to `element-lifecycle-regressions.test.ts` that fails the committed player and asserts source-open count remains unchanged.

- [ ] **Step 3: Verify cleanup and static-policy behavior**

Run the cleanup and static-policy test groups and assert provisional rejection never emits `staticReady`, never invokes consumer fallback behavior, and leaves zero worker/frame/renderer/asset ownership before successor selection.

### Task 5: Tighten browser coverage and documentation

**Files:**
- Modify: `tests/browser/multicodec-sources.spec.ts`
- Modify: `docs/element/attributes-and-api.md`
- Modify: `docs/evidence/2026-07-18-browser-compatibility.md`

- [ ] **Step 1: Require successful multicodec fallback**

Replace WebKit's permitted terminal-error branch with assertions that a deterministic false-positive first source is rejected, the next supported source reaches `interactiveReady`, and the final diagnostics retain the rejected source's phase/code/codec evidence.

- [ ] **Step 2: Document the exact runtime contract**

Document that authored source order is preference order; positive configuration support remains provisional; AV1, VP9, HEVC, and H.264 are attempted in authored order until first-frame qualification; post-`interactiveReady` failures remain terminal; and the application owns all fallback UI/content.

- [ ] **Step 3: Correct and append branded-browser evidence**

Record the 2026-07-19 iPhone 16/iOS 18 Safari observations:

```text
Four-source current build: AV1 selected, output-validation/invalid-output, terminal error.
AV1 only: worker-decode-failure.
VP9 only: interactiveReady, vp09.00.21.08.01.01.01.01.00.
HEVC only: interactiveReady, hvc1.1.6.L63.90.
H.264 only: interactiveReady, avc1.64001E.
Plain LAN HTTP: insecure context; SubtleCrypto unavailable before codec qualification.
```

State explicitly that the earlier H.264 success belonged to a different single-codec demo and did not prove Rabbit's automatic failover.

### Task 6: Rebuild and certify the real Rabbit ladder

**Files:**
- Verify: `examples/grass-rabbit/index.html`
- Verify: `examples/grass-rabbit/public/grass-rabbit/*.avl`

- [ ] **Step 1: Run repository verification**

Run:

```bash
npm test
npm run typecheck
npm run build -w @pixel-point/aval-element
npm run build -w @pixel-point/aval-grass-rabbit-example
git diff --check
```

Expected: tests, types, builds, and whitespace validation pass. Preserve the user's `vite --host 0.0.0.0` package-script change without staging or rewriting it.

- [ ] **Step 2: Retest the HTTPS tunnel on BrowserStack iPhone Safari**

Reload the unmodified four-source Rabbit page on iPhone 16/iOS 18 Safari. Assert `secureContext=true`, `readiness=interactiveReady`, final `selectedCodec=vp09.00.21.08.01.01.01.01.00`, retained AV1 `output-validation/invalid-output` diagnostics, no fatal error event, visible Rabbit pixels, and a working authored interaction.

- [ ] **Step 3: Run the requested compatibility matrix**

Exercise the three latest available mobile Safari/iOS generations, current/current-1/current-2 Windows 11 Chrome, Android Chrome on a real Samsung-class device, and the browser build closest to the 24-month boundary. Record exact device, OS, browser build, selected codec, readiness, interaction, and decoder diagnostics; do not use moving aliases as durable evidence.

- [ ] **Step 4: Stop temporary infrastructure and report**

Stop the Cloudflare quick tunnel after the final branded-browser session. Report the verified matrix separately from emulator/Playwright evidence and call out that LAN HTTP remains intentionally unsupported because AVAL requires secure-context WebCrypto and WebCodecs.
