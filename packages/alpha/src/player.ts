import { createCompositor } from "./compositor.js";
import { resolvePlaybackOptions } from "./source.js";
import { AvalAlphaError, type AlphaOptions, type AlphaPlayer, type AlphaSource } from "./types.js";

export function createAvalAlpha(canvas: HTMLCanvasElement, options: AlphaOptions): AlphaPlayer {
  const document = canvas.ownerDocument;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.loop = options.loop ?? false;
  video.preload = "auto";
  video.crossOrigin = options.crossOrigin ?? "anonymous";
  video.setAttribute("aria-hidden", "true");
  video.tabIndex = -1;
  video.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none";
  (canvas.parentNode ?? document.body).appendChild(video);
  const controller = new AbortController();
  const signal = controller.signal;
  let compositor: ReturnType<typeof createCompositor> | undefined;
  let selected: AlphaSource | undefined;
  let started = false;
  let frame = 0;
  let raf = 0;

  function stop() {
    if (frame) video.cancelVideoFrameCallback(frame);
    if (raf) cancelAnimationFrame(raf);
    frame = raf = 0;
  }
  function destroy() {
    if (signal.aborted) return;
    controller.abort(new AvalAlphaError("disposed", "Player was disposed"));
    stop();
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    compositor?.destroy();
  }
  function fail(cause: unknown) {
    if (signal.aborted) return;
    const error = cause instanceof AvalAlphaError ? cause : new AvalAlphaError("rendering", "Alpha rendering failed", { cause });
    destroy();
    options.onError?.(error);
  }
  function draw() {
    if (signal.aborted || !selected || document.hidden) return;
    try { compositor?.draw(video); } catch (error) { fail(error); }
  }
  function schedule() {
    stop();
    if (signal.aborted || !started || video.paused || video.ended || document.hidden) return;
    const tick = () => { frame = raf = 0; draw(); schedule(); };
    if (typeof video.requestVideoFrameCallback === "function") frame = video.requestVideoFrameCallback(tick);
    else raf = requestAnimationFrame(tick);
  }
  const listen = (target: EventTarget, event: string, callback: () => void) =>
    target.addEventListener(event, callback, { signal });
  listen(video, "play", schedule);
  listen(video, "pause", () => { stop(); draw(); });
  listen(video, "ended", () => { stop(); draw(); });
  listen(video, "seeked", draw);
  listen(document, "visibilitychange", () => { draw(); schedule(); });
  listen(video, "error", () => {
    if (started) fail(new AvalAlphaError("media", "Video playback failed", { cause: video.error }));
  });

  const ready = (async () => {
    const { timeoutMs: timeout, sources } = resolvePlaybackOptions(options);
    compositor = createCompositor(canvas, () => {
      try { compositor?.restore(); draw(); schedule(); } catch (error) { fail(error); }
    });
    const attempts: unknown[] = [];
    for (const source of sources) {
      signal.throwIfAborted();
      if (source.type && !video.canPlayType(source.type)) {
        attempts.push({ src: source.src, reason: "unsupported type" });
        continue;
      }
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
        const loaded = waitForMedia(video, "loadeddata", timeout, signal);
        video.src = source.src;
        video.load();
        await loaded;
        signal.throwIfAborted();
        if (video.videoWidth !== source.width || video.videoHeight !== source.height) {
          throw new AvalAlphaError("invalid-source", "Decoded video dimensions do not match its layout");
        }
        const deadline = performance.now() + timeout;
        while (true) {
          await compositor.waitForContext(deadline - performance.now(), signal);
          signal.throwIfAborted();
          if (compositor.configure(source) && compositor.draw(video)) break;
          if (!compositor.contextLost()) throw new AvalAlphaError("rendering", "First frame could not be drawn");
        }
        selected = source;
        started = true;
        if (options.autoplay) void video.play().catch((error: unknown) => {
          if (signal.aborted) return;
          if (error instanceof DOMException && error.name === "NotAllowedError") options.onAutoplayBlocked?.(error);
          else fail(new AvalAlphaError("media", "Cannot start playback", { cause: error }));
        });
        schedule();
        return;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (compositor.contextLost()) throw error;
        attempts.push({ src: source.src, reason: error });
      }
    }
    throw new AvalAlphaError("unsupported-source", "No source could start transparent playback", { cause: attempts });
  })().catch((error: unknown) => { fail(error); throw error; });
  // Consumers can await ready; unused elements must not create unhandled rejections.
  void ready.catch(() => {});

  return {
    ready, video,
    get source() { return selected; },
    async play() { await ready; signal.throwIfAborted(); await video.play(); },
    pause() { video.pause(); },
    async seek(seconds: number) {
      await ready;
      signal.throwIfAborted();
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > video.duration) throw new RangeError("Seek is outside the video duration");
      if (video.currentTime === seconds && !video.seeking) { draw(); return; }
      const settled = waitForMedia(video, "seeked", options.timeoutMs ?? 15_000, signal);
      video.currentTime = seconds;
      await settled;
      draw();
    },
    destroy
  };
}

function waitForMedia(video: HTMLVideoElement, event: string, timeout: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      video.removeEventListener(event, success);
      video.removeEventListener("error", failed);
      signal.removeEventListener("abort", aborted);
      if (error) reject(error); else resolve();
    };
    const success = () => finish();
    const failed = () => finish(new AvalAlphaError("media", "Cannot load video", { cause: video.error }));
    const aborted = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new AvalAlphaError("media", "Video operation timed out")), timeout);
    video.addEventListener(event, success);
    video.addEventListener("error", failed);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
  });
}
