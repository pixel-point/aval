import { createAvalAlpha, type AlphaSource } from "@pixel-point/aval-alpha";
import type { AvalAlphaElement } from "@pixel-point/aval-alpha/element";

/** Executable local verification harness; no diagnostics are bundled in the runtime. */
export async function runChecks(sources: AlphaSource[]) {
  const results: { name: string; passed: boolean; skipped?: boolean; details?: unknown }[] = [];
  const check = async (name: string, task: () => Promise<unknown>) => {
    try { results.push({ name, passed: true, details: await task() }); }
    catch (error) { results.push({ name, passed: false, details: String(error) }); }
  };
  const assert = (condition: boolean, message: string) => { if (!condition) throw Error(message); };
  const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const mount = () => { const c = document.createElement("canvas"); document.body.append(c); return c; };
  const supported = sources.filter((s) => !s.type || document.createElement("video").canPlayType(s.type));
  for (const source of sources) {
    if (!supported.includes(source)) {
      results.push({ name: `Decode and alpha: ${source.src}`, passed: true, skipped: true, details: "Decoder not advertised by this browser" });
      continue;
    }
    await check(`Decode and alpha: ${source.src}`, async () => {
      const canvas = mount();
      const start = performance.now();
      const player = createAvalAlpha(canvas, { sources: [source], timeoutMs: 3000 });
      try {
        await player.ready;
        const startupMs = performance.now() - start;
        await player.seek(0.25);
        const gl = canvas.getContext("webgl")!;
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const alpha = [16, 48, 80, 112].map((x) => pixels[((canvas.height - 17) * canvas.width + x) * 4 + 3]!);
        [0, 64, 128, 255].forEach((expected, i) => assert(Math.abs(expected - alpha[i]!) <= 4, `Alpha band ${i}: ${alpha[i]}, expected ${expected}`));
        // Pixel values are premultiplied. Check colored, partially transparent pixels as well.
        const offset = ((canvas.height - 17) * canvas.width + 80) * 4;
        const rgb = [...pixels.slice(offset, offset + 3)];
        [110, 41, 55].forEach((expected, i) => assert(Math.abs(rgb[i]! - expected) <= 7, `Color channel ${i}: ${rgb[i]}`));
        await player.play(); await delay(180);
        assert(player.video.currentTime > 0.25, "Playback clock did not advance");
        player.pause();
        return { alpha, rgb, startupMs, type: source.type, quality: player.video.getVideoPlaybackQuality?.() };
      } finally { player.destroy(); canvas.remove(); }
    });
  }
  const good = supported.find((s) => s.src.includes("vp9")) ?? supported[0];
  if (!good) return { userAgent: navigator.userAgent, results: [...results, { name: "At least one codec", passed: false }] };
  const withPlayer = async (task: (player: ReturnType<typeof createAvalAlpha>, canvas: HTMLCanvasElement) => Promise<unknown>, alternatives = [good]) => {
    const canvas = mount(); const player = createAvalAlpha(canvas, { sources: alternatives, timeoutMs: 1500 });
    try { await player.ready; return await task(player, canvas); }
    finally { player.destroy(); canvas.remove(); }
  };
  await check("Failed first source advances; later source is not loaded", async () => {
    const unused = `/unused-${Date.now()}.webm`;
    return withPlayer(async (player) => {
      assert(player.source?.src === good.src, "Wrong selected source");
      assert(!performance.getEntriesByName(new URL(unused, location.href).href).length, "Later candidate was fetched");
      return player.source?.src;
    }, [{ ...good, src: "/missing.webm" }, good, { ...good, src: unused }]);
  });
  await check("Wrong decoded dimensions advance to the next source", () => withPlayer(async (player) => {
    assert(player.source?.width === good.width, "Wrong layout selected");
  }, [{ ...good, width: good.width + 2 }, good]));
  await check("All candidates fail and release the media element", async () => {
    const canvas = mount(); const before = document.querySelectorAll("video").length;
    const player = createAvalAlpha(canvas, { sources: [{ ...good, src: "/missing.webm" }], timeoutMs: 1000 });
    let rejected = false;
    try { await player.ready; } catch { rejected = true; }
    assert(rejected && document.querySelectorAll("video").length === before, "Failure did not reject and clean up");
    canvas.remove();
  });
  await check("Destroy cancels pending readiness and frees its media", async () => {
    const canvas = mount(); const player = createAvalAlpha(canvas, { sources: [good] });
    player.destroy(); player.destroy();
    let rejected = false;
    try { await player.ready; } catch { rejected = true; }
    assert(rejected && !player.video.isConnected && !player.video.getAttribute("src"), "Pending player survived disposal");
    canvas.remove();
  });
  await check("Unavailable WebGL rejects readiness and releases media", async () => {
    const canvas = mount();
    canvas.getContext = (() => null) as typeof canvas.getContext;
    const player = createAvalAlpha(canvas, { sources: [good] });
    let code: string | undefined;
    try { await player.ready; } catch (error) { code = (error as { code: string }).code; }
    assert(code === "rendering" && !player.video.isConnected, "Missing WebGL did not fail cleanly");
    canvas.remove();
  });
  await check("Loop, pause and resume", () => withPlayer(async (player) => {
    player.video.loop = true;
    await player.seek(player.video.duration - 0.1);
    await player.play(); await delay(350); player.pause();
    assert(player.video.currentTime < 1, "Loop did not wrap");
    const time = player.video.currentTime; await delay(120);
    assert(Math.abs(time - player.video.currentTime) < 0.05, "Paused clock advanced");
  }));
  await check("WebGL context restoration", () => withPlayer(async (player, canvas) => {
    const gl = canvas.getContext("webgl")!;
    const extension = gl.getExtension("WEBGL_lose_context");
    if (!extension) throw Error("Context loss test extension unavailable");
    const restored = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("Context restoration timed out")), 2000);
      canvas.addEventListener("webglcontextrestored", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    await player.play();
    extension.loseContext(); await delay(100); extension.restoreContext(); await restored;
    player.pause();
    await player.seek(0.25);
    const pixel = new Uint8Array(4);
    gl.readPixels(112, canvas.height - 17, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    assert(pixel[3]! >= 251, "Context restoration did not redraw");
  }));
  for (const timing of ["before creation", "while loading"]) {
    await check(`Startup context loss ${timing} recovers the same source`, async () => {
      const canvas = mount();
      const gl = canvas.getContext("webgl")!;
      const extension = gl.getExtension("WEBGL_lose_context");
      assert(!!extension, "Context loss test extension unavailable");
      if (timing === "before creation") extension!.loseContext();
      const player = createAvalAlpha(canvas, { sources: [good], timeoutMs: 2000 });
      if (timing === "while loading") extension!.loseContext();
      let settled = false;
      void player.ready.then(() => { settled = true; }, () => { settled = true; });
      try {
        await delay(100);
        assert(!settled, "Readiness settled before context restoration");
        extension!.restoreContext();
        await player.ready;
        assert(player.source?.src === good.src, "Restoration abandoned the selected candidate");
        await player.seek(0.25);
        const pixel = new Uint8Array(4);
        gl.readPixels(112, canvas.height - 17, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        assert(pixel[3]! >= 251, "Restored startup did not render alpha");
      } finally { player.destroy(); canvas.remove(); }
    });
  }
  for (const cancel of [false, true]) {
    await check(`Lost startup context ${cancel ? "disposal" : "timeout"} releases media`, async () => {
      const canvas = mount();
      const gl = canvas.getContext("webgl")!;
      const extension = gl.getExtension("WEBGL_lose_context");
      assert(!!extension, "Context loss test extension unavailable");
      extension!.loseContext();
      const player = createAvalAlpha(canvas, { sources: [good], timeoutMs: 1500 });
      try {
        if (cancel) { await delay(50); player.destroy(); }
        const outcome = await player.ready.then(() => "resolved", (error: { code: string }) => error.code);
        assert(outcome === (cancel ? "disposed" : "rendering"), `Unexpected outcome: ${outcome}`);
        assert(!player.video.isConnected && !player.video.getAttribute("src"), "Lost context retained media");
      } finally { player.destroy(); extension!.restoreContext(); canvas.remove(); }
    });
  }
  await check("Autoplay rejection keeps the selected source ready", async () => {
    const original = HTMLMediaElement.prototype.play;
    let blocked = false;
    HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException("Gesture required", "NotAllowedError"));
    const canvas = mount();
    const player = createAvalAlpha(canvas, { sources: [good], autoplay: true, onAutoplayBlocked: () => { blocked = true; } });
    try { await player.ready; await delay(0); assert(blocked && player.source?.src === good.src && player.video.isConnected, "Autoplay rejection destroyed the source"); }
    finally { player.destroy(); canvas.remove(); HTMLMediaElement.prototype.play = original; }
  });
  await check("Element source replacement, loop attribute and reconnect", async () => {
    const element = document.createElement("aval-alpha") as AvalAlphaElement;
    element.sources = [good]; document.body.append(element);
    try {
      await element.ready;
      const first = element.video;
      element.setAttribute("loop", ""); await delay(0);
      assert(element.video === first && !!first?.loop, "Loop attribute reloaded the source");
      element.sources = [{ ...good, src: good.src + "?replacement=1" }]; await element.ready;
      assert(element.video !== first && !first?.getAttribute("src"), "Source replacement retained the old player");
      const previous = element.video;
      element.remove();
      assert(!previous?.isConnected && !previous?.getAttribute("src"), "Disconnected element retained media");
      document.body.append(element); await element.ready;
      assert(element.video !== previous, "Reconnect did not start a new player");
    } finally { element.remove(); }
  });
  await check("Pending element commands cannot act on a replacement player", async () => {
    const element = document.createElement("aval-alpha") as AvalAlphaElement;
    element.sources = [good]; document.body.append(element);
    try {
      await element.ready;
      const pending = element.seek(0.5).then(() => "resolved", (error: { code: string }) => error.code);
      queueMicrotask(() => { element.sources = [{ ...good, src: good.src + "?command-replacement=1" }]; });
      assert(await pending === "disposed", "A pending seek targeted the replacement player");
      await element.ready;
      assert(element.video?.currentTime === 0, "The replacement inherited a previous seek");
    } finally { element.remove(); }
  });
  await check("Immediate commands use pending DOM source edits", async () => {
    const element = document.createElement("aval-alpha") as AvalAlphaElement;
    const child = document.createElement("source");
    child.src = good.src;
    child.type = good.type ?? "";
    child.dataset.layout = [good.width, good.height, ...good.colorRect, ...good.alphaRect].join(" ");
    element.append(child); document.body.append(element);
    try {
      await element.ready;
      const previous = element.video;
      child.src = good.src + "?dom-command=1";
      await element.seek(0.5);
      assert(element.video !== previous && !previous?.getAttribute("src"), "Command ignored a pending DOM edit");
      assert(element.video?.currentTime === 0.5, "Command did not target the authored source");
    } finally { element.remove(); }
  });
  await check("Removing autoplay while loading prevents an automatic start", async () => {
    const element = document.createElement("aval-alpha") as AvalAlphaElement;
    element.sources = [good]; element.setAttribute("autoplay", ""); document.body.append(element);
    try {
      await Promise.resolve();
      element.removeAttribute("autoplay");
      await element.ready;
      await delay(0);
      assert(element.video?.paused === true, "Removed autoplay still started playback");
    } finally { element.remove(); }
  });
  const port = new URLSearchParams(location.search).get("network-checks");
  if (port && /^\d+$/u.test(port)) {
    const origin = `http://127.0.0.1:${port}`;
    for (const name of ["cors-denied", "slow", "truncated"]) {
      await check(`Network failure advances: ${name}`, () => withPlayer(async (player) => {
        assert(player.source?.src === good.src, "Bad network candidate survived");
      }, [{ ...good, src: `${origin}/${name}.webm` }, good]));
    }
    await check("CORS-enabled external media renders", () => withPlayer(async (player) => {
      assert(!!player.source?.src.includes("cors-allowed"), "CORS source did not load");
    }, [{ ...good, src: `${origin}/cors-allowed.webm` }]));
  }
  return { userAgent: navigator.userAgent, webCodecsAvailable: "VideoDecoder" in window,
    frameCallbacksAvailable: "requestVideoFrameCallback" in HTMLVideoElement.prototype, results };
}
