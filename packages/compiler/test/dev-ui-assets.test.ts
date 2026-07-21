import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import { DEV_CLIENT } from "../src/commands/dev-ui-assets.js";

describe("generated dev client refresh ownership", () => {
  it("keeps report fetch failures separate from playback and the consumer alternate", async () => {
    const harness = createHarness();
    harness.unavailable.hidden = true;

    harness.publish(build(1));
    harness.rejectReport(1, new Error("network unavailable"));
    await settle();

    expect(harness.motion.prepareCalls).toEqual([]);
    expect(harness.motion.children).toEqual([]);
    expect(harness.unavailable.hidden).toBe(true);
    expect(harness.status.textContent).toBe("Build 1 · build report unavailable");
  });

  it("keeps report validation failures separate from playback and the consumer alternate", async () => {
    const harness = createHarness();
    harness.unavailable.hidden = true;

    harness.publish(build(1));
    harness.resolveReport(1, { invalid: true });
    await settle();

    expect(harness.motion.prepareCalls).toEqual([]);
    expect(harness.motion.children).toEqual([]);
    expect(harness.unavailable.hidden).toBe(true);
    expect(harness.status.textContent).toBe("Build 1 · build report unavailable");
  });

  it("does not reveal the consumer alternate for caller-local preparation interruption", async () => {
    const harness = createHarness();
    harness.unavailable.hidden = true;

    harness.publish(build(1));
    harness.resolveReport(1, report(1));
    await settle();
    harness.rejectPreparation(1, namedError("TimeoutError"));
    await settle();

    expect(harness.unavailable.hidden).toBe(true);
    expect(harness.status.textContent).toBe("Build 1 · preparation interrupted");
  });

  it("hides the initial consumer placeholder when interrupted preparation later becomes ready", async () => {
    const harness = createHarness();

    harness.publish(build(1));
    harness.resolveReport(1, report(1));
    await settle();
    harness.rejectPreparation(1, namedError("TimeoutError"));
    await settle();

    expect(harness.unavailable.hidden).toBe(false);
    harness.motion.readiness = "interactiveReady";
    harness.motion.dispatch("readinesschange", { detail: {} });

    expect(harness.unavailable.hidden).toBe(true);
  });

  it("keeps the consumer placeholder visible for settled static policy", async () => {
    const harness = createHarness();

    harness.publish(build(1));
    harness.resolveReport(1, report(1));
    await settle();
    harness.motion.readiness = "staticReady";
    harness.resolvePreparation(1);
    await settle();

    expect(harness.status.textContent).toBe("Build 1 · staticReady");
    expect(harness.unavailable.hidden).toBe(false);
  });

  it("restores the consumer placeholder when interactive playback becomes static", async () => {
    const harness = createHarness();

    harness.publish(build(1));
    harness.resolveReport(1, report(1));
    await settle();
    harness.motion.readiness = "interactiveReady";
    harness.resolvePreparation(1);
    await settle();
    expect(harness.unavailable.hidden).toBe(true);

    harness.motion.readiness = "staticReady";
    harness.motion.dispatch("readinesschange", { detail: {} });
    expect(harness.unavailable.hidden).toBe(false);

    harness.motion.readiness = "interactiveReady";
    harness.motion.dispatch("readinesschange", { detail: {} });
    expect(harness.unavailable.hidden).toBe(true);
  });

  it("reveals the consumer alternate only for the canonical fatal playback error", async () => {
    const harness = createHarness();
    harness.unavailable.hidden = true;
    const failure = Object.freeze({ code: "DECODE_FAILED", operation: "decode" });
    const error = new FakeAvalPlaybackError(failure);

    harness.publish(build(1));
    harness.resolveReport(1, report(1));
    await settle();
    harness.motion.readiness = "error";
    harness.motion.setLastFailure(failure);
    harness.rejectPreparation(1, error);
    await settle();

    expect(harness.unavailable.hidden).toBe(false);
    expect(harness.status.textContent).toBe("Build 1 · playback unavailable");
  });

  it("ignores fatal-looking events without the terminal readiness and failure identity", () => {
    const harness = createHarness();
    harness.unavailable.hidden = true;
    const failure = Object.freeze({ code: "DECODE_FAILED", operation: "decode" });

    harness.motion.setLastFailure(failure);
    harness.motion.dispatch("error", { detail: { fatal: true, failure } });
    expect(harness.unavailable.hidden).toBe(true);

    harness.motion.readiness = "error";
    harness.motion.dispatch("error", {
      detail: { fatal: true, failure: Object.freeze({ ...failure }) }
    });
    expect(harness.unavailable.hidden).toBe(true);

    harness.motion.dispatch("error", { detail: { fatal: true, failure } });
    expect(harness.unavailable.hidden).toBe(false);
  });

  it("disables motion controls after terminal failure and restores them only when interactive", () => {
    const harness = createHarness();
    const failure = Object.freeze({ code: "DECODE_FAILED", operation: "decode" });

    harness.motion.readiness = "error";
    harness.motion.setLastFailure(failure);
    harness.motion.dispatch("error", { detail: { fatal: true, failure } });

    for (const control of harness.motionControls) {
      expect(control.disabled).toBe(true);
    }

    harness.motion.readiness = "staticReady";
    harness.motion.dispatch("readinesschange", { detail: {} });
    for (const control of harness.motionControls) {
      expect(control.disabled).toBe(true);
    }

    harness.motion.readiness = "interactiveReady";
    harness.motion.dispatch("readinesschange", { detail: {} });
    for (const control of harness.motionControls) {
      expect(control.disabled).toBe(false);
    }
  });

  it("contains rejected post-failure state and resume operations", async () => {
    const harness = createHarness();
    harness.motion.rejectControlsWith(new Error("terminal playback failure"));

    harness.state.value = "idle";
    harness.state.onchange?.({});
    harness.resume.onclick?.();
    await settle();

    expect(harness.motion.setStateCalls).toEqual(["idle"]);
    expect(harness.motion.resumeCalls).toBe(1);
  });

  it("prevents an older preparation from overwriting a newer successful generation", async () => {
    const harness = createHarness();

    harness.publish(build(1));
    harness.resolveReport(1, report(1));
    await settle();
    harness.publish(build(2));
    harness.resolveReport(2, report(2));
    await settle();
    harness.motion.readiness = "interactiveReady";
    harness.resolvePreparation(2);
    await settle();

    expect(harness.status.textContent).toBe("Build 2 · interactiveReady");
    expect(harness.unavailable.hidden).toBe(true);

    harness.rejectPreparation(1, namedError("AbortError"));
    await settle();

    expect(harness.status.textContent).toBe("Build 2 · interactiveReady");
    expect(harness.unavailable.hidden).toBe(true);
    expect(harness.motion.sourceGeneration).toBe(2);
    expect(JSON.parse(harness.report.textContent)).toMatchObject({
      build: { generation: 2 },
      compilerReport: { generation: 2 }
    });
  });
});

