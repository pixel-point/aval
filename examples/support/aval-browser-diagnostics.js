export const AVAL_BROWSER_DIAGNOSTIC_LIMITS = Object.freeze({
  authoredSources: 128,
  checkpoints: 32,
  elementTrace: 32,
  generalArray: 128,
  generalObjectKeys: 128,
  maxDepth: 16,
  players: 32,
  reportBytes: 2_097_152,
  reportNodes: 16_384,
  runtimeTrace: 64,
  stringLength: 4_096,
  valueBytes: 524_288,
  valueNodes: 8_192
});

const AUTHORED_SOURCE_LIMIT = AVAL_BROWSER_DIAGNOSTIC_LIMITS.authoredSources;
const CHECKPOINT_LIMIT = AVAL_BROWSER_DIAGNOSTIC_LIMITS.checkpoints;
const ELEMENT_TRACE_LIMIT = AVAL_BROWSER_DIAGNOSTIC_LIMITS.elementTrace;
const GENERAL_ARRAY_LIMIT = AVAL_BROWSER_DIAGNOSTIC_LIMITS.generalArray;
const GENERAL_OBJECT_KEY_LIMIT =
  AVAL_BROWSER_DIAGNOSTIC_LIMITS.generalObjectKeys;
const MAX_DEPTH = AVAL_BROWSER_DIAGNOSTIC_LIMITS.maxDepth;
const PLAYER_LIMIT = AVAL_BROWSER_DIAGNOSTIC_LIMITS.players;
const REPORT_BYTE_LIMIT = AVAL_BROWSER_DIAGNOSTIC_LIMITS.reportBytes;
const REPORT_NODE_LIMIT = AVAL_BROWSER_DIAGNOSTIC_LIMITS.reportNodes;
const RUNTIME_TRACE_LIMIT = AVAL_BROWSER_DIAGNOSTIC_LIMITS.runtimeTrace;
const STRING_LIMIT = AVAL_BROWSER_DIAGNOSTIC_LIMITS.stringLength;
const VALUE_BYTE_LIMIT = AVAL_BROWSER_DIAGNOSTIC_LIMITS.valueBytes;
const VALUE_NODE_LIMIT = AVAL_BROWSER_DIAGNOSTIC_LIMITS.valueNodes;
const TRUNCATION_MARKER = "…[truncated]";
const REDACTED_SENSITIVE_VALUE = "[redacted-sensitive]";
const REDACTED_SENSITIVE_KEY = "[redacted-sensitive-key]";
const REPORT_ENVELOPE_BYTE_RESERVE = 16_384;
const REPORT_ENVELOPE_NODE_RESERVE = 32;
const SERIALIZATION_EXHAUSTED = Symbol("serialization-exhausted");
const JSON_TEXT_ENCODER = new TextEncoder();

const DIAGNOSTICS_QUERY = "avalDiagnostics";
const DIAGNOSTICS_VALUE = "1";
const OVERLAY_ATTRIBUTE = "data-aval-browser-diagnostics";
const OVERLAY_FAILURE_LINE_LIMIT = 12;
const OVERLAY_FIELD_LENGTH = 96;

/**
 * Query-gated, page-resident diagnostics used by the real-browser matrix.
 * Importing this module without `?avalDiagnostics=1` has no DOM or global side
 * effects.
 */
export const avalBrowserDiagnostics = installDiagnosticsWhenRequested();

function installDiagnosticsWhenRequested() {
  if (
    new URL(location.href).searchParams.get(DIAGNOSTICS_QUERY) !==
    DIAGNOSTICS_VALUE
  ) {
    return null;
  }

  if (window.avalBrowserDiagnostics) return window.avalBrowserDiagnostics;

  const diagnostics = createDiagnostics();
  Object.defineProperty(window, "avalBrowserDiagnostics", {
    value: diagnostics,
    configurable: true,
    enumerable: false,
    writable: false
  });
  installOverlay(diagnostics);
  return diagnostics;
}

