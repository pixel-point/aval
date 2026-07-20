import "./style.css";
import {
  parseCompileBundleReport,
  VIDEO_CODECS,
  type VideoCodec
} from "@pixel-point/aval-format";

import { QUALIFIED_FIXTURE_PREFIX } from "../fixture-routes.js";

type Codec = VideoCodec;

interface SourcePlaygroundApi {
  readonly ready: Promise<void>;
  readonly player: HTMLElement;
  sourceSnapshot(): readonly Readonly<{
    codec: string | null;
    src: string | null;
    type: string | null;
    integrity: string | null;
  }>[];
}

interface PlayerDiagnostics {
  readonly runtime: Readonly<{
    readonly selectedCodec: string | null;
    readonly selectedRendition: string | null;
  }>;
}

type PlaygroundPlayer = HTMLElement & {
  readonly readiness?: string;
  prepare?(options?: Readonly<{ timeoutMs?: number }>): Promise<unknown>;
  getDiagnostics?(): Readonly<PlayerDiagnostics>;
};

declare global {
  interface Window {
    readonly avalSourcePlayground: SourcePlaygroundApi;
  }
}

const CODEC_ORDER = Object.freeze([...VIDEO_CODECS].reverse());
const player = requireElement<HTMLElement>("#motion");
const alternate = requireElement<HTMLElement>(".fallback");
const status = requireElement<HTMLElement>("#status");
const codecList = requireElement<HTMLOListElement>("#codec-list");
const codecButtons = new Map<Codec, HTMLButtonElement>(CODEC_ORDER.map((codec) => [
  codec,
  requireElement<HTMLButtonElement>(`#codec-list button[data-codec="${codec}"]`)
]));
const query = new URLSearchParams(location.search);
const session = boundedSession(query.get("session") ?? "playground");
const includeIntegrity = query.get("integrity") !== "0";
let requestedCodec: Codec = "av1";
let switching = false;

const ready = initialize();
const api: SourcePlaygroundApi = Object.freeze({
  ready,
  player,
  sourceSnapshot: () => Object.freeze(
    [...player.querySelectorAll<HTMLSourceElement>(":scope > source")].map((source) =>
      Object.freeze({
        codec: source.dataset.avalCodec ?? null,
        src: source.getAttribute("src"),
        type: source.getAttribute("type"),
        integrity: source.getAttribute("integrity")
      })
    )
  )
});
Object.defineProperty(window, "avalSourcePlayground", {
  value: api,
  configurable: false,
  enumerable: false,
  writable: false
});

async function initialize(): Promise<void> {
  status.textContent = "Loading the AVAL 1.0 bundle report…";
  try {
    const response = await fetch(`${QUALIFIED_FIXTURE_PREFIX}build.json`, {
      cache: "no-store",
      headers: { "X-Aval-Session": session }
    });
    if (!response.ok) throw new Error(`bundle report request failed (${String(response.status)})`);
    const report = parseCompileBundleReport(await response.json());
    const assets = new Map(report.assets.map((asset) => [asset.codec, asset]));
    for (const codec of CODEC_ORDER) {
      const source = player.querySelector<HTMLSourceElement>(
        `:scope > source[data-aval-codec="${codec}"]`
      );
      const asset = assets.get(codec);
      if (source === null || asset === undefined) {
        throw new Error(`bundle report is missing the ordered ${codec} source`);
      }
      const url = new URL(`${QUALIFIED_FIXTURE_PREFIX}${asset.path}`, location.href);
      url.searchParams.set("session", session);
      source.src = url.href;
      source.type = asset.type;
      if (includeIntegrity) source.setAttribute("integrity", asset.integrity);
    }
    const motion = player as PlaygroundPlayer;
    bindCodecControls(motion);
    player.addEventListener("readinesschange", () => {
      if (motion.readiness === "interactiveReady") {
        alternate.hidden = true;
      }
      publishRuntimeStatus(motion);
    });
    player.addEventListener("error", (event) => {
      const detail = (event as unknown as CustomEvent<{
        readonly fatal?: unknown;
      }>).detail;
      if (detail?.fatal === true) {
        alternate.hidden = false;
      }
      if (!switching) publishRuntimeStatus(motion);
    });
    await import("@pixel-point/aval-element/auto");
    await motion.prepare?.({ timeoutMs: 30_000 });
    publishRuntimeStatus(motion);
    setControlsDisabled(false);
  } catch (error) {
    player.hidden = true;
    alternate.hidden = false;
    status.textContent = error instanceof Error ? error.message : "playground initialization failed";
    status.dataset.state = "error";
    throw error;
  }
}

