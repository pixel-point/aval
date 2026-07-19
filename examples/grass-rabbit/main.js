import { defineAvalElement } from "@pixel-point/aval-element";

import { avalBrowserDiagnostics } from "../support/aval-browser-diagnostics.js";

const motion = document.querySelector("#grass-rabbit");
const stateLabel = document.querySelector("#rabbit-state");
const interactionHotspot = document.querySelector(".interaction-hotspot");
const prefersReducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (motion instanceof HTMLElement) {
  avalBrowserDiagnostics?.attach(motion, {
    example: "grass-rabbit",
    role: "primary-motion"
  });
}

const renderedReadiness = new Set([
  "visualReady",
  "interactiveReady"
]);

function reflectRenderedMotion() {
  if (!motion) return;
  if (!renderedReadiness.has(motion.readiness)) {
    delete motion.dataset.rendered;
    interactionHotspot?.classList.remove("is-rendered");
    return;
  }

  requestAnimationFrame(() => {
    if (!renderedReadiness.has(motion.readiness)) return;
    motion.dataset.rendered = "";
    interactionHotspot?.classList.add("is-rendered");
  });
}

motion?.addEventListener("readinesschange", reflectRenderedMotion);
reflectRenderedMotion();

function setStateLabel(state) {
  if (!stateLabel || typeof state !== "string") return;
  if (stateLabel.textContent?.trim() === state) return;

  if (!stateLabel.hasAttribute("data-visible") || prefersReducedMotion) {
    stateLabel.textContent = state;
    stateLabel.style.width = "max-content";
    return;
  }

  const currentWidth = stateLabel.getBoundingClientRect().width;
  stateLabel.style.width = "max-content";
  stateLabel.textContent = state;
  const nextWidth = stateLabel.getBoundingClientRect().width;

  stateLabel.style.width = `${currentWidth}px`;
  stateLabel.getBoundingClientRect();
  stateLabel.style.width = `${nextWidth}px`;
}

function currentPresentation() {
  if (!motion) return null;
  const trace = motion.getDiagnostics({ trace: true }).runtimeTrace ?? [];
  return trace.at(-1)?.graph?.presentation ?? null;
}

function trackInitialPresentation() {
  if (motion?.readiness !== "interactiveReady") return;
  const presentation = currentPresentation();
  if (presentation?.kind === "intro") {
    setStateLabel("intro");
    requestAnimationFrame(trackInitialPresentation);
    return;
  }

  setStateLabel(presentation?.state ?? motion?.visualState);
}

motion?.addEventListener("readinesschange", () => {
  if (motion.readiness === "interactiveReady") {
    requestAnimationFrame(trackInitialPresentation);
  }
});
motion?.addEventListener("visualstatechange", (event) => {
  setStateLabel(event.detail.to);
});

motion?.addEventListener("error", (event) => {
  if (event.detail.fatal !== true) return;
  console.error("Grass rabbit runtime failure", event.detail.failure);
});

function revealStateBadge() {
  if (stateLabel) stateLabel.dataset.visible = "";
}

function dismissInteractionHotspot() {
  if (!interactionHotspot) {
    revealStateBadge();
    return;
  }

  const hotspotStyle = getComputedStyle(interactionHotspot);
  const hotspotIsVisible = hotspotStyle.display !== "none" &&
    hotspotStyle.visibility === "visible" &&
    Number.parseFloat(hotspotStyle.opacity) > 0;
  if (hotspotIsVisible && !prefersReducedMotion) {
    const revealAfterFade = (event) => {
      if (event.target !== interactionHotspot || event.propertyName !== "opacity") return;
      interactionHotspot.removeEventListener("transitionend", revealAfterFade);
      revealStateBadge();
    };
    interactionHotspot.addEventListener("transitionend", revealAfterFade);
  } else {
    revealStateBadge();
  }

  interactionHotspot.classList.add("is-dismissed");
}

function armInteractionHotspot() {
  motion?.addEventListener("pointerenter", dismissInteractionHotspot, { once: true });
}

if (motion?.matches(":hover")) {
  motion.addEventListener("pointerleave", armInteractionHotspot, { once: true });
} else {
  armInteractionHotspot();
}

defineAvalElement();