function createDiagnostics() {
  const startedAt = new Date().toISOString();
  const startedAtMilliseconds = Date.now();
  const startedAtPerformance = performance.now();
  let serializationBudgetExhausted = false;
  const serializeResident = (value) => {
    const outcome = serializeDiagnosticValue(value);
    if (outcome.exhausted) serializationBudgetExhausted = true;
    return outcome.value;
  };
  const environment = captureEnvironment(serializeResident);
  const playerMetadata = createBoundedQueue(PLAYER_LIMIT);
  const authoredSources = createBoundedQueue(AUTHORED_SOURCE_LIMIT);
  const checkpoints = createBoundedQueue(CHECKPOINT_LIMIT);
  const attachedPlayers = new WeakMap();
  let lastAttachedPlayer = null;
  let latest = null;
  let playerSequence = 0;
  let checkpointSequence = 0;
  let overlayStatus = () => undefined;

  const api = Object.freeze({
    limits: AVAL_BROWSER_DIAGNOSTIC_LIMITS,

    attach(player, context = null) {
      if (!(player instanceof HTMLElement)) {
        throw new TypeError("Browser diagnostics can only attach to an HTMLElement");
      }

      const existing = attachedPlayers.get(player);
      if (existing !== undefined) {
        lastAttachedPlayer = player;
        return existing.detach;
      }

      const playerId = `player-${String(++playerSequence)}`;
      const safeContext = serializeResident(context);
      const metadata = Object.freeze({
        playerId,
        context: safeContext,
        elementId: player.id === "" ? null : boundedDiagnosticText(player.id),
        tagName: boundedDiagnosticText(player.tagName.toLowerCase())
      });
      playerMetadata.append(metadata);
      captureAuthoredSources(player, playerId, safeContext, authoredSources);

      const listeners = [];
      for (const type of [
        "readinesschange",
        "transitionstart",
        "transitionend",
        "underflow",
        "error"
      ]) {
        const listener = (event) => {
          if (type === "error" && event.detail?.fatal !== true) return;
          recordCheckpoint(`event:${type}`, player, event);
        };
        player.addEventListener(type, listener);
        listeners.push([type, listener]);
      }

      const detach = () => {
        for (const [type, listener] of listeners) {
          player.removeEventListener(type, listener);
        }
        attachedPlayers.delete(player);
        if (lastAttachedPlayer === player) lastAttachedPlayer = null;
      };
      attachedPlayers.set(player, { context: safeContext, detach, playerId });
      lastAttachedPlayer = player;
      recordCheckpoint("attached", player, null);
      return detach;
    },

    checkpoint(label, player) {
      if (typeof label !== "string" || label.trim().length === 0) {
        throw new TypeError("A diagnostic checkpoint requires a non-empty label");
      }
      const target = player instanceof HTMLElement ? player : lastAttachedPlayer;
      return recordCheckpoint(boundedDiagnosticText(label), target, null);
    },

    report() {
      const generatedAt = new Date().toISOString();
      const pageLocation = diagnosticPageLocation();
      const outcome = serializeDiagnosticValue({
        environment,
        players: playerMetadata.snapshot(),
        authoredSources: authoredSources.snapshot(),
        checkpoints: checkpoints.snapshot(),
        latest
      }, {
        bytes: REPORT_BYTE_LIMIT - REPORT_ENVELOPE_BYTE_RESERVE,
        nodes: REPORT_NODE_LIMIT - REPORT_ENVELOPE_NODE_RESERVE
      });
      if (outcome.exhausted) serializationBudgetExhausted = true;
      const partial = isDiagnosticRecord(outcome.value) ? outcome.value : {};
      const report = {
        schemaVersion: 1,
        generatedAt,
        serializationBudgetExhausted,
        session: {
          startedAt,
          startedAtMilliseconds,
          url: pageLocation
        },
        environment: isDiagnosticRecord(partial.environment)
          ? partial.environment
          : {},
        players: Array.isArray(partial.players) ? partial.players : [],
        authoredSources: Array.isArray(partial.authoredSources)
          ? partial.authoredSources
          : [],
        checkpoints: Array.isArray(partial.checkpoints)
          ? partial.checkpoints
          : [],
        latest: isDiagnosticRecord(partial.latest) ? partial.latest : null
      };
      if (jsonByteLength(report) <= REPORT_BYTE_LIMIT) return report;
      serializationBudgetExhausted = true;
      return {
        schemaVersion: 1,
        generatedAt,
        serializationBudgetExhausted: true,
        session: {
          startedAt,
          startedAtMilliseconds,
          url: pageLocation
        },
        environment: {},
        players: [],
        authoredSources: [],
        checkpoints: [],
        latest: null
      };
    },

    clear() {
      checkpoints.clear();
      checkpointSequence = 0;
      latest = null;
      overlayStatus();
    },

    _setOverlayStatus(callback) {
      overlayStatus = callback;
      overlayStatus();
    }
  });

  return api;

  function recordCheckpoint(label, player, event) {
    const attachment = player === null ? undefined : attachedPlayers.get(player);
    const snapshot = player === null
      ? null
      : captureElementSnapshot(player, serializeResident);
    const record = Object.freeze({
      sequence: ++checkpointSequence,
      label,
      capturedAt: new Date().toISOString(),
      elapsedMilliseconds: roundMilliseconds(performance.now() - startedAtPerformance),
      playerId: attachment?.playerId ?? null,
      context: attachment?.context ?? null,
      event: event === null ? null : Object.freeze({
        type: boundedDiagnosticText(event.type),
        detail: serializeResident(event.detail)
      }),
      element: snapshot?.checkpoint ?? null
    });
    checkpoints.append(record);
    latest = snapshot === null ? latest : Object.freeze({
      checkpointSequence: record.sequence,
      playerId: attachment?.playerId ?? null,
      context: attachment?.context ?? null,
      element: snapshot.latest
    });
    overlayStatus();
    return serializeResident(record);
  }
}