class FakeAvalPlaybackError extends Error {
  readonly failure: Readonly<{ code: string; operation: string }>;

  constructor(failure: Readonly<{ code: string; operation: string }>) {
    super("playback failed");
    this.name = "AvalPlaybackError";
    this.failure = failure;
  }
}

class FakeElement {
  readonly attributes = new Map<string, string>();
  readonly classList = { add: (_name: string): void => undefined };
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Set<(event: any) => void>>();
  readonly parentElement = { after: (_node: unknown): void => undefined };
  children: FakeElement[] = [];
  hidden = false;
  disabled = false;
  textContent = "";
  value = "";
  onclick: ((event?: unknown) => unknown) | null = null;
  onchange: ((event: any) => unknown) | null = null;
  oninput: ((event: any) => unknown) | null = null;

  addEventListener(type: string, listener: (event: any) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type: string, event: any): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  querySelectorAll(_selector: string): FakeElement[] {
    return [];
  }
}

class FakeMotion extends FakeElement {
  readonly stateNames = ["idle"];
  readonly eventNames = ["engage"];
  readonly inputBindings = Object.freeze({});
  readonly preparations = new Map<number, Deferred<void>>();
  readonly prepareCalls: number[] = [];
  readonly setStateCalls: string[] = [];
  resumeCalls = 0;
  readiness = "loading";
  private diagnosticFailure: unknown = null;
  private controlFailure: Error | null = null;
  sourceGeneration: number | null = null;

  override replaceChildren(...children: FakeElement[]): void {
    super.replaceChildren(...children);
    const source = children[0]?.getAttribute("src") ?? "";
    const generation = /#v=(\d+)$/u.exec(source)?.[1];
    this.sourceGeneration = generation === undefined ? null : Number(generation);
  }

  prepare(): Promise<void> {
    if (this.sourceGeneration === null) {
      return Promise.reject(new Error("prepare called before sources were installed"));
    }
    this.prepareCalls.push(this.sourceGeneration);
    const preparation = deferred<void>();
    this.preparations.set(this.sourceGeneration, preparation);
    return preparation.promise;
  }

  setLastFailure(failure: unknown): void {
    this.diagnosticFailure = failure;
  }

  rejectControlsWith(error: Error): void {
    this.controlFailure = error;
  }

  getDiagnostics(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      readiness: this.readiness,
      visualState: "idle",
      isTransitioning: false,
      effectivelyVisible: true,
      lastFailure: this.diagnosticFailure,
      presentation: null,
      runtime: null
    });
  }

  send(_name: string): void {}
  setState(name: string): Promise<void> {
    this.setStateCalls.push(name);
    return this.controlFailure === null
      ? Promise.resolve()
      : Promise.reject(this.controlFailure);
  }
  pause(): void {}
  resume(): Promise<void> {
    this.resumeCalls += 1;
    return this.controlFailure === null
      ? Promise.resolve()
      : Promise.reject(this.controlFailure);
  }
  dispose(): Promise<void> { return Promise.resolve(); }
}

