import { expect } from "vitest";

import {
  createM7FuzzRandom,
  m7FuzzInteger
} from "./m7-fuzz-random-test-support.js";
import {
  RUNTIME_BYTE_CATEGORIES,
  type RuntimeByteCategory,
  type RuntimeByteLease,
  type RuntimeDecoderLease,
  type RuntimeDecoderTicket,
  type RuntimePageResourceSnapshot
} from "./model.js";
import { PageDecoderLeases } from "./page-decoder-leases.js";
import { PageResourceManager } from "./page-resource-manager.js";
import { createRuntimePageResourcePolicy } from "./page-resource-policy.js";
import { PlayerResourceAccount } from "./player-resource-account.js";
import { RuntimeSessionLifecycle } from "./runtime-session-lifecycle.js";

export interface M7ResourceLifecycleFuzzSummary {
  readonly seed: number;
  readonly steps: number;
  readonly replacements: number;
  readonly budgetRejections: number;
  readonly injectedAllocationRollbacks: number;
  readonly pendingWaitAborts: number;
  readonly peakPageBytes: number;
  readonly peakDecoderLeases: number;
  readonly terminal: Readonly<{
    physicalBytes: number;
    byteLeaseCount: number;
    decoderLeaseCount: number;
    decoderQueueLength: number;
    pendingReclamations: number;
    participants: number;
  }>;
}

interface DecoderOwnerRecord {
  readonly ticket: RuntimeDecoderTicket;
  lease: RuntimeDecoderLease | null;
}

export async function runM7ResourceLifecycleFuzz(
  seed: number,
  steps: number
): Promise<Readonly<M7ResourceLifecycleFuzzSummary>> {
  const random = createM7FuzzRandom(seed ^ 0x51f0_0d5e);
  const manager = new PageResourceManager(createRuntimePageResourcePolicy({
    maximumDecoderLeases: 2,
    maximumPagePhysicalBytes: 4_096,
    maximumPlayerLogicalBytes: 2_048
  }));
  const lifecycle = new RuntimeSessionLifecycle();
  const accounts = Array.from({ length: 3 }, () => new PlayerResourceAccount(
    manager,
    {
      generation: lifecycle.current().generation,
      visibility: "visible",
      phase: "preparing"
    }
  ));
  const decoders = new PageDecoderLeases(manager);
  const leases: RuntimeByteLease[][] = accounts.map(() => []);
  const decoderOwners: Array<DecoderOwnerRecord | null> = accounts.map(() => null);
  let replacements = 0;
  let budgetRejections = 0;
  let injectedAllocationRollbacks = 0;
  let pendingWaitAborts = 0;
  let peakPageBytes = 0;
  let peakDecoderLeases = 0;

  for (let step = 0; step < steps; step += 1) {
    await synchronizeDecoderOwners(decoderOwners);
    pruneReleasedLeases(leases);
    const accountIndex = m7FuzzInteger(random, accounts.length);
    const account = accounts[accountIndex]!;
    const category: RuntimeByteCategory = RUNTIME_BYTE_CATEGORIES[m7FuzzInteger(
      random,
      RUNTIME_BYTE_CATEGORIES.length
    )]!;
    const action = m7FuzzInteger(random, 10);

    if (action === 0 || action === 1) {
      const bytes = m7FuzzInteger(random, 1_024) + 1;
      const before = resourceFacts(manager);
      try {
        const lease = account.reserve(category, bytes);
        leases[accountIndex]!.push(lease);
        lifecycle.current().registerCleanup("leases", () => lease.release());
      } catch (error) {
        expect(error).toMatchObject({ code: "resource-rejection" });
        expect(resourceFacts(manager)).toEqual(before);
        budgetRejections += 1;
      }
    } else if (action === 2) {
      const lease = randomLiveLease(leases[accountIndex]!, random);
      if (lease !== null) {
        const before = lease.snapshot();
        const beforeFacts = resourceFacts(manager);
        const nextBytes = m7FuzzInteger(random, 3_072);
        try {
          await lease.resize(nextBytes);
        } catch (error) {
          expect(error).toMatchObject({ code: "resource-rejection" });
          expect(lease.snapshot()).toEqual(before);
          expect(resourceFacts(manager)).toEqual(beforeFacts);
          budgetRejections += 1;
        }
      }
    } else if (action === 3) {
      randomLiveLease(leases[accountIndex]!, random)?.release();
    } else if (action === 4) {
      const participant = account.snapshot().participant;
      if (participant === null) throw new Error("live account lost participant");
      account.updateStatus({
        visibility: participant.visibility === "visible" ? "hidden" : "visible",
        phase: participant.visibility === "visible" ? "suspended" : "preparing"
      });
      decoders.reconcileParticipant(account.participantId);
    } else if (action === 5) {
      if (decoderOwners[accountIndex] === null) {
        const ticket = decoders.request(
          account.participantId,
          lifecycle.current().generation
        );
        const record: DecoderOwnerRecord = { ticket, lease: null };
        decoderOwners[accountIndex] = record;
        lifecycle.current().registerCleanup("candidate-gl", async () => {
          if (ticket.snapshot().state === "granted") {
            (await ticket.wait()).release();
          } else {
            ticket.cancel();
          }
        });
      }
    } else if (action === 6) {
      const owner = decoderOwners[accountIndex] ?? null;
      if (owner !== null) {
        if (owner.ticket.snapshot().state === "granted") {
          (owner.lease ?? await owner.ticket.wait()).release();
        } else {
          owner.ticket.cancel();
        }
        decoderOwners[accountIndex] = null;
      }
    } else if (action === 7) {
      const next = await lifecycle.replace();
      replacements += 1;
      for (const currentAccount of accounts) {
        currentAccount.updateStatus({
          generation: next.generation,
          visibility: "visible",
          phase: "preparing"
        });
        decoders.reconcileParticipant(currentAccount.participantId);
      }
      for (let index = 0; index < decoderOwners.length; index += 1) {
        decoderOwners[index] = null;
        leases[index]!.length = 0;
      }
    } else if (action === 8) {
      const wait = lifecycle.current().createPendingWait<number>();
      void wait.promise.catch((error: unknown) => {
        expect(error).toMatchObject({ name: "AbortError" });
        pendingWaitAborts += 1;
      });
      if (m7FuzzInteger(random, 2) === 0) wait.resolve(step);
    } else {
      const before = resourceFacts(manager);
      expect(() => account.reserveForAllocation(category, 1, () => {
        throw new Error("injected allocation failure");
      })).toThrow("injected allocation failure");
      expect(resourceFacts(manager)).toEqual(before);
      injectedAllocationRollbacks += 1;
    }

    await settleMicrotasks();
    const snapshot = manager.snapshot();
    assertResourceSnapshot(snapshot);
    const decoderSnapshot = decoders.snapshot();
    expect(snapshot.decoderLeaseCount).toBe(decoderSnapshot.activeLeaseCount);
    expect(snapshot.decoderQueueLength).toBe(
      decoderSnapshot.queuedTicketCount + decoderSnapshot.parkedTicketCount
    );
    peakPageBytes = Math.max(peakPageBytes, snapshot.physicalBytes);
    peakDecoderLeases = Math.max(
      peakDecoderLeases,
      snapshot.decoderLeaseCount
    );
  }

  await lifecycle.dispose();
  await settleMicrotasks();
  decoders.dispose();
  for (const account of accounts) account.dispose();
  const terminalSnapshot = manager.snapshot();
  assertResourceSnapshot(terminalSnapshot);
  const terminal = Object.freeze({
    physicalBytes: terminalSnapshot.physicalBytes,
    byteLeaseCount: terminalSnapshot.byteLeaseCount,
    decoderLeaseCount: terminalSnapshot.decoderLeaseCount,
    decoderQueueLength: terminalSnapshot.decoderQueueLength,
    pendingReclamations: terminalSnapshot.pendingReclamations,
    participants: terminalSnapshot.participants.length
  });
  manager.dispose();

  return Object.freeze({
    seed,
    steps,
    replacements,
    budgetRejections,
    injectedAllocationRollbacks,
    pendingWaitAborts,
    peakPageBytes,
    peakDecoderLeases,
    terminal
  });
}

