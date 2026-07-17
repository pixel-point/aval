import { describe, expect, it } from "vitest";

import {
  contextRecoveryCount,
  outstandingDecoder,
  resolutionScale,
  runtimeSuspension,
  runtimeVisibility,
  resumeCurrent,
  transitioningState,
  createCleanupReceipt,
  createOwnershipSnapshot,
  proveRetirement
} from "../src/aval-element.js";
import type { PlayerSnapshot } from "../src/player-contract.js";

describe("diagnostics", () => {
  it("preserves page totals belonging to other players in a successful cleanup", () => {
    const receipt = createCleanupReceipt(
      2,
      7,
      runtime(),
      {
        active: 1,
        queued: 1,
        parked: 1,
        participants: 3,
        physicalBytes: 12_345
      },
      98_765,
      false,
      true,
      0,
      null,
      false
    );

    expect(receipt).toMatchObject({
      completed: true,
      failureCount: 0,
      playerDisposed: true,
      participantDisposed: true,
      participantRegistered: false,
      participantLogicalBytes: 0,
      participantActiveLeaseCount: 0,
      participantDecoderTicketCount: 0,
      pagePhysicalBytes: 12_345,
      pageParticipantCount: 3,
      pageActiveDecoderLeaseCount: 1,
      pageQueuedDecoderTicketCount: 1,
      pageParkedDecoderTicketCount: 1,
      retiredDeclaredFileBytes: 98_765
    });
  });

  it("fails closed and reports real remaining player and participant work", () => {
    const receipt = createCleanupReceipt(
      1,
      3,
      runtime({
        workerCount: 1,
        openFrames: 2,
        pendingOperations: 1,
        sourceCopiesInFlight: 2,
        activeTransportBodies: 1,
        pendingLoads: 2,
        interestedWaiters: 3
      }),
      {
        active: 1,
        queued: 0,
        parked: 1,
        participants: 2,
        physicalBytes: 4_096
      },
      8_192,
      true,
      false,
      512,
      "parked",
      true
    );

    expect(receipt).toMatchObject({
      completed: false,
      playerDisposed: false,
      participantDisposed: false,
      participantRegistered: true,
      participantLogicalBytes: 512,
      participantDecoderTicketCount: 1,
      participantDecoderState: "parked",
      workerCount: 1,
      openFrames: 2,
      pendingRuntimeOperations: 1,
      sourceCopiesInFlight: 2,
      activeTransportBodies: 1,
      pendingLoads: 2,
      interestedWaiters: 3,
      pagePhysicalBytes: 4_096,
      pageParticipantCount: 2,
      terminal: true
    });
    expect(Number(receipt.failureCount)).toBeGreaterThan(0);
  });

  it("derives ownership completion from measured live counts", () => {
    expect(createOwnershipSnapshot(false, 4, 3, 1)).toEqual({
      listenerCount: 4,
      observerCount: 3,
      brokerSubscriptionCount: 0,
      timerCount: 0,
      pendingCommandCount: 1,
      failedReleaseCount: 0,
      retainedRetryCount: 0,
      releaseFailureCount: 0,
      completed: false
    });
    expect(createOwnershipSnapshot(true, 0, 0, 0)).toMatchObject({
      listenerCount: 0,
      observerCount: 0,
      pendingCommandCount: 0,
      completed: true
    });
    expect(createOwnershipSnapshot(true, 0, 0, 0, 1)).toMatchObject({
      timerCount: 1,
      completed: false
    });
  });

  it("does not fabricate cleanup success when the terminal snapshot is unavailable", () => {
    const receipt = createCleanupReceipt(
      1,
      1,
      null,
      { active: 0, queued: 0, parked: 0, participants: 0, physicalBytes: 0 },
      0,
      false,
      true,
      0,
      null,
      true
    );
    expect(receipt).toMatchObject({
      completed: false,
      playerDisposed: false,
      participantDisposed: true,
      pagePhysicalBytes: 0
    });
    expect(Number(receipt.failureCount)).toBeGreaterThan(0);
  });

  it("keeps a granted participant lease visible in fail-closed cleanup", () => {
    const receipt = createCleanupReceipt(
      1,
      2,
      runtime(),
      { active: 1, queued: 0, parked: 0, participants: 1, physicalBytes: 0 },
      0,
      false,
      false,
      0,
      "granted",
      true
    );
    expect(receipt).toMatchObject({
      completed: false,
      participantActiveLeaseCount: 1,
      participantDecoderTicketCount: 1,
      participantDecoderState: "granted"
    });
    expect(Number(receipt.failureCount)).toBeGreaterThan(1);
  });

  it("retains retirement authority until raw renderer copies settle", async () => {
    let sourceCopiesInFlight = 1;
    let authorityRetained = true;
    let successorStarted = false;
    const retire = async (): Promise<void> => {
      const receipt = createCleanupReceipt(
        1,
        1,
        runtime({ sourceCopiesInFlight }),
        { active: 0, queued: 0, parked: 0, participants: 0, physicalBytes: 0 },
        1_024,
        false,
        true,
        0,
        null,
        true
      );
      if (proveRetirement(true, receipt)) authorityRetained = false;
    };

    await expect(retire()).rejects.toMatchObject({ name: "OperationError" });
    expect(authorityRetained).toBe(true);
    await expect((async () => {
      await retire();
      successorStarted = true;
    })()).rejects.toMatchObject({ name: "OperationError" });
    expect(successorStarted).toBe(false);

    sourceCopiesInFlight = 0;
    await expect(retire()).resolves.toBeUndefined();
    expect(authorityRetained).toBe(false);
  });

  it("uses graph snapshots to stage transition state across edge boundaries", () => {
    expect(transitioningState(true, "transitionend", {
      isTransitioning: true
    })).toBe(true);
    expect(transitioningState(false, "requestedstatechange", {
      isTransitioning: true
    })).toBe(true);
    expect(transitioningState(true, "visualstatechange", {
      isTransitioning: false
    })).toBe(false);
    expect(transitioningState(false, "transitionstart", {})).toBe(true);
    expect(transitioningState(true, "transitionend", {})).toBe(false);
  });

  it("rejects a deferred resume after pause, visibility loss, or player replacement", () => {
    const first = {};
    const second = {};
    expect(resumeCurrent(3, 3, true, true, first, first, null, null)).toBe(true);
    expect(resumeCurrent(3, 4, false, true, first, first, null, null)).toBe(false);
    expect(resumeCurrent(3, 3, true, false, first, first, null, null)).toBe(false);
    expect(resumeCurrent(3, 3, true, true, first, second, null, null)).toBe(false);
    expect(resumeCurrent(3, 3, true, true, first, first, first, null)).toBe(false);
  });

  it("reports queued/granted decoder ownership without fabricating presentation state", () => {
    expect(outstandingDecoder(0, "parked")).toBe(1);
    expect(outstandingDecoder(0, "queued")).toBe(1);
    expect(outstandingDecoder(1, "granted")).toBe(1);
    expect(outstandingDecoder(0, null)).toBe(0);
    expect(resolutionScale(0, 0)).toBe(0);
    expect(resolutionScale(100, 50)).toBe(1);
    expect(runtimeVisibility(false, false)).toBeNull();
    expect(runtimeSuspension(false, false, false)).toBeNull();
    expect(runtimeVisibility(true, false)).toBe("hidden");
    expect(runtimeSuspension(true, false, false)).toBe("active");
  });

  it("includes live context recoveries exactly once", () => {
    expect(contextRecoveryCount(4, 3)).toBe(7);
    expect(contextRecoveryCount(7, 0)).toBe(7);
  });
});