function captureEnvironment(serialize) {
  const userAgentData = navigator.userAgentData;
  return Object.freeze({
    userAgent: boundedDiagnosticText(navigator.userAgent),
    userAgentData: userAgentData === undefined ? null : serialize({
      brands: userAgentData.brands,
      mobile: userAgentData.mobile,
      platform: userAgentData.platform
    }),
    secureContext: window.isSecureContext,
    crossOriginIsolated: window.crossOriginIsolated === true,
    viewport: Object.freeze({
      width: window.innerWidth,
      height: window.innerHeight
    }),
    devicePixelRatio: window.devicePixelRatio,
    reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    visibilityState: document.visibilityState,
    capabilities: Object.freeze({
      webCryptoSubtleDigest: (() => {
        try {
          return typeof window.crypto?.subtle?.digest === "function";
        } catch {
          return false;
        }
      })(),
      videoDecoder: typeof window.VideoDecoder === "function",
      videoDecoderIsConfigSupported:
        typeof window.VideoDecoder?.isConfigSupported === "function",
      videoFrame: typeof window.VideoFrame === "function",
      offscreenCanvas: typeof window.OffscreenCanvas === "function",
      webgl2: typeof window.WebGL2RenderingContext === "function",
      webgpu: "gpu" in navigator,
      braveBrandApi: (() => {
        try {
          return typeof navigator.brave?.isBrave === "function";
        } catch {
          return false;
        }
      })()
    })
  });
}

function captureAuthoredSources(player, playerId, context, destination) {
  let child = player.firstElementChild;
  let sourceIndex = 0;
  let visitedChildren = 0;
  while (child !== null && visitedChildren < AUTHORED_SOURCE_LIMIT) {
    const next = child.nextElementSibling;
    visitedChildren += 1;
    if (child.localName !== "source") {
      child = next;
      continue;
    }
    const type = boundedDiagnosticText(child.getAttribute("type") ?? "");
    destination.append(Object.freeze({
      playerId,
      context,
      index: sourceIndex,
      mimeType: type.split(";", 1)[0]?.trim() ?? "",
      codec: parseCodec(type)
    }));
    sourceIndex += 1;
    child = next;
  }
}