async function synchronizeDecoderOwners(
  records: Array<DecoderOwnerRecord | null>
): Promise<void> {
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? null;
    if (record === null) continue;
    const state = record.ticket.snapshot().state;
    if (state === "cancelled") {
      records[index] = null;
    } else if (state === "granted" && record.lease === null) {
      record.lease = await record.ticket.wait();
    } else if (record.lease?.snapshot().released === true) {
      records[index] = null;
    }
  }
}

function pruneReleasedLeases(leases: RuntimeByteLease[][]): void {
  for (const owned of leases) {
    let write = 0;
    for (const lease of owned) {
      if (lease.snapshot().released) continue;
      owned[write] = lease;
      write += 1;
    }
    owned.length = write;
  }
}

function randomLiveLease(
  leases: readonly RuntimeByteLease[],
  random: () => number
): RuntimeByteLease | null {
  const live = leases.filter((lease) => !lease.snapshot().released);
  return live.length === 0 ? null : live[m7FuzzInteger(random, live.length)]!;
}

function resourceFacts(manager: PageResourceManager): Readonly<unknown> {
  const snapshot = manager.snapshot();
  return Object.freeze({
    physicalBytes: snapshot.physicalBytes,
    byteLeaseCount: snapshot.byteLeaseCount,
    categories: snapshot.categories.map(({ category, bytes }) => ({
      category,
      bytes
    })),
    participants: snapshot.participants.map(({ id, logicalBytes }) => ({
      id: Number(id),
      logicalBytes
    }))
  });
}

function assertResourceSnapshot(
  snapshot: Readonly<RuntimePageResourceSnapshot>
): void {
  const categoryBytes = snapshot.categories.reduce(
    (sum, category) => sum + category.bytes,
    0
  );
  const participantBytes = snapshot.participants.reduce(
    (sum, participant) => sum + participant.logicalBytes,
    0
  );
  expect(categoryBytes).toBe(snapshot.physicalBytes);
  expect(participantBytes).toBe(snapshot.physicalBytes);
  expect(snapshot.physicalBytes).toBeLessThanOrEqual(
    snapshot.policy.maximumPagePhysicalBytes
  );
  expect(snapshot.byteLeaseCount).toBeGreaterThanOrEqual(0);
  expect(snapshot.categories).toHaveLength(RUNTIME_BYTE_CATEGORIES.length);
  for (const participant of snapshot.participants) {
    expect(participant.logicalBytes).toBeLessThanOrEqual(
      snapshot.policy.maximumPlayerLogicalBytes
    );
  }
}

async function settleMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
