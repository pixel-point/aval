import { describe, expect, it } from "vitest";

import {
  pageResourcesSnapshot,
  createPageDecoderParticipant,
  type PageDecoderLease,
  type PageDecoderParticipant,
  type PageDecoderTicket
} from "../src/page-resources.js";

interface Slot {
  participant: PageDecoderParticipant;
  weight: number;
  visible: boolean;
  ticket: PageDecoderTicket | null;
  lease: PageDecoderLease | null;
  disposed: boolean;
}

interface ByteSlot {
  participant: PageDecoderParticipant;
  bytes: number;
  disposed: boolean;
}

describe("page decoder resources", () => {
  it("grants one weighted pair and preserves visible FIFO around parked tickets", () => {
    const first = slot(true);
    const second = slot(true);
    const parked = slot(false);
    const fourth = slot(true);
    request(first);
    request(second);
    request(parked);
    request(fourth);

    refresh([first, second, parked, fourth]);
    expect(first.lease).not.toBeNull();
    expect(first.lease?.weight).toBe(2);
    expect(second.lease).toBeNull();
    expect(parked.lease).toBeNull();
    expect(fourth.lease).toBeNull();
    expect(pageResourcesSnapshot()).toEqual({
      active: 2,
      queued: 2,
      parked: 1,
      participants: 4,
      physicalBytes: 0
    });

    setVisible(parked, true);
    release(first);
    refresh([second, parked, fourth]);
    expect(second.lease).not.toBeNull();
    expect(fourth.lease).toBeNull();
    expect(parked.lease).toBeNull();

    release(second);
    refresh([parked, fourth]);
    expect(fourth.lease).not.toBeNull();
    expect(parked.lease).toBeNull();

    release(fourth);
    refresh([parked]);
    expect(parked.lease).not.toBeNull();
    expect(pageResourcesSnapshot()).toEqual({
      active: 2,
      queued: 0,
      parked: 0,
      participants: 4,
      physicalBytes: 0
    });

    disposeAll([first, second, parked, fourth]);
    expect(pageResourcesSnapshot()).toEqual({
      active: 0,
      queued: 0,
      parked: 0,
      participants: 0,
      physicalBytes: 0
    });
  });

  it("never partially grants a pair or bypasses its FIFO position", () => {
    const single = slot(true, 1);
    const pair = slot(true, 2);
    const follower = slot(true, 1);
    request(single);
    request(pair);
    request(follower);
    refresh([single, pair, follower]);

    expect(single.lease?.weight).toBe(1);
    expect(pair.lease).toBeNull();
    expect(follower.lease).toBeNull();
    expect(pageResourcesSnapshot()).toMatchObject({ active: 1, queued: 2 });

    release(single);
    refresh([pair, follower]);
    expect(pair.lease?.weight).toBe(2);
    expect(follower.lease).toBeNull();
    expect(pageResourcesSnapshot()).toMatchObject({ active: 2, queued: 1 });

    release(pair);
    refresh([follower]);
    expect(follower.lease?.weight).toBe(1);
    expect(pageResourcesSnapshot()).toMatchObject({ active: 1, queued: 0 });
    disposeAll([single, pair, follower]);
  });

  it("is race-safe when a grant, cancellation, and disposal share a microtask turn", async () => {
    const first = slot(true);
    const waiting = slot(true);
    request(first);
    request(waiting);
    refresh([first, waiting]);

    const grant = waiting.ticket!.wait();
    release(first);
    waiting.ticket!.cancel();
    waiting.ticket = null;
    const releasedGrant = await grant;
    releasedGrant.release();
    dispose(waiting);

    expect(pageResourcesSnapshot()).toEqual({
      active: 0,
      queued: 0,
      parked: 0,
      participants: 1,
      physicalBytes: 0
    });
    dispose(first);
    expect(pageResourcesSnapshot()).toEqual({
      active: 0,
      queued: 0,
      parked: 0,
      participants: 0,
      physicalBytes: 0
    });
  });

  it("never returns a stale lease after a granted ticket is released", async () => {
    const participant = createPageDecoderParticipant(true);
    const ticket = participant.request(2);
    const lease = ticket.take();
    expect(lease).not.toBeNull();
    expect(ticket.weight).toBe(2);
    expect(lease?.weight).toBe(2);
    lease!.release();
    expect(ticket.state()).toBe("released");
    expect(ticket.take()).toBeNull();
    await expect(ticket.wait()).rejects.toMatchObject({ name: "AbortError" });
    participant.dispose();
  });

  it("rejects invalid weights without creating a ticket", () => {
    const participant = createPageDecoderParticipant();
    for (const weight of [
      0,
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      3
    ]) {
      expect(() => participant.request(weight)).toThrowError(RangeError);
    }
    expect(pageResourcesSnapshot()).toMatchObject({
      active: 0,
      queued: 0,
      parked: 0,
      participants: 1
    });
    participant.dispose();
  });

  it("promotes a parked BFCache participant before the successor selects a decoder", () => {
    const participant = createPageDecoderParticipant(false);
    const ticket = participant.request(2);
    expect(ticket.state()).toBe("parked");
    participant.setVisible(true);
    expect(ticket.state()).toBe("granted");
    ticket.take()!.release();
    participant.dispose();
    expect(pageResourcesSnapshot()).toEqual({
      active: 0,
      queued: 0,
      parked: 0,
      participants: 0,
      physicalBytes: 0
    });
  });

  it("survives seeded release/regrant, visibility, reconnect, and cancellation stress", () => {
    const random = randomFor(0xc0de_51a7);
    const slots: Slot[] = Array.from(
      { length: 12 },
      () => slot((random() & 1) === 0, random() % 2 + 1)
    );

    for (let step = 0; step < 20_000; step += 1) {
      const index = random() % slots.length;
      let current = slots[index]!;
      const operation = random() % 7;
      if (
        operation === 0 && !current.disposed &&
        current.ticket === null && current.lease === null
      ) {
        request(current);
      } else if (operation === 1 && !current.disposed) {
        setVisible(current, !current.visible);
      } else if (operation === 2 && current.lease !== null) {
        release(current);
      } else if (operation === 3 && current.ticket !== null && current.lease === null) {
        current.ticket.cancel();
        current.ticket = null;
      } else if (operation === 4 && !current.disposed) {
        dispose(current);
      } else if (operation === 5 && current.disposed) {
        current = slot((random() & 1) === 0, random() % 2 + 1);
        slots[index] = current;
      } else if (
        operation === 6 && !current.disposed &&
        current.ticket === null && current.lease === null
      ) {
        request(current);
        if ((random() & 1) === 0 && current.lease !== null) release(current);
      }

      refresh(slots);
      const live = slots.filter(({ disposed }) => !disposed);
      const active = live.reduce(
        (sum, { lease }) => sum + (lease?.weight ?? 0),
        0
      );
      const queued = live.filter(({ ticket, lease, visible }) =>
        ticket !== null && lease === null && visible
      ).length;
      const parkedCount = live.filter(({ ticket, lease, visible }) =>
        ticket !== null && lease === null && !visible
      ).length;
      expect(pageResourcesSnapshot()).toEqual({
        active,
        queued,
        parked: parkedCount,
        participants: live.length,
        physicalBytes: 0
      });
      expect(active).toBeLessThanOrEqual(2);
    }

    disposeAll(slots);
    expect(pageResourcesSnapshot()).toEqual({
      active: 0,
      queued: 0,
      parked: 0,
      participants: 0,
      physicalBytes: 0
    });
  });

  it("reports exact ticket states and aggregate physical bytes", () => {
    const first = slot(true, 1);
    const second = slot(false, 2);
    const third = slot(true, 1);
    const fourth = slot(true, 2);
    request(first);
    request(second);
    request(third);
    request(fourth);

    expect(first.ticket!.state()).toBe("granted");
    expect(second.ticket!.state()).toBe("parked");
    expect(third.ticket!.state()).toBe("granted");
    expect(fourth.ticket!.state()).toBe("queued");
    expect(pageResourcesSnapshot()).toMatchObject({
      active: 2,
      queued: 1,
      parked: 1
    });
    first.participant.setPhysicalBytes(1_024);
    second.participant.setPhysicalBytes(2_048);
    third.participant.setPhysicalBytes(4_096);
    expect(pageResourcesSnapshot()).toMatchObject({
      physicalBytes: 7_168,
      participants: 4
    });

    const firstTicket = first.ticket!;
    release(first);
    expect(firstTicket.state()).toBe("released");
    refresh([fourth]);
    expect(fourth.ticket!.state()).toBe("queued");
    release(third);
    refresh([fourth]);
    expect(fourth.ticket!.state()).toBe("granted");
    dispose(second);
    expect(pageResourcesSnapshot().physicalBytes).toBe(5_120);
    expect(() => third.participant.setPhysicalBytes(-1)).toThrow(RangeError);

    disposeAll([first, third, fourth]);
    expect(pageResourcesSnapshot()).toEqual({
      active: 0,
      queued: 0,
      parked: 0,
      participants: 0,
      physicalBytes: 0
    });
  });

  it("admits the exact safe-integer page boundary and rolls back failed updates", () => {
    const first = createPageDecoderParticipant();
    const second = createPageDecoderParticipant();
    first.setPhysicalBytes(Number.MAX_SAFE_INTEGER - 1);
    second.setPhysicalBytes(1);
    const atLimit = pageResourcesSnapshot();
    expect(atLimit.physicalBytes).toBe(Number.MAX_SAFE_INTEGER);

    expect(() => second.setPhysicalBytes(2)).toThrowError(RangeError);
    expect(pageResourcesSnapshot()).toEqual(atLimit);
    for (const invalid of [
      -1,
      0.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1
    ]) {
      expect(() => first.setPhysicalBytes(invalid)).toThrowError(RangeError);
      expect(pageResourcesSnapshot()).toEqual(atLimit);
    }

    first.setPhysicalBytes(0);
    expect(pageResourcesSnapshot().physicalBytes).toBe(1);
    second.setPhysicalBytes(Number.MAX_SAFE_INTEGER);
    expect(pageResourcesSnapshot().physicalBytes).toBe(
      Number.MAX_SAFE_INTEGER
    );
    first.dispose();
    second.dispose();
    expect(pageResourcesSnapshot()).toEqual({
      active: 0,
      queued: 0,
      parked: 0,
      participants: 0,
      physicalBytes: 0
    });
  });

  it("retires bytes and decoder leases exactly once across disposal and late release", async () => {
    const first = createPageDecoderParticipant();
    const second = createPageDecoderParticipant();
    const successor = createPageDecoderParticipant();
    first.setPhysicalBytes(11);
    second.setPhysicalBytes(13);
    successor.setPhysicalBytes(17);
    const firstTicket = first.request(1);
    const secondTicket = second.request(1);
    const successorTicket = successor.request(2);
    const firstLease = firstTicket.take()!;
    const secondLease = secondTicket.take()!;
    const successorGrant = successorTicket.wait();
    expect(successorTicket.state()).toBe("queued");

    first.dispose();
    expect(firstTicket.state()).toBe("released");
    expect(successorTicket.state()).toBe("queued");
    expect(pageResourcesSnapshot()).toEqual({
      active: 1,
      queued: 1,
      parked: 0,
      participants: 2,
      physicalBytes: 30
    });

    firstLease.release();
    first.dispose();
    expect(pageResourcesSnapshot().active).toBe(1);
    expect(pageResourcesSnapshot().physicalBytes).toBe(30);
    secondLease.release();
    const successorLease = await successorGrant;
    expect(successorTicket.state()).toBe("granted");
    expect(successorLease.weight).toBe(2);
    second.dispose();
    expect(pageResourcesSnapshot()).toEqual({
      active: 2,
      queued: 0,
      parked: 0,
      participants: 1,
      physicalBytes: 17
    });
    successor.dispose();
    successorLease.release();
    expect(pageResourcesSnapshot()).toEqual({
      active: 0,
      queued: 0,
      parked: 0,
      participants: 0,
      physicalBytes: 0
    });
  });

  it("matches a seeded aggregate oracle through updates, overflow, and disposal", () => {
    const random = randomFor(0x51a7_b17e);
    const slots: ByteSlot[] = Array.from({ length: 8 }, () => byteSlot());

    for (let step = 0; step < 5_000; step += 1) {
      const index = random() % slots.length;
      let current = slots[index]!;
      if (current.disposed) {
        current = byteSlot();
        slots[index] = current;
      }
      if (random() % 5 === 0) {
        current.participant.dispose();
        current.bytes = 0;
        current.disposed = true;
      } else {
        const choice = random() % 4;
        const next = choice === 0
          ? 0
          : choice === 1
            ? random() % 1_000_000
            : Number.MAX_SAFE_INTEGER - (random() % 1_000_000);
        const otherBytes = slots.reduce(
          (sum, slot) => sum + (slot === current || slot.disposed ? 0 : slot.bytes),
          0
        );
        const before = pageResourcesSnapshot();
        if (next <= Number.MAX_SAFE_INTEGER - otherBytes) {
          current.participant.setPhysicalBytes(next);
          current.bytes = next;
        } else {
          expect(() => current.participant.setPhysicalBytes(next)).toThrowError(
            RangeError
          );
          expect(pageResourcesSnapshot()).toEqual(before);
        }
      }

      const live = slots.filter(({ disposed }) => !disposed);
      expect(pageResourcesSnapshot()).toMatchObject({
        participants: live.length,
        physicalBytes: live.reduce((sum, slot) => sum + slot.bytes, 0)
      });
    }

    for (const current of slots) current.participant.dispose();
    expect(pageResourcesSnapshot()).toEqual({
      active: 0,
      queued: 0,
      parked: 0,
      participants: 0,
      physicalBytes: 0
    });
  });
});

function slot(visible: boolean, weight = 2): Slot {
  return {
    participant: createPageDecoderParticipant(visible),
    weight,
    visible,
    ticket: null,
    lease: null,
    disposed: false
  };
}

function byteSlot(): ByteSlot {
  return {
    participant: createPageDecoderParticipant(),
    bytes: 0,
    disposed: false
  };
}

function request(value: Slot): void {
  value.ticket = value.participant.request(value.weight);
  value.lease = value.ticket.take();
}

function refresh(values: readonly Slot[]): void {
  for (const value of values) {
    if (value.ticket !== null && value.lease === null) {
      value.lease = value.ticket.take();
    }
  }
}

function setVisible(value: Slot, visible: boolean): void {
  value.visible = visible;
  value.participant.setVisible(visible);
}

function release(value: Slot): void {
  value.lease?.release();
  value.lease = null;
  value.ticket = null;
}

function dispose(value: Slot): void {
  value.participant.dispose();
  value.ticket = null;
  value.lease = null;
  value.disposed = true;
}

function disposeAll(values: readonly Slot[]): void {
  for (const value of values) dispose(value);
}

function randomFor(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}
