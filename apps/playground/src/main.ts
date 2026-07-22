import "./style.css";
import {
  SOURCE_CODEC_PRIORITY,
  type AvalSourceCodec
} from "@pixel-point/aval-element";
import {
  parseCompileBundleReport,
  parseVideoCodecString
} from "@pixel-point/aval-format";

import { QUALIFIED_FIXTURE_PREFIX } from "../fixture-routes.js";

type Codec = AvalSourceCodec;

interface SourcePlaygroundApi {
  readonly ready: Promise<void>;
  readonly player: HTMLElement;
  sourceSnapshot(): readonly Readonly<{
    codec: string | null;
    src: string | null;
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

interface SourceDefinition {
  readonly src: string;
  readonly integrity: string | null;
}

declare global {
  interface Window {
    readonly avalSourcePlayground: SourcePlaygroundApi;
  }
}

const CODEC_ORDER = SOURCE_CODEC_PRIORITY;
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
const sourceDefinitions = new Map<Codec, Readonly<SourceDefinition>>();
let isolatedCodec: Codec | null = null;
let switching = false;

const ready = initialize();
const api: SourcePlaygroundApi = Object.freeze({
  ready,
  player,
  sourceSnapshot: () => Object.freeze(
    [...player.querySelectorAll<HTMLSourceElement>(":scope > source")].map((source) =>
      Object.freeze({
        codec: source.dataset.codec ?? null,
        src: source.getAttribute("src"),
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
        `:scope > source[data-codec="${codec}"]`
      );
      const asset = assets.get(codec);
      if (source === null || asset === undefined) {
        throw new Error(`bundle report is missing the ordered ${codec} source`);
      }
      const url = new URL(`${QUALIFIED_FIXTURE_PREFIX}${asset.path}`, location.href);
      url.searchParams.set("session", session);
      sourceDefinitions.set(codec, Object.freeze({
        src: url.href,
        integrity: includeIntegrity ? asset.integrity : null
      }));
    }
    installCodecSources(CODEC_ORDER);
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
      void switchIsolatedCodec(motion, codec);
    });
  }
}

async function switchIsolatedCodec(
  motion: PlaygroundPlayer,
  codec: Codec
): Promise<void> {
  if (switching) return;
  isolatedCodec = codec;
  switching = true;
  setControlsDisabled(true);
  publishControlState(null);
  codecList.setAttribute("aria-busy", "true");
  status.textContent = `Testing ${codecLabel(codec)} by itself…`;
  status.dataset.state = "switching";
  let prepared = false;
  try {
    // The alternate overlays the still-laid-out player. Keeping the host
    // effectively visible avoids turning consumer presentation into a runtime
    // visibility suspension that can block a replacement generation.
    alternate.hidden = false;
    installCodecSources([codec]);
    await motion.prepare?.({ timeoutMs: 30_000 });
    prepared = true;
  } catch (error) {
    status.textContent = error instanceof Error
      ? `Could not play ${codecLabel(codec)} by itself: ${error.message}`
      : `Could not play ${codecLabel(codec)} by itself.`;
    status.dataset.state = "error";
  } finally {
    switching = false;
    codecList.removeAttribute("aria-busy");
    setControlsDisabled(false);
    if (prepared) publishRuntimeStatus(motion);
  }
}

function installCodecSources(codecs: readonly Codec[]): void {
  const sources = codecs.map((codec) => {
    const definition = requireMapValue(sourceDefinitions, codec);
    const source = document.createElement("source");
    source.src = definition.src;
    source.setAttribute("data-codec", codec);
    if (definition.integrity !== null) {
      source.setAttribute("integrity", definition.integrity);
    }
    return source;
  });
  player.replaceChildren(...sources);
}

function publishRuntimeStatus(motion: PlaygroundPlayer): void {
  const readiness = motion.readiness ?? "ready";
  const codec = motion.getDiagnostics?.().runtime.selectedCodec ?? null;
  const family = codec === null ? null : familyForCodec(codec);
  if (switching) {
    status.textContent = isolatedCodec === null
      ? `Preparing the automatic codec ladder… Runtime readiness: ${readiness}`
      : `Testing ${codecLabel(isolatedCodec)} by itself… Runtime readiness: ${readiness}`;
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
    return isolatedCodec === null
      ? `Automatic codec ladder · Runtime readiness: ${readiness} · no animated codec selected`
      : `Testing ${codecLabel(isolatedCodec)} only · Runtime readiness: ${readiness} · no animated codec selected`;
  }
  const scope = isolatedCodec === null ? "Automatic ladder" : "Single-codec test";
  return `${scope} · Runtime readiness: ${readiness} · selected ${codecLabel(family)} (${codec})`;
}

function publishControlState(active: Codec | null): void {
  for (const [codec, button] of codecButtons) {
    button.setAttribute("aria-pressed", codec === isolatedCodec ? "true" : "false");
    button.dataset.active = codec === active ? "true" : "false";
    if (codec === active) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
}

function setControlsDisabled(disabled: boolean): void {
  for (const button of codecButtons.values()) button.disabled = disabled;
}

function familyForCodec(codec: string): Codec {
  const family = parseVideoCodecString(codec)?.family;
  if (family !== undefined) return family;
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
