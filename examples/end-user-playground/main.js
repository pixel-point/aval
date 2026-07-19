import { defineAvalElement } from "@pixel-point/aval-element";

import { avalBrowserDiagnostics } from "../support/aval-browser-diagnostics.js";
import "./style.css";

const motion = document.querySelector("#favorite-motion");
const favoriteControl = document.querySelector("#favorite-control");
const toggle = document.querySelector("#toggle-state");
const status = document.querySelector("#runtime-status");
const unavailable = document.querySelector("#favorite-unavailable");

if (
  !(motion instanceof HTMLElement) ||
  !(favoriteControl instanceof HTMLButtonElement) ||
  !(toggle instanceof HTMLButtonElement) ||
  !(status instanceof HTMLElement) ||
  !(unavailable instanceof HTMLImageElement)
) {
  throw new Error("The playground markup is incomplete");
}

avalBrowserDiagnostics?.attach(motion, {
  example: "end-user-playground",
  role: "favorite-motion"
});

function renderStatus(message, state = "loading") {
  status.textContent = message;
  status.dataset.status = state;
}

function reflectState(state) {
  const engaged = state === "engaged";
  favoriteControl.setAttribute("aria-pressed", String(engaged));
  toggle.setAttribute("aria-pressed", String(engaged));
}

function settledWithoutFatalFailure() {
  return motion.readiness === "interactiveReady" ||
    motion.readiness === "staticReady";
}

function staticReasonLabel(reason) {
  if (reason === "reduced-motion") return "reduced motion";
  if (reason === "visibility-suspended") return "not visible";
  if (reason === "decoder-queued") return "waiting for a decoder";
  return "browser policy";
}

async function toggleFavorite() {
  const next = motion.visualState === "engaged" ? "idle" : "engaged";
  favoriteControl.disabled = true;
  toggle.disabled = true;
  try {
    await motion.setState(next);
  } catch (error) {
    renderStatus(
      error instanceof Error ? error.message : "The state change failed",
      "error"
    );
  } finally {
    const settled = settledWithoutFatalFailure();
    favoriteControl.disabled = !settled;
    toggle.disabled = !settled;
  }
}

motion.addEventListener("readinesschange", () => {
  if (motion.readiness === "interactiveReady") {
    unavailable.hidden = true;
    const state = motion.visualState ?? "idle";
    reflectState(state);
    renderStatus(`Interactive · ${state}`, "ready");
    favoriteControl.disabled = false;
    toggle.disabled = false;
    return;
  }

  if (motion.readiness === "staticReady") {
    const state = motion.visualState ?? "idle";
    reflectState(state);
    renderStatus(
      `Motion inactive · ${staticReasonLabel(motion.staticReason)}`,
      "policy"
    );
    favoriteControl.disabled = false;
    toggle.disabled = false;
    return;
  }

  renderStatus(`Preparing · ${motion.readiness}`, "loading");
});

motion.addEventListener("visualstatechange", (event) => {
  const state = event.detail.to;
  reflectState(state);
  if (motion.readiness === "interactiveReady") {
    renderStatus(`Interactive · ${state}`, "ready");
  } else if (motion.readiness === "staticReady") {
    renderStatus(
      `Motion inactive · ${staticReasonLabel(motion.staticReason)}`,
      "policy"
    );
  }
});

motion.addEventListener("error", (event) => {
  const diagnostics = motion.getDiagnostics();
  if (
    event.detail.fatal !== true ||
    motion.readiness !== "error" ||
    diagnostics.lastFailure === null ||
    event.detail.failure !== diagnostics.lastFailure
  ) return;
  favoriteControl.disabled = true;
  toggle.disabled = true;
  unavailable.hidden = false;
  renderStatus(`Playback unavailable · ${event.detail.failure.code}`, "error");
});

favoriteControl.addEventListener("click", () => {
  void toggleFavorite();
});

toggle.addEventListener("click", () => {
  void toggleFavorite();
});

defineAvalElement();
