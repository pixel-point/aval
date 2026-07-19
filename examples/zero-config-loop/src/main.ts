import { defineAvalElement } from "@pixel-point/aval-element";

const motion = document.querySelector("#motion");
const unavailable = document.querySelector<HTMLImageElement>("#motion-unavailable");
if (!(motion instanceof HTMLElement) || unavailable === null) {
  throw new Error("example markup is incomplete");
}
motion.addEventListener("error", (event) => {
  if (event.detail.fatal) unavailable.hidden = false;
});
motion.addEventListener("readinesschange", () => {
  if (motion.readiness === "interactiveReady") unavailable.hidden = true;
});
defineAvalElement();
