import { defineAvalAlphaElement, type AvalAlphaElement } from "@pixel-point/aval-alpha/element";
import { type AlphaSource } from "@pixel-point/aval-alpha";
import { runChecks } from "./checks.js";

const host = document.querySelector<AvalAlphaElement>("aval-alpha")!;
const status = document.querySelector<HTMLElement>("#status")!;
const results = document.querySelector<HTMLElement>("#results")!;
host.addEventListener("ready", () => { status.textContent = `Playing ${host.video?.currentSrc.split("/").at(-1)}`; });
host.addEventListener("error", (event: Event) => { status.textContent = `Error: ${(event as CustomEvent<Error>).detail.message}`; });
host.addEventListener("autoplayblocked", () => { status.textContent = "Ready — press Play to start"; });
const { sources } = await (await fetch("/sources.json")).json() as { sources: AlphaSource[] };
function populate(selected: AlphaSource[]) {
  host.replaceChildren(...selected.map((source) => {
    const element = document.createElement("source");
    element.src = source.src; element.type = source.type!;
    element.dataset.layout = [source.width, source.height, ...source.colorRect, ...source.alphaRect].join(" ");
    return element;
  }));
}
populate(sources);
defineAvalAlphaElement();
document.querySelector<HTMLSelectElement>("#codec")!.onchange = (event) => {
  const codec = (event.target as HTMLSelectElement).value;
  status.textContent = "Loading…";
  populate(codec === "all" ? sources : sources.filter((s) => s.src.includes(`/${codec}.`)));
};
document.querySelector<HTMLSelectElement>("#background")!.onchange = (event) => {
  const value = (event.target as HTMLSelectElement).value;
  (document.querySelector(".stage") as HTMLElement).style.background = value === "checker" ? "" : value;
};
const action = (id: string, task: () => unknown) => {
  document.querySelector<HTMLButtonElement>(id)!.onclick = () => { void Promise.resolve().then(task).catch((error: Error) => { status.textContent = error.message; }); };
};
action("#play", () => host.play());
action("#pause", () => host.pause());
action("#seek", () => host.seek(0.5));
action("#check", async () => {
  results.textContent = "Running browser checks…";
  const report = await runChecks(sources);
  results.textContent = JSON.stringify(report, null, 2);
  results.dataset.complete = "true";
});
