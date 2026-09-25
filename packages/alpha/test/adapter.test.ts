import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAlphaBinding, createAlphaConfiguration } from "../src/adapter.js";
import { AvalAlphaError, type AlphaOptions, type AlphaSource } from "../src/types.js";

const factory = vi.hoisted(() => vi.fn());
vi.mock("../src/player.js", () => ({ createAvalAlpha: factory }));
const source: AlphaSource = { src: "/a.mp4", width: 32, height: 72, colorRect: [0, 0, 32, 32], alphaRect: [0, 40, 32, 32] };
const canvas = {} as HTMLCanvasElement;
const config = (options: Partial<AlphaOptions> = {}) => createAlphaConfiguration({ sources: [source], ...options });

function fakePlayer(options: AlphaOptions) {
  const video = Object.assign(new EventTarget(), { paused: true, ended: false, loop: options.loop ?? false });
  let resolve!: () => void, reject!: (error: unknown) => void;
  const ready = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  const play = vi.fn(async () => { await ready; video.paused = false; video.dispatchEvent(new Event("play")); });
  const pause = vi.fn(() => { video.paused = true; video.dispatchEvent(new Event("pause")); });
  return { ready, video, source: options.sources[0], play, pause, seek: vi.fn(async () => {}),
    destroy: vi.fn(() => reject(new AvalAlphaError("disposed", "disposed"))), resolve, reject, options };
}
let players: ReturnType<typeof fakePlayer>[];
beforeEach(() => {
  players = [];
  factory.mockImplementation((_canvas: HTMLCanvasElement, options: AlphaOptions) => {
    const player = fakePlayer(options); players.push(player); return player;
  });
});
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("shared alpha adapter", () => {
  it("makes the mounted player available before notifying loading subscribers", async () => {
    const binding = createAlphaBinding(config());
    let ready: Promise<void> | undefined;
    binding.subscribe(() => {
      if (binding.getStatus().status === "loading") ready = binding.commands.ready();
    });
    binding.mount(canvas);
    players[0]!.resolve();
    await expect(ready).resolves.toBeUndefined();
  });

  it("releases the failed session and its native listeners before reporting an error", async () => {
    const binding = createAlphaBinding(config()); binding.mount(canvas);
    const player = players[0]!;
    player.options.onError!(new AvalAlphaError("media", "failed"));
    expect(binding.commands.getVideo()).toBeUndefined();
    player.video.paused = false; player.video.dispatchEvent(new Event("play"));
    expect(binding.getStatus()).toMatchObject({ status: "error", playing: false });
    await flush();
  });

  it("does not send a previous session's error to a replacement's callback", async () => {
    const onError = vi.fn();
    const binding = createAlphaBinding(config()); binding.mount(canvas);
    binding.subscribe(() => {
      if (binding.getStatus().status === "error") binding.commit(config({ sources: [{ ...source, src: "/new.mp4" }], onError }));
    });
    players[0]!.options.onError!(new AvalAlphaError("media", "failed"));
    expect(onError).not.toHaveBeenCalled();
    expect(binding.getStatus().status).toBe("loading");
    await flush();
  });

  it("is inert during SSR and rejects detached commands", async () => {
    const binding = createAlphaBinding(config());
    expect(binding.getStatus()).toBe(binding.getServerStatus());
    expect(binding.getStatus().status).toBe("idle");
    expect(players).toHaveLength(0);
    await expect(binding.commands.ready()).rejects.toMatchObject({ code: "disposed" });
    await expect(binding.commands.play()).rejects.toMatchObject({ code: "disposed" });
    await expect(binding.commands.seek(0)).rejects.toMatchObject({ code: "disposed" });
  });

  it("publishes readiness, native play/pause/ended and releases the mount", async () => {
    const onReady = vi.fn();
    const binding = createAlphaBinding(createAlphaConfiguration({ sources: [source], onReady }));
    const changed = vi.fn();
    const unsubscribe = binding.subscribe(changed);
    const cleanup = binding.mount(canvas);
    const player = players[0]!;
    expect(binding.getStatus().status).toBe("loading");
    player.resolve(); await binding.commands.ready();
    expect(onReady).toHaveBeenCalledWith(sourceWithType());
    expect(binding.getStatus()).toMatchObject({ status: "ready", source: sourceWithType(), playing: false });
    await binding.commands.play();
    expect(binding.getStatus().playing).toBe(true);
    binding.commands.pause();
    expect(binding.getStatus().playing).toBe(false);
    await binding.commands.play(); player.video.ended = true; player.video.dispatchEvent(new Event("ended"));
    expect(binding.getStatus().playing).toBe(false);
    await binding.commands.seek(0.5);
    expect(player.seek).toHaveBeenCalledWith(0.5);
    unsubscribe(); const count = changed.mock.calls.length;
    cleanup(); cleanup();
    expect(player.destroy).toHaveBeenCalledTimes(1);
    expect(binding.commands.getVideo()).toBeUndefined();
    expect(binding.getStatus()).toBe(binding.getServerStatus());
    expect(changed).toHaveBeenCalledTimes(count);
  });

  it("compares source values, updates loop and uses current callbacks without reloading", async () => {
    const oldReady = vi.fn(), newReady = vi.fn();
    const binding = createAlphaBinding(createAlphaConfiguration({ sources: [source], onReady: oldReady }));
    binding.mount(canvas);
    binding.commit(createAlphaConfiguration({ sources: [{ ...source }], loop: true, onReady: newReady }));
    expect(players).toHaveLength(1);
    expect(players[0]!.video.loop).toBe(true);
    players[0]!.resolve(); await flush();
    expect(oldReady).not.toHaveBeenCalled(); expect(newReady).toHaveBeenCalledTimes(1);
    const status = binding.getStatus();
    binding.commit(config({ loop: false }));
    expect(binding.getStatus()).toBe(status);
    expect(players[0]!.video.loop).toBe(false);
  });

  it.each([
    { sources: [{ ...source, src: "/b.mp4" }] },
    { sources: [{ ...source, colorRect: source.alphaRect, alphaRect: source.colorRect }] },
    { sources: [{ ...source, src: "/b.mp4" }, source] },
    { crossOrigin: "use-credentials" as const }, { timeoutMs: 100 }
  ])("replaces the player for changed decoding settings: %j", async (change) => {
    const binding = createAlphaBinding(config()); binding.mount(canvas);
    binding.commit(config(change));
    expect(players).toHaveLength(2); expect(players[0]!.destroy).toHaveBeenCalledTimes(1);
    const error = new AvalAlphaError("media", "stale"); players[0]!.options.onError!(error);
    players[0]!.video.paused = false; players[0]!.video.dispatchEvent(new Event("play"));
    await flush(); expect(binding.getStatus()).toMatchObject({ status: "loading", playing: false, error: undefined });
    players[1]!.resolve(); await binding.commands.ready();
    expect(binding.getStatus().source?.src).toBe(change.sources?.[0]?.src ?? source.src);
  });

  it("cancels loading and allows Strict Mode cleanup/remount without stale completion", async () => {
    const onReady = vi.fn();
    const binding = createAlphaBinding(createAlphaConfiguration({ sources: [source], onReady }));
    const cleanup = binding.mount(canvas);
    const pending = binding.commands.ready(); cleanup();
    binding.mount(canvas); cleanup();
    await expect(pending).rejects.toMatchObject({ code: "disposed" });
    players[1]!.resolve(); await flush();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(binding.getStatus().status).toBe("ready");
    expect(() => binding.mount(canvas)).toThrow(/only one component/);
  });

  it("uses the latest autoplay policy when loading completes and updates it live", async () => {
    const binding = createAlphaBinding(config({ autoplay: true })); binding.mount(canvas);
    binding.commit(config({ autoplay: false })); players[0]!.resolve(); await flush();
    expect(players[0]!.play).not.toHaveBeenCalled();
    binding.commit(config({ autoplay: true })); await flush();
    expect(binding.getStatus().playing).toBe(true);
    binding.commit(config({ autoplay: false }));
    expect(binding.getStatus().playing).toBe(true);
    expect(players).toHaveLength(1);
  });

  it("keeps blocked autoplay ready and uses fresh callbacks", async () => {
    const onAutoplayBlocked = vi.fn(), replacement = vi.fn();
    const binding = createAlphaBinding(config({ autoplay: true, onAutoplayBlocked })); binding.mount(canvas);
    const blocked = new DOMException("blocked", "NotAllowedError");
    players[0]!.play.mockRejectedValue(blocked);
    binding.commit(config({ autoplay: true, onAutoplayBlocked: replacement }));
    players[0]!.resolve(); await flush();
    expect(onAutoplayBlocked).not.toHaveBeenCalled(); expect(replacement).toHaveBeenCalledWith(blocked);
    expect(binding.getStatus().status).toBe("ready");
  });

  it("ignores an autoplay failure from a replaced player", async () => {
    const onError = vi.fn(), onAutoplayBlocked = vi.fn();
    const binding = createAlphaBinding(config({ autoplay: true, onError, onAutoplayBlocked })); binding.mount(canvas);
    let reject!: (error: unknown) => void;
    players[0]!.play.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
    players[0]!.resolve(); await flush();
    binding.commit(config({ sources: [{ ...source, src: "/new.mp4" }], onError, onAutoplayBlocked }));
    reject(new DOMException("blocked", "NotAllowedError")); await flush();
    expect(onError).not.toHaveBeenCalled(); expect(onAutoplayBlocked).not.toHaveBeenCalled();
    expect(binding.getStatus().status).toBe("loading");
  });

  it("allows a subscriber to replace sources on readiness without a stale ready callback", async () => {
    const onReady = vi.fn();
    const binding = createAlphaBinding(createAlphaConfiguration({ sources: [source], onReady }));
    binding.subscribe(() => {
      if (binding.getStatus().source?.src === source.src) binding.commit(config({ sources: [{ ...source, src: "/new.mp4" }] }));
    });
    binding.mount(canvas); players[0]!.resolve(); await flush();
    expect(players).toHaveLength(2); expect(players[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(onReady).not.toHaveBeenCalled(); expect(binding.getStatus().status).toBe("loading");
  });

  it("reports terminal errors once and rejects commands with the cause", async () => {
    const onError = vi.fn(); const binding = createAlphaBinding(config({ onError })); binding.mount(canvas);
    const error = new AvalAlphaError("unsupported-source", "none");
    players[0]!.options.onError!(error); players[0]!.reject(error); await flush();
    expect(binding.getStatus()).toMatchObject({ status: "error", error });
    expect(onError).toHaveBeenCalledTimes(1);
    await expect(binding.commands.play()).rejects.toBe(error);
  });

  it("snapshots input without retaining mutable layouts and rejects invalid options", () => {
    const colorRect: [number, number, number, number] = [0, 0, 32, 32];
    const snapshot = config({ sources: [{ ...source, colorRect }] }); colorRect[0] = 5;
    expect(snapshot.options.sources[0]!.colorRect[0]).toBe(0);
    expect(() => config({ timeoutMs: NaN })).toThrow(AvalAlphaError);
  });
});

function sourceWithType() { return { ...source, type: "" }; }