function runtime(
  override: Readonly<{
    workerCount?: number;
    openFrames?: number;
    pendingOperations?: number;
    sourceCopiesInFlight?: number;
    activeTransportBodies?: number;
    pendingLoads?: number;
    interestedWaiters?: number;
  }> = {}
): Readonly<PlayerSnapshot> {
  return Object.freeze({
    requestedState: null,
    visualState: null,
    transitioning: false,
    selectedRendition: null,
    selectedCodec: null,
    selectedBitDepth: null,
    transportMode: null,
    declaredFileBytes: 0,
    metadataBytes: 0,
    verifiedBytes: 0,
    residentBlobBytes: 0,
    activeTransportBodies: override.activeTransportBodies ?? 0,
    pendingLoads: override.pendingLoads ?? 0,
    interestedWaiters: override.interestedWaiters ?? 0,
    workerCount: override.workerCount ?? 0,
    openFrames: override.openFrames ?? 0,
    contextLossCount: 0,
    contextRecoveryCount: 0,
    presentation: Object.freeze({
      cssWidth: 0,
      cssHeight: 0,
      backingWidth: 0,
      backingHeight: 0,
      effectiveDprX: 0,
      effectiveDprY: 0,
      stagingBytes: 0,
      residentBytes: 0,
      textureBytes: 0,
      runtimeBytes: 0,
      pendingOperations: override.pendingOperations ?? 0,
      sourceCopiesInFlight: override.sourceCopiesInFlight ?? 0
    }),
    trace: Object.freeze([])
  });
}
