import { Renderer } from "./modules/element/renderer.js";
import { RendererFailureError } from "./modules/element/renderer-diagnostics.js";

const MODES = Object.freeze([
  "production",
  "without-desynchronized",
  "browser-defaults"
]);
const CASES = Object.freeze({
  "packed-alpha-48x104": Object.freeze({
    id: "packed-alpha-48x104",
    canvas: Object.freeze({ width: 48, height: 48 }),
    layout: Object.freeze({
      codedWidth: 48,
      codedHeight: 104,
      storageWidth: 48,
      storageHeight: 104,
      logicalWidth: 48,
      logicalHeight: 48,
      pixelAspect: Object.freeze([1, 1]),
      colorRect: Object.freeze([0, 0, 48, 48]),
      alphaRect: Object.freeze([0, 56, 48, 48])
    })
  }),
  "opaque-1280x720": Object.freeze({
    id: "opaque-1280x720",
    canvas: Object.freeze({ width: 1280, height: 720 }),
    layout: Object.freeze({
      codedWidth: 1280,
      codedHeight: 720,
      storageWidth: 1280,
      storageHeight: 720,
      logicalWidth: 1280,
      logicalHeight: 720,
      pixelAspect: Object.freeze([1, 1]),
      colorRect: Object.freeze([0, 0, 1280, 720])
    })
  })
});
const PRODUCTION_ATTRIBUTES = Object.freeze({
  alpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  desynchronized: true,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false
});
const MAX_JSON_BYTES = 32 * 1024;
const statusNode = requireElement("renderer-status");
const resultsNode = requireElement("renderer-results");
const jsonNode = requireElement("renderer-json");
const canvasHost = requireElement("renderer-canvases");

let latest = createReport("running", null, [], null);
const ready = run().catch((reason) => {
  latest = createReport("error", null, [], boundedException(reason));
  render(latest);
  return latest;
});
const api = Object.freeze({
  ready,
  report() { return latest; }
});
Object.defineProperty(window, "avalRendererIsolator", {
  value: api,
  configurable: false,
  enumerable: false,
  writable: false
});
render(latest);

