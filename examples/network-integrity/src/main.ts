import { defineAvalElement, type AvalElement } from "@pixel-point/aval-element";

const motion = document.querySelector<AvalElement>("#motion");
const status = document.querySelector<HTMLOutputElement>("#status");
const unavailable = document.querySelector<HTMLImageElement>("#motion-unavailable");
if (motion === null || status === null || unavailable === null) {
  throw new Error("example markup is incomplete");
}

motion.addEventListener("readinesschange", () => {
  status.value = `Readiness: ${motion.readiness}`;
  if (motion.readiness === "interactiveReady") unavailable.hidden = true;
});
motion.addEventListener("error", (event) => {
  if (!event.detail.fatal) return;
  unavailable.hidden = false;
  status.value = "Animation unavailable; the application revealed its image.";
});
defineAvalElement();
