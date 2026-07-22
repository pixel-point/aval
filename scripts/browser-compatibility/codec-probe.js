import {
  defineAvalElement,
  SOURCE_CODEC_PRIORITY
} from "./modules/element/index.js";

const CODECS = SOURCE_CODEC_PRIORITY;
const DEMOS = Object.freeze({
  playground: Object.freeze({
    report: "/playground/favorite/build.json",
    assets: "/playground/favorite/",
    width: 48,
    height: 48
  }),
  rabbit: Object.freeze({
    report: "/rabbit/grass-rabbit/build.json",
    assets: "/rabbit/grass-rabbit/",
    width: 640,
    height: 360
  }),
  codecs: Object.freeze({
    report: "/codecs/grass-rabbit/build.json",
    assets: "/codecs/grass-rabbit/",
    width: 1280,
    height: 720
  }),
  orb: Object.freeze({
    report: "/orb/kinetic-orb/build.json",
    assets: "/orb/kinetic-orb/",
    width: 512,
    height: 512
  })
});
const MAX_REPORT_BYTES = 32 * 1024;
const statusNode = requireElement("probe-status");
const mountNode = requireElement("probe-mount");
const resultNode = requireElement("probe-result");

let latest = freezeReport({
  status: "loading",
  demo: null,
  codec: null,
  source: null,
  player: null,
  failure: null
});

const ready = run().catch((reason) => {
  publishFailure(reason);
  return latest;
});
const api = Object.freeze({
  ready,
  report() { return latest; }
});
Object.defineProperty(window, "avalCodecProbe", {
  value: api,
  configurable: false,
  enumerable: false,
  writable: false
});
renderReport();

async function run() {
  const selection = parseSelection(location.search);
  const demo = DEMOS[selection.demo];
  setStatus(
    "loading",
    `Loading ${selection.codec.toUpperCase()} metadata for ${selection.demo}…`
  );

  const response = await fetch(demo.report, {
    cache: "no-store",
    credentials: "same-origin"
  });
  if (!response.ok) {
    throw new Error(`Build report request failed (${String(response.status)}).`);
  }
  const report = await response.json();
  const asset = selectAsset(report, selection.codec);

  defineAvalElement();
  const player = document.createElement("aval-player");
  player.id = "codec-probe-player";
  player.setAttribute("width", String(demo.width));
  player.setAttribute("height", String(demo.height));
  player.setAttribute("autoplay", "visible");
  player.setAttribute("tabindex", "0");
  player.setAttribute(
    "aria-label",
    `${selection.demo} rendered with only the ${selection.codec} source.`
  );
  const source = document.createElement("source");
  source.src = new URL(asset.path, new URL(demo.assets, location.href)).href;
  source.setAttribute("data-codec", selection.codec);
  source.setAttribute("integrity", asset.integrity);
  player.append(source);

  const selectedSource = Object.freeze({
    path: asset.path,
    type: asset.type,
    integrity: asset.integrity,
    bytes: asset.bytes,
    codecString: asset.codecString
  });
  latest = freezeReport({
    status: "preparing",
    demo: selection.demo,
    codec: selection.codec,
    source: selectedSource,
    player: null,
    failure: null
  });
  renderReport();

  player.addEventListener("readinesschange", () => {
    publishPlayer(player, selection, selectedSource);
  });
  player.addEventListener("visualstatechange", () => {
    publishPlayer(player, selection, selectedSource);
  });
  player.addEventListener("error", (event) => {
    if (event.detail?.fatal === true) {
      publishPlayer(player, selection, selectedSource, event.detail?.failure);
    }
  });
  mountNode.replaceChildren(player);
  setStatus("preparing", "The selected source is preparing…");

  try {
    await player.prepare({ timeoutMs: 30_000 });
    publishPlayer(player, selection, selectedSource);
  } catch (reason) {
    publishPlayer(player, selection, selectedSource, reason);
  }
  return latest;
}

function parseSelection(search) {
  const params = new URLSearchParams(search);
  const entries = [...params.entries()];
  if (
    entries.length !== 2 || entries[0]?.[0] === entries[1]?.[0] ||
    !entries.every(([key]) => key === "demo" || key === "codec")
  ) {
    throw new TypeError(
      "Use exactly one demo and one codec query parameter; no other parameters are accepted."
    );
  }
  const demo = params.get("demo");
  const codec = params.get("codec");
  if (!Object.hasOwn(DEMOS, demo) || !CODECS.includes(codec)) {
    throw new TypeError("The requested demo or codec token is not supported by this probe.");
  }
  return Object.freeze({ demo, codec });
}