function parseCodec(type) {
  const match = /(?:^|;)\s*codecs\s*=\s*["']?([^;"']+)/iu.exec(type);
  return match?.[1]?.trim() ?? null;
}

function captureElementSnapshot(player, serialize) {
  const element = Object.freeze({
    elementId: player.id === "" ? null : boundedDiagnosticText(player.id),
    tagName: boundedDiagnosticText(player.tagName.toLowerCase()),
    readiness: readNullableProperty(player, "readiness", serialize),
    mode: readNullableProperty(player, "mode", serialize),
    staticReason: readNullableProperty(player, "staticReason", serialize),
    requestedState: readNullableProperty(player, "requestedState", serialize),
    visualState: readNullableProperty(player, "visualState", serialize),
    isTransitioning: readNullableProperty(player, "isTransitioning", serialize),
    paused: readNullableProperty(player, "paused", serialize),
    effectivelyVisible: readNullableProperty(player, "effectivelyVisible", serialize)
  });
  const getDiagnostics = player.getDiagnostics;
  if (typeof getDiagnostics !== "function") {
    const unavailable = Object.freeze({
      ...element,
      diagnostics: null,
      diagnosticsError: "getDiagnostics() is not available yet"
    });
    return Object.freeze({ checkpoint: unavailable, latest: unavailable });
  }

  try {
    const raw = getDiagnostics.call(player, { trace: true });
    if (
      raw === null ||
      (typeof raw !== "object" && typeof raw !== "function")
    ) throw new TypeError("getDiagnostics() did not return an object");
    const core = Object.create(null);
    let coreKeyCount = 0;
    let visitedKeyCount = 0;
    for (const key in raw) {
      if (visitedKeyCount >= GENERAL_OBJECT_KEY_LIMIT) break;
      visitedKeyCount += 1;
      if (!Object.hasOwn(raw, key)) continue;
      if (key === "elementTrace" || key === "runtimeTrace") continue;
      if (coreKeyCount >= GENERAL_OBJECT_KEY_LIMIT - 2) break;
      core[key] = raw[key];
      coreKeyCount += 1;
    }
    const checkpointDiagnostics = serialize(core);
    const latestRaw = Object.create(null);
    for (const key in core) latestRaw[key] = core[key];
    latestRaw.elementTrace = boundedArrayTail(
      raw.elementTrace,
      ELEMENT_TRACE_LIMIT
    );
    latestRaw.runtimeTrace = boundedArrayTail(
      raw.runtimeTrace,
      RUNTIME_TRACE_LIMIT
    );
    const latestDiagnostics = serialize(latestRaw);
    return Object.freeze({
      checkpoint: Object.freeze({
        ...element,
        diagnostics: checkpointDiagnostics,
        diagnosticsError: null
      }),
      latest: Object.freeze({
        ...element,
        diagnostics: latestDiagnostics,
        diagnosticsError: null
      })
    });
  } catch (error) {
    const failed = Object.freeze({
      ...element,
      diagnostics: null,
      diagnosticsError: errorMessage(error)
    });
    return Object.freeze({ checkpoint: failed, latest: failed });
  }
}

function readNullableProperty(owner, key, serialize) {
  try {
    return serialize(owner[key] ?? null);
  } catch (error) {
    return `[property read failed: ${errorMessage(error)}]`;
  }
}

function installOverlay(diagnostics) {
  const mount = () => {
    if (document.querySelector(`[${OVERLAY_ATTRIBUTE}]`) !== null) return;

    const details = document.createElement("details");
    details.setAttribute(OVERLAY_ATTRIBUTE, "");
    details.style.cssText = [
      "position:fixed",
      "right:12px",
      "bottom:12px",
      "z-index:2147483647",
      "max-width:min(360px,calc(100vw - 24px))",
      "padding:8px 10px",
      "border:1px solid rgba(255,255,255,.25)",
      "border-radius:8px",
      "background:rgba(15,15,18,.94)",
      "color:#fff",
      "font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace",
      "box-shadow:0 8px 32px rgba(0,0,0,.35)"
    ].join(";");

    const summary = document.createElement("summary");
    summary.textContent = "AVAL diagnostics";
    summary.style.cursor = "pointer";

    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;padding-top:8px";
    const status = document.createElement("output");
    status.style.cssText = [
      "display:block",
      "flex-basis:100%",
      "color:#b9b9c5",
      "white-space:pre-wrap"
    ].join(";");

    const capture = overlayButton("Capture");
    capture.addEventListener("click", () => diagnostics.checkpoint("manual:capture"));
    const copy = overlayButton("Copy JSON");
    copy.addEventListener("click", () => {
      void copyText(JSON.stringify(diagnostics.report(), null, 2));
    });
    const clear = overlayButton("Clear");
    clear.addEventListener("click", () => diagnostics.clear());

    controls.append(capture, copy, clear, status);
    details.append(summary, controls);
    document.body.append(details);
    diagnostics._setOverlayStatus(() => {
      const report = diagnostics.report();
      const element = report.latest?.element;
      const runtime = element?.diagnostics?.runtime;
      const failure = element?.diagnostics?.lastFailure;
      const selectedCodec = runtime?.selectedCodec;
      const outcome = typeof selectedCodec === "string"
        ? `${selectedCodec} @ ${runtime?.rendererBackend ?? "renderer-pending"}`
        : failure?.code ?? "pending";
      const summary = [
        `${String(report.checkpoints.length)}/${String(CHECKPOINT_LIMIT)} checkpoints`,
        overlayDiagnosticField(element?.readiness ?? "pending"),
        overlayDiagnosticField(outcome)
      ].join(" · ");
      status.textContent = [
        summary,
        ...overlayFailureSummaries(runtime)
      ].join("\n");
    });
  };

  if (document.body === null) {
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  } else {
    mount();
  }
}

function overlayFailureSummaries(runtime) {
  if (!isDiagnosticRecord(runtime)) return [];
  const lines = [];
  const decoderDiagnostics = Array.isArray(runtime.decoderDiagnostics)
    ? runtime.decoderDiagnostics
    : [];
  for (const diagnostic of decoderDiagnostics) {
    if (lines.length >= OVERLAY_FAILURE_LINE_LIMIT) break;
    if (!isDiagnosticRecord(diagnostic)) continue;
    const outputFailure = isDiagnosticRecord(diagnostic.outputFailure)
      ? diagnostic.outputFailure
      : null;
    const fields = [
      `decoder[${overlayDiagnosticField(diagnostic.sourceIndex)}]`,
      `${overlayDiagnosticField(diagnostic.code)}@` +
        overlayDiagnosticField(diagnostic.phase),
      `lane=${overlayDiagnosticField(diagnostic.lane)}`,
      `run=${overlayDiagnosticField(diagnostic.run)}`,
      `logical=${overlayDiagnosticField(diagnostic.logicalRunId)}`,
      `unit=${overlayDiagnosticField(diagnostic.unit)}`
    ];
    if (outputFailure !== null) {
      fields.push(
        "mismatch=" +
          `${overlayDiagnosticField(outputFailure.kind)}/` +
          `${overlayDiagnosticField(outputFailure.field)}/` +
          overlayDiagnosticField(outputFailure.validationLayer)
      );
    }
    lines.push(fields.join(" "));
  }

  const rendererDiagnostics = Array.isArray(runtime.rendererDiagnostics)
    ? runtime.rendererDiagnostics
    : [];
  for (const diagnostic of rendererDiagnostics) {
    if (lines.length >= OVERLAY_FAILURE_LINE_LIMIT) break;
    if (!isDiagnosticRecord(diagnostic)) continue;
    const contextState = diagnostic.contextLost === true
      ? "lost"
      : diagnostic.contextLost === false ? "available" : "unknown";
    lines.push([
      `renderer[${overlayDiagnosticField(diagnostic.sourceIndex)}]`,
      `backend=${overlayDiagnosticField(diagnostic.backend)}`,
      `phase=${overlayDiagnosticField(diagnostic.phase)}`,
      `gl=${overlayGlError(diagnostic.glError)}`,
      `context=${contextState}`
    ].join(" "));
  }
  return lines;
}

function overlayDiagnosticField(value) {
  if (value === null || value === undefined) return "none";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? String(value) : "unknown";
  }
  if (typeof value !== "string") return "unknown";
  const singleLine = boundedDiagnosticText(value).replace(/\s+/gu, " ");
  if (singleLine.length <= OVERLAY_FIELD_LENGTH) return singleLine;
  return `${singleLine.slice(
    0,
    OVERLAY_FIELD_LENGTH - TRUNCATION_MARKER.length
  )}${TRUNCATION_MARKER}`;
}

