import type {
  BindingSource,
  Binding,
  RuntimeReadiness,
  RuntimeReadinessResult,
  StaticReason
} from "@pixel-point/aval-player-web";

import {
  ElementAssetGeneration,
  type ElementBrowserRuntimeFactory
} from "./asset-generation.js";
import { ElementCommandSlot } from "./element-command-slot.js";
import { reduceElementAutomationSignal } from "./element-automation-reduction.js";
import { ElementConfigurationApplication } from "./element-configuration-application.js";
import {
  normalizeState,
  type ElementConfiguration,
  type ElementConfigurationRead
} from "./element-configuration.js";
import {
  ElementDesiredState,
  type ElementDesiredSnapshot
} from "./element-desired-state.js";
import { ElementEventMutationGate } from "./element-event-mutation-gate.js";
import {
  type ElementAutomationSignal
} from "./element-host-automation.js";
import {
  type ElementSourceMetadata
} from "./element-generation-publication.js";
import { ElementOwnershipLedger } from "./element-ownership-ledger.js";
import { ElementPublicState } from "./element-public-state.js";
import { capturePreparedSource } from "./element-prepare-capture.js";
import { ElementPrepareReservations } from "./element-prepare-reservations.js";
import { ElementRuntimeEffectAuthorityView } from "./element-runtime-effect-authority.js";
import {
  ElementReconcilerDiagnosticsView
} from "./element-reconciler-diagnostics.js";
import { ElementReconcilerMetrics } from "./element-reconciler-metrics.js";
import {
  resumeCommandIdentityEqual,
  stateCommandIdentityEqual,
  type ElementResumeCommandKey,
  type ElementStateCommandKey
} from "./element-runtime-effects.js";
import {
  ElementSourceEffectState,
  applyElementSourceEffect,
  beginElementSourceInvalidation
} from "./element-source-effects.js";
import { ElementSourceObserver } from "./element-source-observer.js";
import { ElementSourceGenerationPublication } from "./element-source-generation-publication.js";
import {
  ElementReconcilerOwners,
  type ElementOwnerAuthority
} from "./element-reconciler-owners.js";
import {
  ElementCleanupFailureTracker,
} from "./element-reconciler-trackers.js";
import { ElementTrace } from "./element-trace.js";
import { stageElementReadiness } from "./element-readiness-stage.js";
import {
  ElementCleanupIncompleteError,
  createTerminalCleanupProof
} from "./element-terminal-cleanup.js";
import { aggregateElementTerminalCleanup } from "./element-terminal-aggregation.js";
import { AvalNotReadyError, avalAbortError } from "./errors.js";
import { assertInteractionTarget } from "./interaction-target.js";
import type {
  AvalDiagnostics,
  AvalMode,
  AvalRing,
  AvalTerminalCleanupProof
} from "./public-types.js";

const SOURCE_ATTRIBUTES: ReadonlySet<string> = new Set([
  "crossorigin"
]);