function selectAsset(value, codec) {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    !Array.isArray(value.assets) || value.assets.length < 1 || value.assets.length > 16
  ) throw new TypeError("The build report asset list is invalid.");
  const matches = value.assets.filter((asset) => asset?.codec === codec);
  if (matches.length !== 1) {
    throw new Error(`The build report does not contain exactly one ${codec} asset.`);
  }
  const asset = matches[0];
  if (
    asset.path !== `${codec}.avl` ||
    typeof asset.codecString !== "string" || asset.codecString.length < 1 ||
    asset.codecString.length > 128 ||
    typeof asset.type !== "string" ||
    asset.type !== `application/vnd.aval; codecs="${asset.codecString}"` ||
    typeof asset.integrity !== "string" ||
    !/^sha256-[A-Za-z0-9+/]{43}=$/u.test(asset.integrity) ||
    !Number.isSafeInteger(asset.bytes) || asset.bytes < 1
  ) throw new TypeError(`The ${codec} build-report asset is invalid.`);
  return Object.freeze({
    path: asset.path,
    codecString: asset.codecString,
    type: asset.type,
    integrity: asset.integrity,
    bytes: asset.bytes
  });
}

function publishPlayer(player, selection, source, reason = null) {
  const diagnostics = readPlayerDiagnostics(player);
  const readyState = player.readiness === "interactiveReady" ||
    player.readiness === "visualReady";
  const failure = reason === null
    ? diagnostics?.lastFailure ?? null
    : boundedFailure(reason);
  const state = failure === null
    ? (readyState ? "ready" : "preparing")
    : "error";
  latest = freezeReport({
    status: state,
    demo: selection.demo,
    codec: selection.codec,
    source,
    player: diagnostics,
    failure
  });
  setStatus(
    state,
    state === "ready"
      ? `${selection.codec.toUpperCase()} reached ${player.readiness}.`
      : state === "error"
        ? `The selected ${selection.codec.toUpperCase()} source failed.`
        : `The selected source is ${player.readiness}.`
  );
  renderReport();
}

function readPlayerDiagnostics(player) {
  try {
    const value = player.getDiagnostics();
    const runtime = value.runtime;
    return Object.freeze({
      readiness: value.readiness,
      mode: value.mode,
      requestedState: value.requestedState,
      visualState: value.visualState,
      isTransitioning: value.isTransitioning,
      lastFailure: value.lastFailure,
      selectedCodec: runtime.selectedCodec,
      selectedRendition: runtime.selectedRendition,
      transportMode: runtime.transportMode,
      decoderDiagnostic: runtime.decoderDiagnostics.at(-1) ?? null,
      rendererDiagnostic: runtime.rendererDiagnostics.at(-1) ?? null
    });
  } catch {
    return null;
  }
}

function publishFailure(reason) {
  mountNode.replaceChildren();
  latest = freezeReport({
    status: "error",
    demo: null,
    codec: null,
    source: null,
    player: null,
    failure: boundedFailure(reason)
  });
  setStatus("error", latest.failure.message || "The codec probe request is invalid.");
  renderReport();
}

function boundedFailure(reason) {
  let name = "Error";
  let message = "Codec probe failed.";
  try {
    if (typeof reason?.name === "string" && reason.name.length > 0) name = reason.name;
    if (typeof reason?.message === "string" && reason.message.length > 0) {
      message = reason.message;
    } else if (typeof reason === "string" && reason.length > 0) {
      message = reason;
    }
  } catch { /* Retain fixed safe defaults. */ }
  return Object.freeze({
    name: cleanText(name, 64),
    message: cleanText(message, 512)
  });
}

function freezeReport(parts) {
  return Object.freeze({
    schemaVersion: "1.0",
    kind: "aval-codec-probe",
    status: parts.status,
    demo: parts.demo,
    codec: parts.codec,
    source: parts.source,
    player: parts.player,
    failure: parts.failure
  });
}

function renderReport() {
  const json = JSON.stringify(latest, null, 2);
  if (new TextEncoder().encode(json).byteLength > MAX_REPORT_BYTES) {
    throw new RangeError("Codec probe JSON exceeded its fixed byte limit.");
  }
  resultNode.textContent = json;
}

function setStatus(state, text) {
  statusNode.dataset.state = state;
  statusNode.textContent = text;
}

function cleanText(value, limit) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ")
    .trim()
    .slice(0, limit);
}

function requireElement(id) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing #${id}.`);
  return element;
}
