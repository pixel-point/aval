import { describe, expect, it } from "vitest";

import type { RuntimeParticipantId } from "./model.js";
import { PageDecoderLeases } from "./page-decoder-leases.js";
import { PageResourceManager } from "./page-resource-manager.js";
import { createRuntimePageResourcePolicy } from "./page-resource-policy.js";

describe("page decoder leases", () => {
  it("grants two leases then advances five visible players in FIFO order", async () => {
    const { manager, decoders, participants } = setup(2, 5);
    const tickets = participants.map((participant) =>
      decoders.request(participant, 1)
    );

    expect(tickets.map((ticket) => ticket.snapshot().state)).toEqual([
      "granted",
      "granted",
      "queued",
      "queued",
      "queued"
    ]);
    expect(tickets.map((ticket) => ticket.snapshot().ordinal)).toEqual([
      1, 2, 3, 4, 5
    ]);
    expect(manager.snapshot()).toMatchObject({
      decoderLeaseCount: 2,
      decoderQueueLength: 3
    });

    const first = await tickets[0]!.wait();
    const second = await tickets[1]!.wait();
    first.release();
    const third = await tickets[2]!.wait();
    expect(tickets[2]!.snapshot().state).toBe("granted");
    second.release();
    const fourth = await tickets[3]!.wait();
    third.release();
    const fifth = await tickets[4]!.wait();
    fourth.release();
    fifth.release();

    expect(decoders.snapshot()).toMatchObject({
      activeLeaseCount: 0,
      queuedTicketCount: 0,
      parkedTicketCount: 0
    });
    expect(manager.snapshot()).toMatchObject({
      decoderLeaseCount: 0,
      decoderQueueLength: 0
    });
  });

  it("parks hidden requests and joins the visible FIFO only when reconciled", async () => {
    const { manager, decoders, participants } = setup(1, 3);
    manager.updateParticipant(participants[0]!, { visibility: "hidden" });
    const hidden = decoders.request(participants[0]!, 1);
    const active = decoders.request(participants[1]!, 1);
    const waiting = decoders.request(participants[2]!, 1);

    expect(hidden.snapshot().state).toBe("parked");
    expect(active.snapshot().state).toBe("granted");
    expect(waiting.snapshot().state).toBe("queued");
    const activeLease = await active.wait();

    manager.updateParticipant(participants[0]!, { visibility: "visible" });
    decoders.reconcileParticipant(participants[0]!);
    expect(hidden.snapshot()).toMatchObject({ state: "queued", ordinal: 4 });
    activeLease.release();
    const waitingLease = await waiting.wait();
    expect(waiting.snapshot().state).toBe("granted");
    waitingLease.release();
    const hiddenLease = await hidden.wait();
    hiddenLease.release();
  });

  it("parks a queued player on hide and never revokes an active lease", async () => {
    const { manager, decoders, participants } = setup(1, 3);
    const active = decoders.request(participants[0]!, 1);
    const parked = decoders.request(participants[1]!, 1);
    const next = decoders.request(participants[2]!, 1);
    const activeLease = await active.wait();

    manager.updateParticipant(participants[1]!, { visibility: "hidden" });
    decoders.reconcileParticipant(participants[1]!);
    manager.updateParticipant(participants[0]!, { visibility: "hidden" });
    decoders.reconcileParticipant(participants[0]!);
    expect(activeLease.snapshot().released).toBe(false);
    expect(parked.snapshot().state).toBe("parked");

    activeLease.release();
    const nextLease = await next.wait();
    expect(next.snapshot().state).toBe("granted");
    nextLease.release();
    parked.cancel();
  });

  it("cancels queued, replaced, and disposed participants without leaks", async () => {
    const { manager, decoders, participants } = setup(0, 3);
    const cancelled = decoders.request(participants[0]!, 1);
    const cancelledWait = cancelled.wait();
    cancelled.cancel();
    await expect(cancelledWait).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled.snapshot().state).toBe("cancelled");

    const replaced = decoders.request(participants[1]!, 1);
    const replacedWait = replaced.wait();
    manager.updateParticipant(participants[1]!, { generation: 2 });
    decoders.reconcileParticipant(participants[1]!);
    await expect(replacedWait).rejects.toMatchObject({ name: "AbortError" });

    const disposed = decoders.request(participants[2]!, 1);
    const disposedWait = disposed.wait();
    manager.disposeParticipant(participants[2]!);
    decoders.reconcileParticipant(participants[2]!);
    await expect(disposedWait).rejects.toMatchObject({ name: "AbortError" });
    expect(manager.snapshot()).toMatchObject({
      decoderLeaseCount: 0,
      decoderQueueLength: 0
    });
  });

  it("allows at most one live ticket or lease per player", async () => {
    const { decoders, participants } = setup(1, 1);
    const ticket = decoders.request(participants[0]!, 1);
    expect(() => decoders.request(participants[0]!, 1)).toThrow(RangeError);
    const lease = await ticket.wait();
    expect(() => decoders.request(participants[0]!, 1)).toThrow(RangeError);
    lease.release();
    const replacement = decoders.request(participants[0]!, 1);
    const replacementLease = await replacement.wait();
    replacementLease.release();
  });

  it("serializes simultaneous release and request behind the current FIFO", async () => {
    const { decoders, participants } = setup(1, 2);
    const first = decoders.request(participants[0]!, 1);
    const second = decoders.request(participants[1]!, 1);
    const firstLease = await first.wait();
    firstLease.release();
    const repeatedFirst = decoders.request(participants[0]!, 1);

    expect(second.snapshot().state).toBe("granted");
    expect(repeatedFirst.snapshot().state).toBe("queued");
    const secondLease = await second.wait();
    secondLease.release();
    const repeatedLease = await repeatedFirst.wait();
    repeatedLease.release();
  });

  it("freezes observations and reaches terminal zero on disposal", async () => {
    const { manager, decoders, participants } = setup(1, 3);
    const active = decoders.request(participants[0]!, 1);
    const queued = decoders.request(participants[1]!, 1);
    const parkedParticipant = participants[2]!;
    manager.updateParticipant(parkedParticipant, { visibility: "hidden" });
    const parked = decoders.request(parkedParticipant, 1);
    const queuedWait = queued.wait();
    const parkedWait = parked.wait();
    const activeLease = await active.wait();
    const snapshot = decoders.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tickets)).toBe(true);
    expect(snapshot.tickets.every(Object.isFrozen)).toBe(true);
    decoders.dispose();
    decoders.dispose();
    await expect(queuedWait).rejects.toMatchObject({ name: "AbortError" });
    await expect(parkedWait).rejects.toMatchObject({ name: "AbortError" });
    expect(activeLease.snapshot().released).toBe(true);
    expect(decoders.snapshot()).toMatchObject({
      activeLeaseCount: 0,
      queuedTicketCount: 0,
      parkedTicketCount: 0,
      disposed: true
    });
    expect(manager.snapshot()).toMatchObject({
      decoderLeaseCount: 0,
      decoderQueueLength: 0
    });
    expect(() => decoders.request(participants[0]!, 1)).toThrowError(
      expect.objectContaining({ code: "disposed" })
    );
  });
});

function setup(maximumDecoderLeases: number, count: number): {
  readonly manager: PageResourceManager;
  readonly decoders: PageDecoderLeases;
  readonly participants: readonly RuntimeParticipantId[];
} {
  const manager = new PageResourceManager(createRuntimePageResourcePolicy({
    maximumDecoderLeases,
    maximumPagePhysicalBytes: 1024,
    maximumPlayerLogicalBytes: 256
  }));
  const participants = Array.from({ length: count }, () =>
    manager.registerParticipant()
  );
  return {
    manager,
    decoders: new PageDecoderLeases(manager),
    participants
  };
}
