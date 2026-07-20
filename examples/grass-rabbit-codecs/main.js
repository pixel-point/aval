import "@pixel-point/aval-element/auto";

import { avalBrowserDiagnostics } from "../support/aval-browser-diagnostics.js";
import { createCodecDemoController } from "./codec-demo-controller.js";
import { CODECS } from "./codec-demo-model.js";
import { createCodecDemoView } from "./codec-demo-view.js";

const publicBaseUrl = new URL(import.meta.env.BASE_URL, location.href);
const simulatedUnsupported = new Set(
  new URL(location.href).searchParams
    .getAll("simulateUnsupported")
    .filter((codec) => CODECS.includes(codec))
);
const view = createCodecDemoView(new URL("interaction-hotspot.svg", publicBaseUrl));
avalBrowserDiagnostics?.checkpoint("before:codec-demo-controller");
const api = createCodecDemoController({
  view,
  publicBaseUrl,
  reportUrl: new URL("grass-rabbit/build.json", publicBaseUrl),
  simulatedUnsupported,
  prefersReducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
  diagnostics: avalBrowserDiagnostics
});

void api.ready.then(
  () => avalBrowserDiagnostics?.checkpoint(
    "after:codec-demo-ready",
    api.activePlayer ?? undefined
  ),
  () => avalBrowserDiagnostics?.checkpoint(
    "error:codec-demo-ready",
    api.activePlayer ?? undefined
  )
);

Object.defineProperty(window, "grassRabbitCodecs", {
  value: api,
  configurable: false,
  enumerable: false,
  writable: false
});