async function run() {
  const selectedCase = parseCase(location.search);
  const results = [];
  for (const mode of MODES) {
    // Yield between probes so context loss from the previous fresh canvas can
    // be observed before the next production constructor runs.
    results.push(runMode(selectedCase, mode));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  latest = createReport("complete", selectedCase, results, null);
  render(latest);
  return latest;
}

function runMode(selectedCase, mode) {
  const canvas = document.createElement("canvas");
  canvas.width = selectedCase.canvas.width;
  canvas.height = selectedCase.canvas.height;
  canvas.dataset.rendererMode = mode;
  canvasHost.append(canvas);

  let renderer = null;
  let context = null;
  let rendererRequestedAttributes = null;
  let forwardedAttributes = null;
  let returnedAttributes = null;
  let capabilities = null;
  let rendererSnapshot = null;
  let diagnostic = null;
  let status = "failure";
  const nativeGetContext = HTMLCanvasElement.prototype.getContext;

  Object.defineProperty(canvas, "getContext", {
    configurable: false,
    enumerable: false,
    writable: false,
    value(contextId, attributes) {
      if (contextId !== "webgl2") {
        return nativeGetContext.call(canvas, contextId, attributes);
      }
      rendererRequestedAttributes = normalizeContextAttributes(attributes);
      forwardedAttributes = forwardedForMode(mode, attributes);
      context = nativeGetContext.call(
        canvas,
        "webgl2",
        forwardedAttributes === null ? undefined : forwardedAttributes
      );
      return context;
    }
  });

  try {
    renderer = new Renderer(canvas, selectedCase.layout, {
      initialPresentation: Object.freeze({
        width: selectedCase.canvas.width,
        height: selectedCase.canvas.height,
        dpr: 1,
        fit: "contain"
      })
    });
    rendererSnapshot = boundedRendererSnapshot(renderer.snapshot());
    status = "success";
  } catch (reason) {
    diagnostic = reason instanceof RendererFailureError
      ? reason.diagnostic
      : boundedUnexpectedRendererFailure(reason);
  }

  if (context !== null) {
    returnedAttributes = readContextAttributes(context);
    capabilities = readCapabilities(context);
  }

  let extensionAvailable = false;
  let releaseRequested = false;
  try { renderer?.dispose(); }
  catch { /* The constructor/result evidence remains authoritative. */ }
  if (context !== null) {
    try {
      const extension = context.getExtension("WEBGL_lose_context");
      extensionAvailable = extension !== null;
      if (extension !== null) {
        extension.loseContext();
        releaseRequested = true;
      }
    } catch { /* Report the unavailable release below. */ }
  }
  canvas.remove();

  return deepFreeze({
    mode,
    status,
    case: selectedCase.id,
    layout: selectedCase.layout,
    context: {
      rendererRequestedAttributes,
      forwardedAttributes,
      returnedAttributes
    },
    capabilities,
    rendererSnapshot,
    diagnostic,
    release: {
      extensionAvailable,
      requested: releaseRequested
    }
  });
}

function parseCase(search) {
  const params = new URLSearchParams(search);
  const entries = [...params.entries()];
  if (entries.length === 0) return CASES["packed-alpha-48x104"];
  if (entries.length !== 1 || entries[0][0] !== "case") {
    throw new TypeError("The renderer isolator accepts only one case parameter.");
  }
  const value = entries[0][1];
  if (!Object.hasOwn(CASES, value)) {
    throw new TypeError("The requested renderer case is not supported.");
  }
  return CASES[value];
}

function forwardedForMode(mode, attributes) {
  if (mode === "browser-defaults") return null;
  const source = attributes !== null && typeof attributes === "object"
    ? attributes
    : PRODUCTION_ATTRIBUTES;
  const forwarded = {};
  for (const [key, value] of Object.entries(source)) {
    if (mode === "without-desynchronized" && key === "desynchronized") continue;
    forwarded[key] = value;
  }
  return Object.freeze(forwarded);
}

function normalizeContextAttributes(value) {
  if (value === null || typeof value !== "object") return null;
  return Object.freeze({
    alpha: booleanOrNull(value.alpha),
    antialias: booleanOrNull(value.antialias),
    depth: booleanOrNull(value.depth),
    desynchronized: booleanOrNull(value.desynchronized),
    failIfMajorPerformanceCaveat: booleanOrNull(value.failIfMajorPerformanceCaveat),
    powerPreference: powerPreferenceOrNull(value.powerPreference),
    premultipliedAlpha: booleanOrNull(value.premultipliedAlpha),
    preserveDrawingBuffer: booleanOrNull(value.preserveDrawingBuffer),
    stencil: booleanOrNull(value.stencil),
    xrCompatible: booleanOrNull(value.xrCompatible)
  });
}

function readContextAttributes(gl) {
  try { return normalizeContextAttributes(gl.getContextAttributes()); }
  catch { return null; }
}

function readCapabilities(gl) {
  const viewport = readParameter(gl, gl.MAX_VIEWPORT_DIMS);
  const debug = readExtension(gl, "WEBGL_debug_renderer_info");
  const vendorToken = numberOrNull(debug?.UNMASKED_VENDOR_WEBGL);
  const rendererToken = numberOrNull(debug?.UNMASKED_RENDERER_WEBGL);
  return deepFreeze({
    maxTextureSize: positiveIntegerOrNull(readParameter(gl, gl.MAX_TEXTURE_SIZE)),
    maxArrayTextureLayers: positiveIntegerOrNull(
      readParameter(gl, gl.MAX_ARRAY_TEXTURE_LAYERS)
    ),
    maxViewportDimensions: Object.freeze([
      positiveIntegerOrNull(viewport?.[0]),
      positiveIntegerOrNull(viewport?.[1])
    ]),
    vendor: boundedDeviceText(readParameter(gl, gl.VENDOR)),
    renderer: boundedDeviceText(readParameter(gl, gl.RENDERER)),
    unmaskedVendor: vendorToken === null
      ? null : boundedDeviceText(readParameter(gl, vendorToken)),
    unmaskedRenderer: rendererToken === null
      ? null : boundedDeviceText(readParameter(gl, rendererToken)),
    glError: readGlError(gl),
    contextLost: readContextLost(gl)
  });
}

function boundedRendererSnapshot(value) {
  const backend = value.backendDetails;
  const webgl = backend?.kind === "webgl2" ? backend : null;
  return deepFreeze({
    backend: backend?.kind === "canvas2d" ? "canvas2d" : "webgl2",
    backingWidth: safeNonNegativeInteger(value.backingWidth),
    backingHeight: safeNonNegativeInteger(value.backingHeight),
    stagingBytes: safeNonNegativeInteger(value.stagingBytes),
    textureBytes: safeNonNegativeInteger(value.textureBytes),
    runtimeBytes: safeNonNegativeInteger(value.runtimeBytes),
    uploadMode: webgl?.uploadMode ??
      (backend?.kind === "canvas2d" ? "rgba-copy" : null),
    nativeProbeAttempts: safeNonNegativeInteger(webgl?.nativeProbeAttempts),
    probeReadbackBytes: safeNonNegativeInteger(webgl?.probeReadbackBytes),
    resourceCount: safeNonNegativeInteger(value.resourceCount),
    contextListenerCount: safeNonNegativeInteger(value.contextListenerCount),
    failure: value.failure
  });
}

function boundedUnexpectedRendererFailure(reason) {
  return deepFreeze({
    phase: "unexpected",
    exception: boundedException(reason)
  });
}

function boundedException(reason) {
  let name = "Error";
  let message = "Renderer isolator failed.";
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

function createReport(status, selectedCase, results, failure) {
  return deepFreeze({
    schemaVersion: "1.0",
    kind: "aval-renderer-isolator",
    status,
    case: selectedCase?.id ?? null,
    environment: {
      userAgent: cleanText(navigator.userAgent, 256),
      platform: cleanText(navigator.platform, 64),
      devicePixelRatio: finiteOrNull(devicePixelRatio)
    },
    modes: results,
    failure
  });
}

function render(report) {
  statusNode.dataset.state = report.status;
  statusNode.textContent = report.status === "running"
    ? "Running three fresh-canvas production renderer probes…"
    : report.status === "complete"
      ? "Renderer probes complete."
      : report.failure?.message ?? "Renderer probes failed.";
  resultsNode.replaceChildren(...report.modes.map((result) => {
    const article = document.createElement("article");
    article.dataset.mode = result.mode;
    article.dataset.status = result.status;
    const heading = document.createElement("h2");
    heading.textContent = result.mode;
    const summary = document.createElement("p");
    summary.textContent = result.status === "success"
      ? `Production initialization completed (${result.rendererSnapshot?.backend ?? "unknown"}).`
      : `Failed in ${result.diagnostic?.phase ?? "an unknown phase"}.`;
    article.append(heading, summary);
    return article;
  }));
  const json = JSON.stringify(report, null, 2);
  if (new TextEncoder().encode(json).byteLength > MAX_JSON_BYTES) {
    throw new RangeError("Renderer isolator JSON exceeded its fixed byte limit.");
  }
  jsonNode.textContent = json;
}

function readParameter(gl, token) {
  try { return gl.getParameter(token); }
  catch { return null; }
}

function readExtension(gl, name) {
  try { return gl.getExtension(name); }
  catch { return null; }
}

function readGlError(gl) {
  try {
    const value = gl.getError();
    return Number.isSafeInteger(value) && value !== gl.NO_ERROR ? value : null;
  } catch { return null; }
}

function readContextLost(gl) {
  try { return gl.isContextLost() === true; }
  catch { return false; }
}

function booleanOrNull(value) { return typeof value === "boolean" ? value : null; }
function powerPreferenceOrNull(value) {
  return value === "default" || value === "high-performance" || value === "low-power"
    ? value : null;
}
function numberOrNull(value) { return typeof value === "number" ? value : null; }
function positiveIntegerOrNull(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}
function safeNonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
function finiteOrNull(value) { return Number.isFinite(value) ? value : null; }
function boundedDeviceText(value) {
  return typeof value === "string" && value.length > 0 ? cleanText(value, 128) : null;
}
function cleanText(value, limit) {
  return String(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ")
    .trim()
    .slice(0, limit);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireElement(id) {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing #${id}.`);
  return element;
}
