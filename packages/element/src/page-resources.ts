export interface PageDecoderLease {
  readonly weight: number;
  release(): void;
}

export interface PageDecoderTicket {
  readonly weight: number;
  take(): PageDecoderLease | null;
  wait(): Promise<PageDecoderLease>;
  cancel(): void;
  state(): PageDecoderTicketState;
}

export interface PageDecoderParticipant {
  request(weight: number): PageDecoderTicket;
  setVisible(visible: boolean): void;
  setPhysicalBytes(bytes: number): void;
  dispose(): void;
}

export type PageDecoderTicketState =
  "queued" | "parked" | "granted" | "cancelled" | "released";

export interface PageResourcesSnapshot {
  /** Occupied physical decoder slots. */
  readonly active: number;
  /** Waiting ticket count. */
  readonly queued: number;
  /** Visibility-parked ticket count. */
  readonly parked: number;
  readonly participants: number;
  readonly physicalBytes: number;
}

type State = "queued" | "parked" | "active" | "cancelled" | "done";
type Participant = {
  readonly page: Page;
  visible: boolean;
  disposed: boolean;
  physicalBytes: number;
  ticket: Ticket | null;
};
type Ticket = {
  readonly participant: Participant;
  readonly weight: number;
  state: State;
  lease: PageDecoderLease | null;
  promise: Promise<PageDecoderLease> | null;
  resolve: ((lease: PageDecoderLease) => void) | null;
  reject: ((error: unknown) => void) | null;
};
type Page = {
  readonly participants: Set<Participant>;
  readonly queue: Ticket[];
  active: number;
  physicalBytes: number;
};

const MAXIMUM = 2;
const pages = new WeakMap<object, Page>();

export function createPageDecoderParticipant(
  visible = true,
  realm: object = globalThis
): PageDecoderParticipant {
  if (typeof visible !== "boolean") throw new TypeError("Invalid decoder visibility");
  const page = pageFor(realm);
  const participant: Participant = {
    page,
    visible,
    disposed: false,
    physicalBytes: 0,
    ticket: null
  };
  page.participants.add(participant);
  return Object.freeze({
    request: (weight: number): PageDecoderTicket => request(participant, weight),
    setVisible: (next: boolean): void => visibility(participant, next),
    setPhysicalBytes: (bytes: number): void => setPhysicalBytes(participant, bytes),
    dispose: (): void => disposeParticipant(participant)
  });
}

export function pageResourcesSnapshot(
  realm: object = globalThis
): Readonly<PageResourcesSnapshot> {
  const page = pageFor(realm);
  let queued = 0;
  let parked = 0;
  for (const participant of page.participants) {
    if (participant.ticket?.state === "queued") queued += 1;
    else if (participant.ticket?.state === "parked") parked += 1;
  }
  return Object.freeze({
    active: page.active,
    queued,
    parked,
    participants: page.participants.size,
    physicalBytes: page.physicalBytes
  });
}

function pageFor(realm: object): Page {
  let page = pages.get(realm);
  if (page === undefined) {
    page = { participants: new Set(), queue: [], active: 0, physicalBytes: 0 };
    pages.set(realm, page);
  }
  return page;
}

function request(participant: Participant, weight: number): PageDecoderTicket {
  if (!Number.isSafeInteger(weight) || weight < 1 || weight > MAXIMUM) {
    throw new RangeError("Invalid decoder request weight");
  }
  if (participant.disposed) throw abort();
  if (participant.ticket !== null) throw new RangeError("Decoder request already exists");
  const ticket: Ticket = {
    participant,
    weight,
    state: participant.visible ? "queued" : "parked",
    lease: null,
    promise: null,
    resolve: null,
    reject: null
  };
  participant.ticket = ticket;
  if (ticket.state === "queued") participant.page.queue.push(ticket);
  drain(participant.page);
  return Object.freeze({
    weight,
    take: (): PageDecoderLease | null =>
      ticket.state === "active" ? ticket.lease : null,
    wait: (): Promise<PageDecoderLease> => wait(ticket),
    cancel: (): void => cancel(ticket),
    state: (): PageDecoderTicketState => ticketState(ticket.state)
  });
}