function overlayGlError(value) {
  if (value === null || value === undefined) return "none";
  if (!Number.isSafeInteger(value) || value < 0) return "unknown";
  const hex = `0x${value.toString(16).toUpperCase().padStart(4, "0")}`;
  switch (value) {
    case 0x0000: return `NO_ERROR(${hex})`;
    case 0x0500: return `INVALID_ENUM(${hex})`;
    case 0x0501: return `INVALID_VALUE(${hex})`;
    case 0x0502: return `INVALID_OPERATION(${hex})`;
    case 0x0505: return `OUT_OF_MEMORY(${hex})`;
    case 0x0506: return `INVALID_FRAMEBUFFER_OPERATION(${hex})`;
    case 0x9242: return `CONTEXT_LOST_WEBGL(${hex})`;
    default: return hex;
  }
}

function overlayButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.style.cssText = [
    "padding:4px 7px",
    "border:1px solid rgba(255,255,255,.3)",
    "border-radius:5px",
    "background:#25252c",
    "color:#fff",
    "font:inherit",
    "cursor:pointer"
  ].join(";");
  return button;
}

async function copyText(value) {
  if (typeof navigator.clipboard?.writeText === "function") {
    await navigator.clipboard.writeText(value).catch(() => undefined);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand?.("copy");
  textarea.remove();
}

function serializeDiagnosticValue(value, limits = {}) {
  const state = {
    remainingBytes: limits.bytes ?? VALUE_BYTE_LIMIT,
    remainingNodes: limits.nodes ?? VALUE_NODE_LIMIT,
    exhausted: false,
    seen: new WeakSet()
  };
  const serialized = serializeDiagnosticValueInternal(value, state, 0, null);
  return Object.freeze({
    value: serialized === SERIALIZATION_EXHAUSTED ? null : serialized,
    exhausted: state.exhausted
  });
}

function serializeDiagnosticValueInternal(value, state, depth, key) {
  if (isSensitiveDiagnosticValue(key, value) || isBinaryDiagnosticValue(value)) {
    return serializeDiagnosticScalar(REDACTED_SENSITIVE_VALUE, state);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return serializeDiagnosticScalar(value, state);
  }
  if (typeof value === "string") {
    const text = isStackDiagnosticKey(key)
      ? "[redacted-stack]"
      : isLocationDiagnosticKey(key)
        ? "[redacted-url]"
        : boundedDiagnosticText(value);
    return serializeDiagnosticScalar(text, state);
  }
  if (typeof value === "bigint") {
    return serializeDiagnosticScalar(boundedDiagnosticText(value.toString()), state);
  }
  if (
    typeof value === "undefined" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) return serializeDiagnosticScalar(null, state);
  if (depth >= MAX_DEPTH) {
    return serializeDiagnosticScalar("[depth limit]", state);
  }
  if (state.seen.has(value)) {
    return serializeDiagnosticScalar("[circular]", state);
  }
  if (value instanceof Error) {
    return serializeDiagnosticValueInternal({
      name: value.name,
      message: value.message
    }, state, depth, key);
  }
  if (!consumeSerializationBudget(state, 1, 2)) {
    return SERIALIZATION_EXHAUSTED;
  }
  state.seen.add(value);

  if (Array.isArray(value)) {
    const result = [];
    const start = Math.max(0, value.length - GENERAL_ARRAY_LIMIT);
    for (let index = start; index < value.length; index += 1) {
      const checkpoint = serializationBudgetCheckpoint(state);
      const item = serializeDiagnosticValueInternal(
        value[index],
        state,
        depth + 1,
        key
      );
      if (
        item === SERIALIZATION_EXHAUSTED ||
        state.exhausted ||
        !consumeSerializationBudget(state, 0, result.length === 0 ? 0 : 1)
      ) {
        restoreSerializationBudget(state, checkpoint);
        break;
      }
      result.push(item);
    }
    state.seen.delete(value);
    return result;
  }

  const result = Object.create(null);
  let keyCount = 0;
  let resultEntryCount = 0;
  for (const sourceKey in value) {
    if (keyCount >= GENERAL_OBJECT_KEY_LIMIT) break;
    keyCount += 1;
    if (!Object.hasOwn(value, sourceKey)) continue;
    const safeKey = boundedDiagnosticKey(sourceKey);
    const checkpoint = serializationBudgetCheckpoint(state);
    let item;
    try {
      item = serializeDiagnosticValueInternal(
        value[sourceKey],
        state,
        depth + 1,
        sourceKey
      );
    } catch (error) {
      item = serializeDiagnosticValueInternal(
        `[serialization failed: ${errorMessage(error)}]`,
        state,
        depth + 1,
        sourceKey
      );
    }
    const entryBytes = jsonByteLength(safeKey) + 1 +
      (resultEntryCount === 0 ? 0 : 1);
    if (
      item === SERIALIZATION_EXHAUSTED ||
      state.exhausted ||
      !consumeSerializationBudget(state, 0, entryBytes)
    ) {
      restoreSerializationBudget(state, checkpoint);
      break;
    }
    result[safeKey] = item;
    resultEntryCount += 1;
  }
  state.seen.delete(value);
  return result;
}

function serializeDiagnosticScalar(value, state) {
  return consumeSerializationBudget(state, 1, jsonByteLength(value))
    ? value
    : SERIALIZATION_EXHAUSTED;
}

function consumeSerializationBudget(state, nodes, bytes) {
  if (
    state.exhausted ||
    state.remainingNodes < nodes ||
    state.remainingBytes < bytes
  ) {
    state.exhausted = true;
    return false;
  }
  state.remainingNodes -= nodes;
  state.remainingBytes -= bytes;
  return true;
}

function serializationBudgetCheckpoint(state) {
  return Object.freeze({
    remainingBytes: state.remainingBytes,
    remainingNodes: state.remainingNodes
  });
}

function restoreSerializationBudget(state, checkpoint) {
  state.remainingBytes = checkpoint.remainingBytes;
  state.remainingNodes = checkpoint.remainingNodes;
  state.exhausted = true;
}

function jsonByteLength(value) {
  return JSON_TEXT_ENCODER.encode(JSON.stringify(value)).byteLength;
}

function isDiagnosticRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error) {
  return boundedDiagnosticText(
    error instanceof Error ? error.message : String(error)
  );
}

