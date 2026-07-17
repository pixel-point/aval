import "@pixel-point/aval-element/auto";

const motion = document.querySelector("#kinetic-orb");
const stateLabel = document.querySelector("[data-state-label]");
const renderedReadiness = new Set(["visualReady", "interactiveReady", "staticReady"]);

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
  const presentation = currentPresentation();
  if (presentation?.kind === "intro") {
    setVisibleState("intro");
    requestAnimationFrame(trackIntro);
    return;
  }
  setVisibleState(presentation?.state ?? motion?.visualState ?? "idle");
}

function revealWhenRendered() {
  if (!motion || !renderedReadiness.has(motion.readiness)) return;
  motion.removeEventListener("readinesschange", revealWhenRendered);
  requestAnimationFrame(() => {
    motion.dataset.rendered = "";
  });
}

motion?.addEventListener("readinesschange", () => {
  revealWhenRendered();
  if (motion.readiness === "interactiveReady") requestAnimationFrame(trackIntro);
  if (motion.readiness === "staticReady") setVisibleState(motion.visualState ?? "idle");
});
motion?.addEventListener("visualstatechange", (event) => setVisibleState(event.detail.to));
motion?.addEventListener("error", (event) => {
  console.error("Kinetic orb runtime failure", event.detail.failure);
  setVisibleState("error");
});

revealWhenRendered();