function wait(ticket: Ticket): Promise<PageDecoderLease> {
  if (ticket.lease !== null) return Promise.resolve(ticket.lease);
  if (ticket.state === "cancelled" || ticket.state === "done") {
    return Promise.reject(abort());
  }
  if (ticket.promise === null) {
    ticket.promise = new Promise((resolve, reject) => {
      ticket.resolve = resolve;
      ticket.reject = reject;
    });
  }
  return ticket.promise;
}

function visibility(participant: Participant, visible: boolean): void {
  if (typeof visible !== "boolean") throw new TypeError("Invalid decoder visibility");
  if (participant.disposed) return;
  participant.visible = visible;
  const ticket = participant.ticket;
  if (ticket === null || ticket.state === "active") return;
  if (!visible && ticket.state === "queued") {
    remove(ticket);
    ticket.state = "parked";
  } else if (visible && ticket.state === "parked") {
    ticket.state = "queued";
    participant.page.queue.push(ticket);
  }
  drain(participant.page);
}

function setPhysicalBytes(participant: Participant, bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError("Invalid participant physical bytes");
  }
  if (participant.disposed) return;
  const next = replacePhysicalBytes(participant.page, participant.physicalBytes, bytes);
  participant.physicalBytes = bytes;
  participant.page.physicalBytes = next;
}

function drain(page: Page): void {
  while (page.queue.length > 0) {
    const ticket = page.queue[0]!;
    if (ticket.state !== "queued") {
      page.queue.shift();
      continue;
    }
    if (ticket.participant.disposed) {
      page.queue.shift();
      cancel(ticket);
      continue;
    }
    if (!ticket.participant.visible) {
      page.queue.shift();
      ticket.state = "parked";
      continue;
    }
    if (ticket.weight > MAXIMUM - page.active) return;
    page.queue.shift();
    ticket.state = "active";
    page.active += ticket.weight;
    let released = false;
    const lease = Object.freeze({
      weight: ticket.weight,
      release: (): void => {
        if (released) return;
        released = true;
        page.active -= ticket.weight;
        ticket.state = "done";
        ticket.lease = null;
        ticket.promise = null;
        if (ticket.participant.ticket === ticket) ticket.participant.ticket = null;
        drain(page);
      }
    });
    ticket.lease = lease;
    const resolve = ticket.resolve;
    ticket.resolve = null;
    ticket.reject = null;
    resolve?.(lease);
  }
}

function cancel(ticket: Ticket): void {
  if (ticket.state === "cancelled" || ticket.state === "done") return;
  if (ticket.state === "active") {
    ticket.lease!.release();
    return;
  }
  remove(ticket);
  ticket.state = "cancelled";
  if (ticket.participant.ticket === ticket) ticket.participant.ticket = null;
  const reject = ticket.reject;
  ticket.resolve = null;
  ticket.reject = null;
  ticket.promise = null;
  reject?.(abort());
  drain(ticket.participant.page);
}

function disposeParticipant(participant: Participant): void {
  if (participant.disposed) return;
  const page = participant.page;
  const nextPhysicalBytes = replacePhysicalBytes(page, participant.physicalBytes, 0);
  participant.disposed = true;
  participant.physicalBytes = 0;
  page.physicalBytes = nextPhysicalBytes;
  page.participants.delete(participant);
  if (participant.ticket !== null) cancel(participant.ticket);
}

function remove(ticket: Ticket): void {
  const queue = ticket.participant.page.queue;
  const index = queue.indexOf(ticket);
  if (index >= 0) queue.splice(index, 1);
}

function abort(): DOMException {
  return new DOMException("Decoder request cancelled", "AbortError");
}

function ticketState(state: State): PageDecoderTicketState {
  if (state === "active") return "granted";
  if (state === "done") return "released";
  return state;
}

function replacePhysicalBytes(page: Page, previous: number, next: number): number {
  const value = page.physicalBytes - previous + next;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Page bytes overflow");
  }
  return value;
}
