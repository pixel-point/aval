import { defineAvalElement } from "@pixel-point/aval-element";

import { avalBrowserDiagnostics } from "../support/aval-browser-diagnostics.js";

const motion = document.querySelector("#kinetic-orb");
const stateLabel = document.querySelector("[data-state-label]");
const renderedReadiness = new Set(["visualReady", "interactiveReady"]);

if (motion instanceof HTMLElement) {
  avalBrowserDiagnostics?.attach(motion, {
    example: "kinetic-orb",
    role: "primary-motion"
  });
}

function setVisibleState(state) {
  if (!stateLabel || typeof state !== "string" || state.length === 0) return;
  stateLabel.textContent = state;
  document.documentElement.dataset.orbState = state;
}

function currentPresentation() {
  if (!motion) return null;
  const trace = motion.getDiagnostics({ trace: true }).runtimeTrace ?? [];
  return trace.at(-1)?.graph?.presentation ?? null;
}

function trackIntro() {
  if (motion?.readiness !== "interactiveReady") return;
  const presentation = currentPresentation();
  if (presentation?.kind === "intro") {
    setVisibleState("intro");
    requestAnimationFrame(trackIntro);
    return;
  }
  setVisibleState(presentation?.state ?? motion?.visualState ?? "idle");
}

function reflectRenderedMotion() {
  if (!motion) return;
  if (!renderedReadiness.has(motion.readiness)) {
    delete motion.dataset.rendered;
    return;
  }
  requestAnimationFrame(() => {
    if (!renderedReadiness.has(motion.readiness)) return;
    motion.dataset.rendered = "";
  });
}

motion?.addEventListener("readinesschange", () => {
  reflectRenderedMotion();
  if (motion.readiness === "interactiveReady") requestAnimationFrame(trackIntro);
});
motion?.addEventListener("visualstatechange", (event) => setVisibleState(event.detail.to));
motion?.addEventListener("error", (event) => {
  if (event.detail.fatal !== true) return;
  console.error("Kinetic orb runtime failure", event.detail.failure);
  setVisibleState("error");
});

reflectRenderedMotion();
defineAvalElement();