function createBoundedQueue(limit) {
  const storage = new Array(limit);
  let length = 0;
  let start = 0;
  return Object.freeze({
    get length() {
      return length;
    },

    append(value) {
      if (length < limit) {
        storage[(start + length) % limit] = value;
        length += 1;
        return;
      }
      storage[start] = value;
      start = (start + 1) % limit;
    },

    clear() {
      for (let index = 0; index < length; index += 1) {
        storage[(start + index) % limit] = undefined;
      }
      length = 0;
      start = 0;
    },

    snapshot() {
      const result = new Array(length);
      for (let index = 0; index < length; index += 1) {
        result[index] = storage[(start + index) % limit];
      }
      return result;
    }
  });
}

function boundedArrayTail(value, limit) {
  if (!Array.isArray(value)) return [];
  const length = Math.min(value.length, limit);
  const result = new Array(length);
  const start = value.length - length;
  for (let index = 0; index < length; index += 1) {
    result[index] = value[start + index];
  }
  return result;
}

function diagnosticPageLocation() {
  const url = new URL(location.href);
  const certificationMode = url.searchParams.get("avalCertificationMode");
  const certificationQuery = certificationMode === "forced-h264" ||
    certificationMode === "full-ladder"
    ? `&avalCertificationMode=${certificationMode}`
    : "";
  const query = `?${DIAGNOSTICS_QUERY}=${DIAGNOSTICS_VALUE}` +
    certificationQuery;
  const maximumPathLength = STRING_LIMIT - query.length;
  const pathname = url.pathname.length <= maximumPathLength
    ? url.pathname
    : `${url.pathname.slice(
      0,
      maximumPathLength - TRUNCATION_MARKER.length
    )}${TRUNCATION_MARKER}`;
  return `${pathname}${query}`;
}