class FakeEventSource {
  static current: FakeEventSource | null = null;
  readonly listeners = new Map<string, (event: { data: string }) => void>();

  constructor(_url: URL) {
    FakeEventSource.current = this;
  }

  addEventListener(type: string, listener: (event: { data: string }) => void): void {
    this.listeners.set(type, listener);
  }

  publish(value: unknown): void {
    this.listeners.get("build")?.({ data: JSON.stringify(value) });
  }

  static readCurrent(): FakeEventSource | null {
    return FakeEventSource.current;
  }
}

function createHarness(): Readonly<{
  motion: FakeMotion;
  state: FakeElement;
  resume: FakeElement;
  motionControls: readonly FakeElement[];
  report: FakeElement;
  status: FakeElement;
  unavailable: FakeElement;
  publish(value: unknown): void;
  resolveReport(generation: number, value: unknown): void;
  rejectReport(generation: number, error: Error): void;
  resolvePreparation(generation: number): void;
  rejectPreparation(generation: number, error: Error): void;
}> {
  const elements = new Map<string, FakeElement>();
  const motion = new FakeMotion();
  elements.set("motion", motion);
  for (const id of [
    "status", "report", "motion-unavailable", "state", "event", "summary", "timeline",
    "send", "pause", "resume", "replace", "stress", "clear-stress", "capture-trace",
    "motion-policy", "fit", "autoplay", "bindings", "size"
  ]) elements.set(id, new FakeElement());
  const requests = new Map<number, Deferred<FakeResponse>>();
  const document = {
    getElementById: (id: string): FakeElement | null => elements.get(id) ?? null,
    createElement: (_name: string): FakeElement => new FakeElement(),
    querySelectorAll: (_selector: string): FakeElement[] => []
  };
  const fetch = (input: URL): Promise<FakeResponse> => {
    const generation = /#v=(\d+)$/u.exec(String(input))?.[1];
    if (generation === undefined) return Promise.reject(new Error("missing generation"));
    const request = deferred<FakeResponse>();
    requests.set(Number(generation), request);
    return request.promise;
  };
  FakeEventSource.current = null;
  const source = DEV_CLIENT
    .replace(/^import .*;\n/gmu, "")
    .replaceAll("import.meta.url", JSON.stringify("http://127.0.0.1/session/client.js"));
  runInNewContext(source, {
    AvalPlaybackError: FakeAvalPlaybackError,
    EventSource: FakeEventSource,
    JSON,
    URL,
    addEventListener: (): void => undefined,
    clearInterval: (): void => undefined,
    document,
    fetch,
    setInterval: (): number => 1
  });
  const events = FakeEventSource.readCurrent();
  if (events === null) throw new Error("dev client did not create its event stream");
  return Object.freeze({
    motion,
    state: elements.get("state")!,
    resume: elements.get("resume")!,
    motionControls: Object.freeze([
      elements.get("state")!,
      elements.get("event")!,
      elements.get("send")!,
      elements.get("pause")!,
      elements.get("resume")!
    ]),
    report: elements.get("report")!,
    status: elements.get("status")!,
    unavailable: elements.get("motion-unavailable")!,
    publish(value: unknown): void {
      events.publish(value);
    },
    resolveReport(generation: number, value: unknown): void {
      const request = requests.get(generation);
      if (request === undefined) throw new Error(`missing report request ${String(generation)}`);
      request.resolve({ ok: true, json: () => Promise.resolve(value) });
    },
    rejectReport(generation: number, error: Error): void {
      const request = requests.get(generation);
      if (request === undefined) throw new Error(`missing report request ${String(generation)}`);
      request.reject(error);
    },
    resolvePreparation(generation: number): void {
      const preparation = motion.preparations.get(generation);
      if (preparation === undefined) throw new Error(`missing preparation ${String(generation)}`);
      preparation.resolve();
    },
    rejectPreparation(generation: number, error: Error): void {
      const preparation = motion.preparations.get(generation);
      if (preparation === undefined) throw new Error(`missing preparation ${String(generation)}`);
      preparation.reject(error);
    }
  });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface FakeResponse {
  readonly ok: boolean;
  json(): Promise<unknown>;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function build(generation: number): Readonly<Record<string, unknown>> {
  return Object.freeze({
    generation,
    sources: Object.freeze([Object.freeze({
      codec: "h264",
      src: `h264.avl#v=${String(generation)}`,
      type: 'application/vnd.aval; codecs="avc1.42E00A"',
      integrity: "sha256-test",
      bytes: 128,
      sha256: "a".repeat(64)
    })]),
    buildReport: Object.freeze({
      src: `build.json#v=${String(generation)}`,
      bytes: 128,
      sha256: "b".repeat(64)
    }),
    warnings: Object.freeze([])
  });
}

function report(generation: number): Readonly<Record<string, unknown>> {
  return Object.freeze({
    reportVersion: "1.0",
    generation,
    assets: Object.freeze([])
  });
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}