function bindCodecControls(motion: PlaygroundPlayer): void {
  for (const [codec, button] of codecButtons) {
    button.addEventListener("click", () => {
      void switchPreferredCodec(motion, codec);
    });
  }
}

async function switchPreferredCodec(
  motion: PlaygroundPlayer,
  codec: Codec
): Promise<void> {
  if (switching) return;
  requestedCodec = codec;
  switching = true;
  setControlsDisabled(true);
  publishControlState(null);
  codecList.setAttribute("aria-busy", "true");
  status.textContent = `Trying ${codecLabel(codec)} first…`;
  status.dataset.state = "switching";
  let prepared = false;
  try {
    // The alternate overlays the still-laid-out player. Keeping the host
    // effectively visible avoids turning consumer presentation into a runtime
    // visibility suspension that can block a replacement generation.
    alternate.hidden = false;
    reorderSources(codec);
    await motion.prepare?.({ timeoutMs: 30_000 });
    prepared = true;
  } catch (error) {
    status.textContent = error instanceof Error
      ? `Could not try ${codecLabel(codec)}: ${error.message}`
      : `Could not try ${codecLabel(codec)}.`;
    status.dataset.state = "error";
  } finally {
    switching = false;
    codecList.removeAttribute("aria-busy");
    setControlsDisabled(false);
    if (prepared) publishRuntimeStatus(motion);
  }
}

function reorderSources(codec: Codec): void {
  const sources = new Map<Codec, HTMLSourceElement>();
  for (const source of player.querySelectorAll<HTMLSourceElement>(":scope > source")) {
    const family = source.dataset.avalCodec as Codec | undefined;
    if (family !== undefined && CODEC_ORDER.includes(family)) sources.set(family, source);
  }
  if (sources.size !== CODEC_ORDER.length) {
    throw new Error("the player does not contain all four codec sources");
  }
  const fragment = document.createDocumentFragment();
  for (const family of [codec, ...CODEC_ORDER.filter((entry) => entry !== codec)]) {
    fragment.append(requireMapValue(sources, family));
  }
  player.append(fragment);
}

function publishRuntimeStatus(motion: PlaygroundPlayer): void {
  const readiness = motion.readiness ?? "ready";
  const codec = motion.getDiagnostics?.().runtime.selectedCodec ?? null;
  const family = codec === null ? null : familyForCodec(codec);
  if (switching) {
    status.textContent = `Trying ${codecLabel(requestedCodec)} first… Runtime readiness: ${readiness}`;
    status.dataset.state = "switching";
    return;
  }
  status.textContent = runtimeStatusText(readiness, codec, family);
  status.dataset.state = readiness;
  publishControlState(family);
}

function runtimeStatusText(
  readiness: string,
  codec: string | null,
  family: Codec | null
): string {
  if (family === null || codec === null) {
    return `Requested ${codecLabel(requestedCodec)} first · Runtime readiness: ${readiness} · no animated codec selected`;
  }
  if (family !== requestedCodec) {
    return `Requested ${codecLabel(requestedCodec)} first · browser selected ${codecLabel(family)} (${codec}) · Runtime readiness: ${readiness}`;
  }
  return `Runtime readiness: ${readiness} · selected ${codecLabel(family)} (${codec})`;
}

function publishControlState(active: Codec | null): void {
  for (const [codec, button] of codecButtons) {
    button.setAttribute("aria-pressed", codec === requestedCodec ? "true" : "false");
    button.dataset.active = codec === active ? "true" : "false";
    if (codec === active) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}

function setControlsDisabled(disabled: boolean): void {
  for (const button of codecButtons.values()) button.disabled = disabled;
}

function familyForCodec(codec: string): Codec {
  if (codec.startsWith("av01.")) return "av1";
  if (codec.startsWith("vp09.")) return "vp9";
  if (codec.startsWith("hvc1.")) return "h265";
  if (codec.startsWith("avc1.")) return "h264";
  throw new TypeError(`unexpected selected codec: ${codec}`);
}

function codecLabel(codec: Codec): string {
  switch (codec) {
    case "av1": return "AV1";
    case "vp9": return "VP9";
    case "h265": return "H.265 / HEVC";
    case "h264": return "H.264 / AVC";
  }
}

function requireMapValue<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error("required codec source is missing");
  return value;
}

function boundedSession(value: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(value)) throw new TypeError("invalid playground session");
  return value;
}

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`missing playground element: ${selector}`);
  return element;
}

void ready.catch((error: unknown) => {
  console.error("AVAL source playground failed.", error);
});
