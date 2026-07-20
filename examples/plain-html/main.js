import { defineAvalElement } from "@pixel-point/aval-element";

const motion = document.querySelector("#motion");
const pause = document.querySelector("#pause");
const unavailable = document.querySelector("#motion-unavailable");
motion.addEventListener("error", (event) => {
  if (event.detail.fatal) unavailable.hidden = false;
});
motion.addEventListener("readinesschange", () => {
  if (motion.readiness === "interactiveReady") unavailable.hidden = true;
});
defineAvalElement();
pause.addEventListener("click", () => motion.pause());