/** Sole effect and command authority behind the aval facade. */
export class ElementReconciler implements ElementOwnerAuthority {
  readonly #host: HTMLElement;
  readonly #desired = new ElementDesiredState();
  readonly #ownership = new ElementOwnershipLedger();
  readonly #publicState = new ElementPublicState();
  readonly #trace = new ElementTrace();
  readonly #metrics = new ElementReconcilerMetrics();
  readonly #stateCommand = new ElementCommandSlot<ElementStateCommandKey>(
    (left, right) => left.sourceToken === right.sourceToken && left.name === right.name,
    this.#ownership,
    stateCommandIdentityEqual
  );
  readonly #resumeCommand = new ElementCommandSlot<ElementResumeCommandKey>(
    resumeCommandIdentityEqual,
    this.#ownership
  );
  readonly #owners: ElementReconcilerOwners;
  readonly #runtimeAuthority: ElementRuntimeEffectAuthorityView;
  readonly #diagnostics: ElementReconcilerDiagnosticsView;
  readonly #eventMutations: ElementEventMutationGate;
  readonly #sourceObserver: ElementSourceObserver;
  readonly #configurationApplication = new ElementConfigurationApplication(this.#desired);
  readonly #source = new ElementSourceEffectState();
  readonly #publishedGeneration = new ElementSourceGenerationPublication();
  #pendingRealmRebind = false;
  #appliedMotionSubscription: string | null = null;
  readonly #cleanupFailures = new ElementCleanupFailureTracker();
  readonly #prepareReservations = new ElementPrepareReservations();
  #terminalCleanup: Readonly<AvalTerminalCleanupProof> | null = null;
  #terminalLayersDisposed = false;
  public constructor(
    host: HTMLElement,
    options: Readonly<{ factory?: ElementBrowserRuntimeFactory }> = {}
  ) {
    this.#host = host;
    this.#owners = new ElementReconcilerOwners({
      host,
      ownership: this.#ownership,
      state: this.#publicState,
      trace: this.#trace,
      stateCommand: this.#stateCommand,
      resumeCommand: this.#resumeCommand,
      authority: this,
      ...(options.factory === undefined ? {} : { factory: options.factory })
    });
    this.#runtimeAuthority = new ElementRuntimeEffectAuthorityView({
      desired: this.#desired,
      active: () => this.#owners.controller.active,
      failure: (error, fatal) => this.#reportFailure(error, fatal),
      presentationUnsupported: () => {
        this.#reportFailure("unsupported-browser", false);
        this.#invalidateSource();
      }
    });
    this.#diagnostics = new ElementReconcilerDiagnosticsView({
      desired: () => this.#desired.snapshot(),
      state: this.#publicState,
      ownership: this.#ownership,
      metrics: this.#metrics,
      dynamic: () => Object.freeze({
        connected: this.#owners.lifecycle.connected,
        finalDisposed: this.#owners.lifecycle.disposed,
        sourceGeneration: this.#publishedGeneration.value,
        cleanup: this.#owners.failures.cleanup,
        terminalCleanup: this.#terminalCleanup,
        runtime: this.#owners.controller.active?.runtime()?.snapshot() ?? null
      }),
      trace: this.#trace
    });
    this.#eventMutations = new ElementEventMutationGate(this.#owners.events);
    this.#sourceObserver = new ElementSourceObserver({
      host,
      changed: () => this.#sourceCandidatesChanged()
    });
  }
  public get connected(): boolean { return this.#owners.lifecycle.connected; }
  public get terminal(): boolean { return this.#owners.lifecycle.terminal; }
  public get readiness(): RuntimeReadiness { return this.#publicState.readiness; }
  public get mode(): AvalMode { return this.#publicState.mode; }
  public get assurance(): "best-effort" | null { return this.#publicState.assurance; }
  public get staticReason(): StaticReason | null { return this.#publicState.staticReason; }
  public get requestedState(): string | null { return this.#publicState.requestedState; }
  public get visualState(): string | null { return this.#publicState.visualState; }
  public get transitioning(): boolean { return this.#publicState.transitioning; }
  public get paused(): boolean { return !this.#desired.snapshot().manualPlaying; }
  public get effectivelyVisible(): boolean { return this.#desired.snapshot().effectivelyVisible; }
  public get stateNames(): readonly string[] { return this.#publicState.stateNames; }
  public get eventNames(): readonly string[] { return this.#publicState.eventNames; }
  public get inputBindings(): readonly Readonly<Binding>[] { return this.#publicState.inputBindings; }
  public get rings(): readonly Readonly<AvalRing>[] { return this.#publicState.rings; }
  public get interactionTarget(): Element | null { return this.#desired.snapshot().interactionTarget; }
  public ownerFailureContext() { return elementFailureContext(
    this.#owners.lifecycle.terminal,
    this.#owners.lifecycle.connected,
    this.#owners.controller.active !== null,
    this.#publishedGeneration.value
  ); }
  public ownerSourceRetired(): void {
    this.#metrics.add("cleanup");
    this.#owners.effects.clearApplied();
  }
  public ownerDisconnectFailure(error: unknown): void { this.#reportFailure(error, true); }
  public automationSignal(signal: ElementAutomationSignal): void {
    if (signal.type === "unsupported") {
      this.#reportFailure("unsupported-browser", false);
      return;
    }
    const before = this.#desired.snapshot();
    const reduction = reduceElementAutomationSignal(this.#desired, signal);
    const next = reduction.snapshot;
    if (reduction.resizeChanged) this.#metrics.next("resize");
    if (reduction.motionChanged) this.#metrics.next("motion");
    if (reduction.restored) this.#trace.record("bfcache-restore", this.#publishedGeneration.value);
    if (before.effectivelyVisible !== next.effectivelyVisible) this.#visibilityChanged(next);
    this.#submit(next);
  }
  public automaticInput(source: BindingSource): void {
    this.#trace.record(`input-${source.replace(".", "-")}`, this.#publishedGeneration.value);
    this.#owners.automation.router.route(source);
  }
  public connect(): void {
    if (this.#owners.lifecycle.terminal) return;
    this.#sourceObserver.connect();
    try { this.#owners.lifecycle.connect(); }
    catch (error) {
      this.#sourceObserver.disconnect();
      throw error;
    }
  }
  public disconnect(): void {
    this.#sourceObserver.disconnect();
    this.#owners.lifecycle.disconnect();
  }
  public configurationChanged(name: string | null): void {
    if (this.#eventMutations.defer(() => this.configurationChanged(name))) return;
    if (this.#owners.lifecycle.terminal) return;
    if (name !== null && SOURCE_ATTRIBUTES.has(name)) {
      const newlyInvalidated = this.#configurationApplication.markIdentityInvalidated();
      // Retire the old identity immediately, but let the coalesced
      // configuration read publish the only successor snapshot. Submitting
      // here would briefly recreate the stale source captured by the prior
      // configuration when several attributes change in one task.
      if (newlyInvalidated) this.#invalidateSource(false);
    }
    this.#owners.configuration.schedule();
  }
  public setInteractionTarget(value: Element | null): void {
    const target = assertInteractionTarget(this.#host, value);
    if (this.#eventMutations.defer(() => this.setInteractionTarget(target))) return;
    this.#metrics.next("input");
    this.#submit(this.#desired.setInteractionTarget(target));
  }
  public async prepare(
    options: Readonly<{ signal?: AbortSignal; timeoutMs?: number }> = {}
  ): Promise<RuntimeReadinessResult> {
    if (this.#owners.events.active) return this.#owners.events.after(() => this.prepare(options));
    if (this.#owners.lifecycle.terminal) throw avalAbortError();
    if (!this.#owners.lifecycle.connected) {
      throw new AvalNotReadyError("aval-player must be connected before prepare");
    }
    const releaseReservation = this.#prepareReservations.reserve();
    let ownership: ReturnType<ElementOwnershipLedger["acquire"]> | null = null;
    try {
      ownership = this.#ownership.acquire("command");
      this.#sourceObserver.flushRecords();
      this.#owners.configuration.flush();
      const invocationSourceToken = this.#desired.snapshot().sourceToken;
      const asset = await capturePreparedSource({
        invocationSourceToken,
        settled: this.#owners.lane.settled(),
        current: () => this.#desired.snapshot(),
        active: () => this.#owners.controller.active
      });
      return await asset.prepare(options);
    }
    finally {
      ownership?.complete();
      releaseReservation();
    }
  }

  public setState(name: string): Promise<void> {
    let checked: string | null;
    try { checked = normalizeState(name); }
    catch (error) { return Promise.reject(error); }
    if (checked === null) return Promise.reject(new TypeError("state must not be null"));
    if (this.#owners.events.active) {
      const current = this.#stateCommand.current();
      const settlement = current === null
        ? Promise.resolve()
        : this.#stateCommand.request(current.key).promise.catch(() => undefined);
      return this.#owners.events.after(async () => {
        await settlement;
        return this.setState(checked);
      });
    }
    const desired = this.#desired.snapshot();
    if (
      this.#owners.lifecycle.terminal || this.#owners.controller.active === null ||
      this.#publicState.stateNames.length === 0
    ) return Promise.reject(new AvalNotReadyError());
    const current = this.#stateCommand.current();
    if (
      current !== null &&
      current.key.sourceToken === desired.sourceToken &&
      current.key.name === checked
    ) return this.#stateCommand.request(current.key).promise;
    const previousIntent = desired.stateIntent;
    const next = this.#desired.requestState(checked);
    const intent = next.stateIntent!;
    const key = Object.freeze({
      sourceToken: next.sourceToken,
      name: checked,
      sequence: intent.sequence
    });
    const request = this.#stateCommand.request(key);
    if (!request.accepted) {
      this.#desired.restoreStateIntent(previousIntent);
      return request.promise;
    }
    this.#submit(next);
    return request.promise;
  }

  public send(event: string): boolean {
    try {
      const checked = normalizeState(event);
      const asset = this.#owners.controller.active;
      if (checked === null || asset === null) return false;
      if (this.#owners.events.active) {
        if (!asset.canSend(checked)) return false;
        this.#eventMutations.defer(() => {
          if (this.#owners.controller.active === asset && !this.#desired.snapshot().terminal) {
            asset.send(checked);
          }
        });
        return true;
      }
      return asset.send(checked);
    } catch { return false; }
  }
  public readyFor(state: string): boolean {
    try {
      const checked = normalizeState(state);
      return checked !== null && this.#owners.controller.active?.readyFor(checked) === true;
    } catch { return false; }
  }

  /** Dry-run route for a state request; null when there is no route today. */
  public planFor(state: string): readonly string[] | null {
    try {
      const checked = normalizeState(state);
      if (checked === null) return null;
      return this.#owners.controller.active?.planFor(checked) ?? null;
    } catch { return null; }
  }

  public pause(): void {
    if (this.#owners.lifecycle.terminal) return;
    if (this.#owners.events.active) {
      void this.#owners.events.after(() => this.pause());
      return;
    }
    this.#metrics.add("pause");
    this.#resumeCommand.abort();
    this.#submit(this.#desired.setManualPlaying(false));
  }

  public resume(): Promise<void> {
    if (this.#owners.events.active) return this.#owners.events.after(() => this.resume());
    if (this.#owners.lifecycle.terminal) return Promise.reject(avalAbortError());
    if (this.#owners.controller.active === null) {
      return Promise.reject(new AvalNotReadyError());
    }
    this.#metrics.add("resume");
    const previousPlaying = this.#desired.snapshot().manualPlaying;
    const next = this.#desired.setManualPlaying(true);
    const key = Object.freeze({
      sourceToken: next.sourceToken,
      playSequence: next.playSequence
    });
    const request = this.#resumeCommand.request(key);
    if (!request.accepted) {
      this.#desired.setManualPlaying(previousPlaying);
      return request.promise;
    }
    this.#submit(next);
    return request.promise;
  }

  public getDiagnostics(
    options: Readonly<{ trace?: boolean }> = {}
  ): Readonly<AvalDiagnostics> {
    return this.#diagnostics.get(options);
  }

  public dispose(): Promise<void> {
    const deferred = this.#eventMutations.deferPromise(() => this.dispose());
    if (deferred !== null) return deferred;
    if (!this.#owners.lifecycle.terminal) {
      this.#sourceObserver.disconnect();
      this.#owners.configuration.close();
      this.#stateCommand.abort();
      this.#resumeCommand.abort();
      this.#desired.setTerminal(true);
      this.#invalidateSource(false);
    }
    return this.#owners.lifecycle.dispose();
  }

  public async ownerReconcile(snapshot: Readonly<ElementDesiredSnapshot>): Promise<void> {
    if (snapshot.terminal) return;
    const configuration = snapshot.configuration;
    if (!snapshot.connected) {
      this.#stopAutomation();
      this.#owners.automation.inputs.setTarget(null);
    } else {
      if (this.#pendingRealmRebind) {
        this.#stopAutomation();
        this.#owners.automation.inputs.setTarget(null);
        this.#publicState.reset();
        this.#owners.effects.resetAsset();
        const supported = this.#owners.layers.rebindStyles(this.#host.ownerDocument);
        this.#pendingRealmRebind = false;
        if (!supported && (configuration?.sourceCandidates.length ?? 0) > 0) {
          this.#reportFailure("unsupported-browser", false);
        }
      }
      if (!this.#owners.automation.active) {
        this.#owners.automation.start();
        if (this.#desired.snapshot().revision !== snapshot.revision) return;
      }
      if (configuration !== null) {
        const subscriptionKey = `${snapshot.realmSequence}:${configuration.motion}`;
        if (subscriptionKey !== this.#appliedMotionSubscription) {
          const complete = this.#owners.automation.configureMotion(configuration.motion);
          this.#appliedMotionSubscription = subscriptionKey;
          this.#observeCleanup(complete);
          if (this.#desired.snapshot().revision !== snapshot.revision) return;
        }
        this.#applyInteraction(snapshot, configuration);
      }
    }

    try {
      const source = await applyElementSourceEffect({
        host: this.#host,
        layers: this.#owners.layers,
        controller: this.#owners.controller,
        desired: this.#desired,
        state: this.#source,
        snapshot
      });
      if (source.replacement) this.#metrics.add("sourceReplacement");
      this.#metrics.add("contextRecovery", source.retiredContextRecoveryCount);
      if (source.unsupported) this.#reportFailure("unsupported-browser", false);
    } catch (error) {
      if (this.#runtimeAuthority.runtimeSourceCurrent(snapshot.sourceToken)) {
        this.#reportFailure(error, true);
      }
    }
    if (!this.#runtimeAuthority.runtimeSourceCurrent(snapshot.sourceToken)) return;

    const asset = this.#owners.controller.active;
    if (asset === null || configuration === null || !snapshot.connected) return;
    await this.#owners.effects.apply(snapshot, asset, configuration, this.#runtimeAuthority);
  }

  public ownerCreateGeneration(generation: number): ElementAssetGeneration | null {
    const captured = this.#source.captured;
    if (
      captured === null || captured.desired.terminal || !captured.desired.connected ||
      captured.desired.sourceToken !== this.#desired.snapshot().sourceToken
    ) return null;
    this.#publicState.clearFailure();
    this.#resetAssetState();
    const asset = this.#publishedGeneration.construct(
      generation,
      () => this.#owners.generationFactory.create(generation, captured)
    );
    this.#owners.effects.clearApplied();
    return asset;
  }

  public automaticPrepareStarted(asset: ElementAssetGeneration): void {
    if (this.isAssetCurrent(asset)) this.#metrics.add("prepare");
  }
  public automaticPrepareReady(asset: ElementAssetGeneration): void {
    if (this.isAssetCurrent(asset)) this.#submit(this.#desired.snapshot());
  }

  public assetMetadata(
    asset: ElementAssetGeneration,
    metadata: ElementSourceMetadata
  ): void {
    this.#publicState.metadataReady(metadata);
    this.#owners.effects.metadataReady(metadata);
    this.#submit(this.#desired.snapshot());
    if (!this.isAssetCurrent(asset)) this.#resetAssetState();
  }

  public assetPrepared(asset: ElementAssetGeneration, result: Readonly<RuntimeReadinessResult>): void {
    if (!this.isAssetCurrent(asset)) return;
    this.#publicState.prepared(result);
    this.#submit(this.#desired.snapshot());
  }

  public assetReadiness(value: RuntimeReadiness, reason: StaticReason | null): void {
    stageElementReadiness(this.#publicState, this.#desired, value, reason);
  }
  public assetFallback(asset: ElementAssetGeneration, _reason: StaticReason): void {
    if (this.isAssetCurrent(asset)) this.#metrics.add("fallback");
  }
  public assetFailure(asset: ElementAssetGeneration, error: unknown, fatal: boolean): void {
    if (this.isAssetCurrent(asset)) this.#reportFailure(error, fatal);
  }
  public assetUnderflow(asset: ElementAssetGeneration, _count: number): void {
    if (this.isAssetCurrent(asset)) this.#metrics.add("underflow");
  }

  public isAssetCurrent(asset: ElementAssetGeneration): boolean {
    return this.#owners.controller.active === asset && !this.#desired.snapshot().terminal;
  }

  public configurationReady(read: Readonly<ElementConfigurationRead>): void {
    const inspection = this.#configurationApplication.inspect(read);
    if (inspection.requiresSourceInvalidation) this.#invalidateSource();
    const applied = this.#configurationApplication.commit(
      read,
      inspection,
      this.#owners.lifecycle.connected
    );
    const changes = applied.changes;
    for (let index = 0; index < applied.failurePublications; index += 1) {
      this.#reportFailure("invalid-configuration", false);
    }
    if (changes.autoplay) this.#resumeCommand.abort();
    if (changes.state) this.#stateCommand.abort();
    if (changes.bindings || changes.interactionTarget) {
      this.#metrics.next("input");
    }
    if (changes.motion) {
      this.#metrics.next("motion");
    }
    if (changes.size) {
      this.#metrics.next("resize");
    }
    this.#submit(applied.snapshot);
  }

  public configurationFailed(error: unknown): void {
    this.#reportFailure(error, false);
  }

  public ownerConnect(): void {
    this.#owners.configuration.schedule();
    this.#owners.configuration.flush();
    const change = this.#owners.automation.enterCurrentRealm();
    if (change.rootChanged || change.documentChanged) {
      this.#pendingRealmRebind = true;
      this.#invalidateSource();
    }
    let next = this.#desired.setConnected(true);
    if (change.rootChanged || change.documentChanged) {
      next = this.#desired.setInteractionTarget(null);
      this.#metrics.next("input");
      next = this.#desired.enterRealm();
    }
    this.#trace.record("connect", Math.max(1, this.#publishedGeneration.value));
    this.#submit(next);
  }

  public async ownerDisconnect(): Promise<void> {
    this.#trace.record("disconnect", Math.max(1, this.#publishedGeneration.value));
    this.#desired.setConnected(false);
    this.#invalidateSource();
    await this.#owners.lane.settled();
  }

  public async ownerDispose(): Promise<void> {
    this.#trace.record("dispose", Math.max(1, this.#publishedGeneration.value));
    const mechanicsCompleted = await aggregateElementTerminalCleanup([
      () => this.#owners.configuration.close(),
      () => {
        this.#sourceObserver.disconnect();
        return true;
      },
      () => this.#stopAutomation(),
      () => this.#owners.lane.dispose(),
      () => this.#owners.controller.dispose(),
      () => this.#owners.lane.settled(),
      () => this.#owners.automation.dispose(),
      () => this.#ownership.retryAll(),
      () => {
        if (this.#terminalLayersDisposed) return true;
        this.#terminalLayersDisposed = this.#owners.layers.dispose();
        return this.#terminalLayersDisposed;
      }
    ]);
    this.#terminalCleanup = createTerminalCleanupProof({
      sourceGeneration: this.#publishedGeneration.value,
      cleanup: this.#owners.failures.cleanup,
      ownership: this.#ownership.snapshot(),
      mechanicsCompleted
    });
    if (!this.#terminalCleanup.completed) {
      this.#observeCleanup(false);
      throw new ElementCleanupIncompleteError();
    }
    this.#configurationApplication.clear();
    this.#publicState.markDisposed();
  }

  #applyInteraction(
    snapshot: Readonly<ElementDesiredSnapshot>,
    configuration: Readonly<ElementConfiguration>
  ): void {
    const result = this.#owners.automation.interaction(snapshot, configuration);
    this.#observeCleanup(result.complete);
    if (result.reportMissing) this.#reportFailure("interaction-target-unavailable", false);
  }

  #sourceCandidatesChanged(): void {
    if (this.#eventMutations.defer(() => this.#sourceCandidatesChanged())) return;
    if (this.#owners.lifecycle.terminal || !this.#owners.lifecycle.connected) return;
    if (this.#configurationApplication.markIdentityInvalidated()) {
      this.#invalidateSource(false);
    }
    this.#owners.configuration.schedule();
  }

  #stopAutomation(): void {
    if (!this.#owners.automation.active) {
      this.#ownership.retryAll();
      return;
    }
    this.#cleanupFailures.begin();
    const complete = this.#owners.automation.stop();
    this.#observeCleanup(complete);
    this.#appliedMotionSubscription = null;
  }

  #observeCleanup(operationComplete: boolean): void {
    if (this.#cleanupFailures.shouldReport(
      operationComplete,
      this.#ownership.snapshot()
    )) this.#reportFailure("element-cleanup-incomplete", false);
  }

  #visibilityChanged(snapshot: Readonly<ElementDesiredSnapshot>): void {
    this.#metrics.next("visibility");
    this.#trace.record(
      snapshot.effectivelyVisible ? "visible" : "hidden",
      this.#publishedGeneration.value
    );
  }

  #invalidateSource(submit = true): void {
    const invalidation = beginElementSourceInvalidation({
      desired: this.#desired,
      controller: this.#owners.controller,
      state: this.#source
    });
    this.#stateCommand.abort();
    this.#resumeCommand.abort();
    this.#resetAssetState();
    if (invalidation.hadActive) this.#metrics.add("sourceReplacement");
    this.#metrics.add("contextRecovery", invalidation.retiredContextRecoveryCount);
    void invalidation.operation.catch((error: unknown) => {
      if (this.#desired.snapshot().sourceToken === invalidation.snapshot.sourceToken) {
        this.#reportFailure(error, true);
      }
    });
    if (submit) this.#submit(invalidation.snapshot);
  }

  #resetAssetState(resetReadiness = true): void {
    this.#publicState.reset(resetReadiness);
    this.#owners.effects.resetAsset();
  }

  #submit(snapshot: Readonly<ElementDesiredSnapshot>): void {
    void this.#owners.lane.submit(snapshot).catch((error: unknown) => {
      if (!this.#owners.lifecycle.terminal) this.#reportFailure(error, false);
    });
  }

  #reportFailure(error: unknown, fatal: boolean): void {
    try { this.#owners.failures.report(error, fatal); }
    catch { /* public observers cannot break the authority */ }
  }
}

function elementFailureContext(
  terminal: boolean,
  connected: boolean,
  activeSource: boolean,
  sourceGeneration: number
) {
  return Object.freeze({ terminal, connected, activeSource, sourceGeneration });
}
