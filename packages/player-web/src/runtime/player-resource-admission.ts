import type { RuntimeByteCategory, RuntimeByteLease } from "./model.js";
import { PageReclamationCoordinator } from "./page-reclamation.js";
import { PageResourceManager } from "./page-resource-manager.js";
import {
  PlayerResourceAccount,
  adoptPlayerResourceLease
} from "./player-resource-account.js";
import { RuntimePlaybackError, normalizeRuntimeFailure } from "./errors.js";

/** Generation-fixed asynchronous admission used by the production page path. */
export interface PlayerResourceAdmission {
  reserve(
    category: RuntimeByteCategory,
    bytes: number,
    options?: Readonly<{ readonly reclaimable?: boolean }>
  ): Promise<RuntimeByteLease>;
}

/** Internal composition factory; deliberately absent from the package root. */
export function createPlayerResourceAdmission(input: Readonly<{
  readonly account: PlayerResourceAccount;
  readonly manager: PageResourceManager;
  readonly reclamation: PageReclamationCoordinator;
  readonly generation: number;
  readonly signal: AbortSignal;
}>): Readonly<PlayerResourceAdmission> {
  if (!(input.account instanceof PlayerResourceAccount)) {
    throw new TypeError("resource admission requires a player account");
  }
  if (!(input.manager instanceof PageResourceManager)) {
    throw new TypeError("resource admission requires a page manager");
  }
  if (!(input.reclamation instanceof PageReclamationCoordinator)) {
    throw new TypeError("resource admission requires page reclamation");
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new RangeError("resource admission generation is invalid");
  }
  if (!(input.signal instanceof AbortSignal)) {
    throw new TypeError("resource admission signal is invalid");
  }
  const account = input.account;
  const manager = input.manager;
  const reclamation = input.reclamation;
  const generation = input.generation;
  const signal = input.signal;
  return Object.freeze({
    async reserve(
      category: RuntimeByteCategory,
      bytes: number,
      options: Readonly<{ readonly reclaimable?: boolean }> = {}
    ): Promise<RuntimeByteLease> {
      if (options === null || typeof options !== "object" ||
        Object.keys(options).some((key) => key !== "reclaimable") ||
        (options.reclaimable !== undefined &&
          typeof options.reclaimable !== "boolean")) {
        throw new TypeError("resource admission options are invalid");
      }
      const reclaimable = options.reclaimable ?? true;
      assertGeneration(account, generation, signal);
      const pending = reclamation.reserveWithReclamation({
        participantId: account.participantId,
        generation,
        category,
        bytes,
        signal
      });
      let managerLease: RuntimeByteLease;
      try {
        managerLease = await raceAdmissionReservation(pending, signal, generation);
      } catch (error) {
        void pending.then((late) => {
          try { late.release(); } catch {}
        }, () => undefined);
        throw error;
      }
      let lease: RuntimeByteLease | null = null;
      try {
        assertGeneration(account, generation, signal);
        lease = adoptPlayerResourceLease(
          account,
          manager,
          managerLease,
          reclaimable
        );
        assertGeneration(account, generation, signal);
      } catch (error) {
        try { (lease ?? managerLease).release(); } catch {}
        throw error;
      }
      return lease;
    }
  });
}

function assertGeneration(
  account: PlayerResourceAccount,
  generation: number,
  signal: AbortSignal
): void {
  const participant = account.snapshot().participant;
  if (participant === null) {
    throw new RuntimePlaybackError(normalizeRuntimeFailure("disposed"));
  }
  if (signal.aborted || participant.generation !== generation) {
    throw new RuntimePlaybackError(normalizeRuntimeFailure(
      "abort",
      undefined,
      { generation, operation: "stale-resource-admission" }
    ));
  }
}

async function raceAdmissionReservation(
  pending: Promise<RuntimeByteLease>,
  signal: AbortSignal,
  generation: number
): Promise<RuntimeByteLease> {
  if (signal.aborted) throw staleAdmissionError(generation);
  let linked = false;
  let remove = (): void => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const listener = (): void => { reject(staleAdmissionError(generation)); };
    remove = () => {
      if (!linked) return;
      linked = false;
      try { signal.removeEventListener("abort", listener); } catch {}
    };
    try {
      linked = true;
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
    } catch (error) {
      remove();
      reject(error);
    }
  });
  try {
    const lease = await Promise.race([pending, aborted]);
    if (signal.aborted) {
      try { lease.release(); } catch {}
      throw staleAdmissionError(generation);
    }
    return lease;
  } finally {
    remove();
  }
}

function staleAdmissionError(generation: number): RuntimePlaybackError {
  return new RuntimePlaybackError(normalizeRuntimeFailure(
    "abort",
    undefined,
    { generation, operation: "stale-resource-admission" }
  ));
}
