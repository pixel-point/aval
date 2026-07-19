import { defineAvalElement, type AvalElement } from "@pixel-point/aval-element";

const button = document.querySelector<HTMLButtonElement>("#favorite");
const motion = document.querySelector<AvalElement>("#motion");
const unavailable = document.querySelector<HTMLElement>("#motion-unavailable");
if (button === null || motion === null || unavailable === null) {
  throw new Error("example markup is incomplete");
}
motion.addEventListener("error", (event) => {
  if (!event.detail.fatal) return;
  unavailable.hidden = false;
  button.disabled = true;
});
motion.addEventListener("readinesschange", () => {
  if (motion.readiness !== "interactiveReady") return;
  unavailable.hidden = true;
  button.disabled = false;
});
defineAvalElement();

button.addEventListener("click", () => {
  if (motion.readiness === "error") return;
  const selected = button.getAttribute("aria-pressed") !== "true";
  button.setAttribute("aria-pressed", String(selected));
  void motion.setState(selected ? "selected" : "idle").catch(() => undefined);
});
