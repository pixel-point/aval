import { createAvalAlpha } from "./player.js";
import { AvalAlphaError, type AlphaPlayer } from "./types.js";
import type { AlphaBinding, AlphaConfiguration, AlphaStatus } from "./adapter-types.js";

const IDLE: AlphaStatus = Object.freeze({ status: "idle", playing: false, source: undefined, error: undefined });
const disposed = () => new AvalAlphaError("disposed", "Alpha component is not mounted or was replaced");

interface Session {
  readonly player: AlphaPlayer;
  readonly events: AbortController;
}

export function createAlphaBinding(initial: AlphaConfiguration): AlphaBinding {
  let configuration = initial;
  let canvas: HTMLCanvasElement | undefined;
  let session: Session | undefined;
  let status = IDLE;
  const listeners = new Set<() => void>();

  function publish(next: AlphaStatus) {
    if (next.status === status.status && next.playing === status.playing &&
      next.source === status.source && next.error === status.error) return;
    status = Object.freeze(next);
    for (const listener of listeners) listener();
  }
  function release() {
    const previous = session;
    session = undefined;
    previous?.events.abort();
    previous?.player.destroy();
  }
  function fail(current: Session, error: AvalAlphaError) {
    if (session !== current) return;
    const notify = configuration.options.onError;
    const failed: AlphaStatus = { ...status, status: "error", playing: false, error };
    release();
    publish(failed);
    if (status === failed) notify?.(error);
  }
  function autoplay(current: Session) {
    void current.player.play().catch((cause: unknown) => {
      if (session !== current) return;
      if (cause instanceof Error && cause.name === "NotAllowedError") {
        configuration.options.onAutoplayBlocked?.(cause);
      } else {
        fail(current, new AvalAlphaError("media", "Cannot start playback", { cause }));
      }
    });
  }
  function start(node: HTMLCanvasElement) {
    release();
    const current: Session = {
      player: createAvalAlpha(node, {
        ...configuration.options, autoplay: false,
        onError: (error) => fail(current, error)
      }),
      events: new AbortController()
    };
    session = current;
    const { player, events } = current;
    const updatePlaying = () => {
      if (session === current) publish({ ...status, playing: !player.video.paused && !player.video.ended });
    };
    for (const event of ["play", "pause", "ended"]) {
      player.video.addEventListener(event, updatePlaying, { signal: events.signal });
    }
    void player.ready.then(() => {
      if (session !== current) return;
      publish({ status: "ready", playing: !player.video.paused && !player.video.ended, source: player.source, error: undefined });
      if (session !== current) return;
      configuration.options.onReady?.(player.source!);
      if (session === current && configuration.options.autoplay) autoplay(current);
    }, () => {});
    // A loading subscriber can immediately call commands or replace this session.
    publish({ ...IDLE, status: "loading" });
  }
  function requirePlayer() {
    if (status.error) throw status.error;
    if (!session) throw disposed();
    return session.player;
  }
  return {
    getStatus: () => status,
    getServerStatus: () => IDLE,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    commands: Object.freeze({
      async ready() {
        const current = requirePlayer();
        await current.ready;
        if (session?.player !== current) throw disposed();
      },
      async play() { await requirePlayer().play(); },
      pause() { session?.player.pause(); },
      async seek(seconds: number) { await requirePlayer().seek(seconds); },
      getVideo: () => session?.player.video
    }),
    commit(next) {
      const previous = configuration;
      configuration = next;
      if (!canvas) return;
      if (previous.key !== next.key) start(canvas);
      else if (session) {
        session.player.video.loop = next.options.loop ?? false;
        if (status.status === "ready" && next.options.autoplay && !previous.options.autoplay) autoplay(session);
      }
    },
    mount(node) {
      if (canvas) throw new Error("An alpha controller can mount only one component at a time");
      canvas = node;
      start(node);
      let mounted = true;
      return () => {
        if (!mounted) return;
        mounted = false;
        canvas = undefined;
        release();
        publish(IDLE);
      };
    }
  };
}