function redactDiagnosticText(value) {
  if (
    !value.includes(":") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("?")
  ) return value;
  const withoutUrls = value.replace(
    /(?:(?:[a-z][a-z0-9+.-]*:\/\/)|(?:(?:blob|data|file|filesystem|chrome-extension|moz-extension):)|\/\/)[^\s"'<>]+/giu,
    "[redacted-url]"
  );
  const withoutSensitiveQueries = withoutUrls.includes("?")
    ? withoutUrls.replace(
      /[^\s"'<>]*\?[^\s"'<>]*/gu,
      (candidate) => hasSensitiveQuery(candidate)
        ? "[redacted-url]"
        : candidate
    )
    : withoutUrls;
  return withoutSensitiveQueries
    .replace(
      /(^|[\s([{"'`=,:;])(?:[a-z]:[\\/]|\\\\[^\\/\r\n"'<>()[\]{},;:]+[\\/])[^\r\n"'<>()[\]{},;]+/giu,
      (_match, boundary) => `${boundary}[redacted-path]`
    )
    .replace(
      /(^|[\s([{"'`=,:;])\/(?!\/)[^\r\n"'<>()[\]{},;]+/gu,
      (_match, boundary) => `${boundary}[redacted-path]`
    );
}

function boundedDiagnosticText(value) {
  const inputWasTruncated = value.length > STRING_LIMIT;
  const boundedInput = inputWasTruncated ? value.slice(0, STRING_LIMIT) : value;
  const redacted = redactDiagnosticText(boundedInput);
  if (!inputWasTruncated && redacted.length <= STRING_LIMIT) return redacted;
  const maximumTextLength = STRING_LIMIT - TRUNCATION_MARKER.length;
  return `${redacted.slice(0, maximumTextLength)}${TRUNCATION_MARKER}`;
}

function boundedDiagnosticKey(value) {
  const boundedInput = value.length > STRING_LIMIT
    ? value.slice(0, STRING_LIMIT)
    : value;
  return hasSensitiveQuery(`?${boundedInput}`)
    ? REDACTED_SENSITIVE_KEY
    : boundedDiagnosticText(value);
}

function hasSensitiveQuery(candidate) {
  const queryStart = candidate.indexOf("?");
  if (queryStart < 0) return false;
  const encodedQuery = candidate.slice(queryStart + 1);
  let decodedQuery = encodedQuery;
  try {
    decodedQuery = decodeURIComponent(encodedQuery.replace(/\+/gu, "%20"));
  } catch {
    // The encoded form is still checked when malformed input cannot be decoded.
  }
  return queryHasSensitiveParameter(encodedQuery) ||
    queryHasSensitiveParameter(decodedQuery);
}

function queryHasSensitiveParameter(query) {
  let start = 0;
  while (start <= query.length) {
    const ampersand = query.indexOf("&", start);
    const semicolon = query.indexOf(";", start);
    const end = ampersand < 0
      ? semicolon < 0 ? query.length : semicolon
      : semicolon < 0 ? ampersand : Math.min(ampersand, semicolon);
    const equals = query.indexOf("=", start);
    if (equals >= start && equals < end) {
      const name = query.slice(start, equals);
      if (isSensitiveQueryParameterName(name)) return true;
    }
    if (end === query.length) break;
    start = end + 1;
  }
  return false;
}

function isSensitiveQueryParameterName(name) {
  const normalized = name.replace(/[^a-z0-9]/giu, "").toLowerCase()
    .replace(/^x(?:amz|goog)/u, "");
  return /(?:accesstoken|apikey|auth|authorization|clientsecret|credential|expires|keypairid|password|secret|securitytoken|sig|signature|signedheaders|token)$/u
    .test(normalized);
}

function isSensitiveDiagnosticValue(key, value) {
  if (typeof key !== "string") return false;
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (
    /(?:authorization|cookie|credential|etag|headers?|integrity|password|passwd|passphrase|responsetext|secret|token|apikey|accesskey)/u
      .test(normalized)
  ) return true;
  if (/(?:sourcebytes|body|payload)$/u.test(normalized)) return true;
  if (normalized === "bytes") return !isNumericByteCounterRecord(value);
  return /(?:arraybuffer|binarydata|bytearray|encodedchunk|rawbytes|sourcebuffer|sourcechunk|sourcedata|typedarray|uint8array)$/u
    .test(normalized);
}

function isNumericByteCounterRecord(value) {
  if (!isDiagnosticRecord(value)) return false;
  let count = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    count += 1;
    const entry = value[key];
    if (!Number.isSafeInteger(entry) || entry < 0) return false;
  }
  return count > 0 && count <= GENERAL_OBJECT_KEY_LIMIT;
}

function isBinaryDiagnosticValue(value) {
  if (typeof value !== "object" || value === null) return false;
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return true;
  if (typeof Blob === "function" && value instanceof Blob) return true;
  if (typeof ImageData === "function" && value instanceof ImageData) return true;
  if (typeof VideoFrame === "function" && value instanceof VideoFrame) return true;
  return typeof EncodedVideoChunk === "function" &&
    value instanceof EncodedVideoChunk;
}

function isStackDiagnosticKey(key) {
  if (typeof key !== "string") return false;
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return /(?:callstack|stack|stackframes|stacktrace)$/u.test(normalized);
}

function isLocationDiagnosticKey(key) {
  if (typeof key !== "string") return false;
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  // Renderer diagnostics use this field for the semantic upload strategy
  // ("native" or "rgba-copy"), not for a filesystem or network location.
  if (normalized === "uploadpath") return false;
  return /(?:file|filename|href|path|pathname|src|uri|url)$/u.test(normalized);
}

function roundMilliseconds(value) {
  return Math.round(value * 1_000) / 1_000;
}
