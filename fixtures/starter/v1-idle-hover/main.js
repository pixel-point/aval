const player = document.querySelector("#motion");
const unavailable = document.querySelector("#motion-unavailable");
if (!(player instanceof HTMLElement) || !(unavailable instanceof HTMLImageElement)) {
  throw new Error("starter markup is incomplete");
}
player.addEventListener("error", (event) => {
  const diagnostics = player.getDiagnostics();
  if (
    event.detail.fatal === true &&
    player.readiness === "error" &&
    diagnostics.lastFailure !== null &&
    event.detail.failure === diagnostics.lastFailure
  ) {
    unavailable.hidden = false;
  }
});
player.addEventListener("readinesschange", () => {
  if (player.readiness === "interactiveReady") unavailable.hidden = true;
});

try {
  const response = await fetch("./motion/build.json");
  if (!response.ok) throw new Error(`could not load motion/build.json (${response.status})`);
  const report = await response.json();
  if (!report || report.reportVersion !== "1.0" || !Array.isArray(report.assets)) {
    throw new Error("motion/build.json is not an AVAL build report 1.0");
  }
  const assets = new Map(report.assets.map((asset) => [asset.codec, asset]));
  const sources = player.querySelectorAll(":scope > source[data-aval-codec]");
  for (const source of sources) {
    const codec = source.getAttribute("data-aval-codec");
    const asset = assets.get(codec);
    if (
      !asset || asset.path !== `${codec}.avl` ||
      typeof asset.type !== "string" || typeof asset.integrity !== "string"
    ) {
      throw new Error(`motion/build.json is missing the ${codec} source`);
    }
    source.setAttribute("src", `./motion/${asset.path}`);
    source.setAttribute("type", asset.type);
    source.setAttribute("integrity", asset.integrity);
    source.removeAttribute("data-aval-codec");
  }
} catch (error) {
  unavailable.hidden = false;
  console.error("AVAL starter source setup failed.", error);
}

await import("@pixel-point/aval-element/auto");
