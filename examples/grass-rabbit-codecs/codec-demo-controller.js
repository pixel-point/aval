import { createSourceSupportProbe } from "@pixel-point/aval-player-web";
import { AvalPlaybackError } from "@pixel-point/aval-element";

import {
  BT709_LIMITED,
  CODECS,
  INACTIVE_PLAYBACK_MESSAGE,
  PLAYBACK_FAILURE_MESSAGE,
  RENDERED_READINESS,
  UNAVAILABLE_MESSAGE,
  UNSUPPORTED_MESSAGE,
  assertCodec,
  codecLabel,
  parseGrassRabbitReport,
  requireMapValue
} from "./codec-demo-model.js";
import {
  bindPlayerPresentation,
  failureCode,
  reflectPlayerRenderedState
} from "./codec-player-presentation.js";

export function createCodecDemoController({
  view,
  reportUrl,
  publicBaseUrl,
  prefersReducedMotion,
  simulatedUnsupported,
  diagnostics = null
}) {
  const support = new Map(CODECS.map((codec) => [codec, "unavailable"]));
  let report = null;
  let activePlayerValue = null;
  let activationSerial = 0;
  let explicitActivationRequested = false;
  let latestActivation = Promise.resolve();
  let retirementTail = Promise.resolve();

  view.bindTabs((codec) => requestActivation(codec, true));
  const setup = initialize();
  const ready = setup.then(async () => {
    if (!explicitActivationRequested) {
      const firstSupported = CODECS.find(
        (codec) => requireMapValue(support, codec) === "supported"
      );
      await requestActivation(firstSupported ?? "av1", false);
    }
    await waitForLatestActivation();
  });

  const api = Object.freeze({
    ready,
    activate(codec) {
      return requestActivation(codec, true);
    },
    supportSnapshot() {
      return Object.freeze(Object.fromEntries(CODECS.map((codec) => [
        codec,
        requireMapValue(support, codec)
      ])));
    },
    get activePlayer() {
      return activePlayerValue;
    }
  });
  void ready.catch(() => undefined);
  return api;

  async function initialize() {
    try {
      report = parseGrassRabbitReport(await fetchBuildReport(reportUrl));
      view.renderBuildDetails(report);
    } catch (error) {
      publishAllSupportStates();
      view.renderReportFailure();
      throw error;
    }
    await probeAllCodecs(report, support, simulatedUnsupported);
    publishAllSupportStates();
    publishProbeSummary();
  }

  function requestActivation(codec, explicit) {
    assertCodec(codec);
    diagnostics?.checkpoint(
      `before:codec-activation:${codec}`,
      activePlayerValue ?? undefined
    );
    if (explicit) explicitActivationRequested = true;
    const serial = ++activationSerial;
    view.selectTab(codec);
    const operation = activateAfterSetup(codec, serial);
    latestActivation = operation;
    return operation;
  }

  async function waitForLatestActivation() {
    let observed;
    do {
      observed = latestActivation;
      await observed;
    } while (observed !== latestActivation);
  }

  async function activateAfterSetup(codec, serial) {
    await setup;
    if (serial !== activationSerial) return;
    await retireActivePlayer();
    if (serial !== activationSerial) return;

    const parts = view.parts(codec);
    view.reset(codec);
    const state = requireMapValue(support, codec);
    if (state === "unsupported") {
      view.setMessage(codec, UNSUPPORTED_MESSAGE, "unsupported");
      return;
    }
    if (state === "unavailable" || report === null) {
      view.setMessage(codec, UNAVAILABLE_MESSAGE);
      return;
    }

    const asset = requireMapValue(report.assets, codec);
    const player = createPlayer(codec, asset);
    const hotspot = view.createHotspot();
    const isCurrent = () => serial === activationSerial && activePlayerValue === player;
    const finishPreparedActivation = () => {
      if (
        !isCurrent() ||
        player.readiness !== "interactiveReady"
      ) return;
      parts.stage.dataset.state = "ready";
      parts.stage.removeAttribute("aria-busy");
      parts.message.textContent = "";
      reflectPlayerRenderedState(player, hotspot, isCurrent);
    };
    const settlePendingActivation = (message) => {
      if (!isCurrent()) return;
      parts.stage.removeAttribute("aria-busy");
      parts.stage.dataset.state = "pending";
      parts.message.textContent = message;
    };
    player.addEventListener("readinesschange", () => {
      if (player.readiness === "interactiveReady") {
        finishPreparedActivation();
      } else if (player.readiness === "staticReady") {
        settlePendingActivation(INACTIVE_PLAYBACK_MESSAGE);
      }
    });
    bindPlayerPresentation({
      player,
      hotspot,
      parts,
      isCurrent,
      prefersReducedMotion,
      onFailure: (kind) => finishFailedActivation(codec, player, parts, serial, kind)
    });
    parts.mount.replaceChildren(player, hotspot);
    parts.message.textContent = "Preparing this codec…";
    parts.stage.dataset.state = "preparing";
    parts.stage.setAttribute("aria-busy", "true");
    activePlayerValue = player;

    try {
      diagnostics?.checkpoint(`before:codec-prepare:${codec}`, player);
      const preparation = await player.prepare({ timeoutMs: 30_000 });
      diagnostics?.checkpoint(`after:codec-prepare:${codec}`, player);
      if (!isCurrent()) return;
      if (preparation?.mode === "static" || player.readiness === "staticReady") {
        settlePendingActivation(INACTIVE_PLAYBACK_MESSAGE);
        return;
      }
      finishPreparedActivation();
    } catch (error) {
      diagnostics?.checkpoint(`error:codec-prepare:${codec}`, player);
      if (!isCurrent()) return;
      if (!(error instanceof AvalPlaybackError)) {
        if (!isPreparationInterruption(error)) throw error;
        if (player.readiness === "interactiveReady") {
          finishPreparedActivation();
          return;
        }
        settlePendingActivation("Preparation is continuing in the background…");
        return;
      }
      const failureKind = failureCode(error) === "unsupported-profile"
        ? "unsupported"
        : "playback";
      await finishFailedActivation(codec, player, parts, serial, failureKind);
    }
  }

  function createPlayer(codec, asset) {
    const player = document.createElement("aval-player");
    player.className = "rabbit-player";
    player.setAttribute("width", "640");
    player.setAttribute("height", "360");
    player.setAttribute("autoplay", "visible");
    player.setAttribute("tabindex", "0");
    player.setAttribute(
      "aria-label",
      `Interactive grass rabbit animation encoded with ${codecLabel(codec)}. Hover or focus to change its state.`
    );
    const source = document.createElement("source");
    source.src = new URL(`grass-rabbit/${asset.path}`, publicBaseUrl).href;
    source.type = asset.type;
    source.setAttribute("integrity", asset.integrity);
    player.append(source);
    diagnostics?.attach(player, {
      example: "grass-rabbit-codecs",
      codec,
      sourceType: asset.type
    });
    return player;
  }

  async function finishFailedActivation(codec, player, parts, serial, kind) {
    if (serial !== activationSerial || activePlayerValue !== player) return;
    if (kind === "unsupported") {
      support.set(codec, "unsupported");
      view.renderSupport(codec, "unsupported");
      publishProbeSummary();
      parts.stage.removeAttribute("aria-busy");
    }
    await retireActivePlayer();
    if (activePlayerValue === null || !parts.mount.contains(activePlayerValue)) {
      parts.mount.replaceChildren();
    }
    if (serial !== activationSerial) return;
    parts.stage.removeAttribute("aria-busy");
    if (kind === "unsupported") return;
    parts.stage.dataset.runtimeError = "true";
    parts.stage.dataset.state = "error";
    parts.message.textContent = PLAYBACK_FAILURE_MESSAGE;
  }

  async function retireActivePlayer() {
    const previous = activePlayerValue;
    activePlayerValue = null;
    const priorRetirement = retirementTail;
    retirementTail = (async () => {
      await priorRetirement.catch(() => undefined);
      if (previous === null) return;
      try {
        diagnostics?.checkpoint("before:codec-player-dispose", previous);
        await previous.dispose();
        diagnostics?.checkpoint("after:codec-player-dispose", previous);
      } finally {
        previous.remove();
      }
    })();
    await retirementTail.catch(() => undefined);
  }

  function publishAllSupportStates() {
    for (const codec of CODECS) view.renderSupport(codec, requireMapValue(support, codec));
  }

  function publishProbeSummary() {
    const supportedCount = CODECS.filter(
      (codec) => requireMapValue(support, codec) === "supported"
    ).length;
    view.renderSupportSummary(supportedCount);
  }
}

async function fetchBuildReport(reportUrl) {
  const response = await fetch(reportUrl, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Codec build report request failed (${String(response.status)}).`);
  }
  return response.json();
}

async function probeAllCodecs(report, support, simulatedUnsupported) {
  for (const codec of simulatedUnsupported) support.set(codec, "unsupported");
  const candidates = CODECS.filter((codec) => !simulatedUnsupported.has(codec));
  if (candidates.length === 0) return;

  let owner;
  try {
    owner = createSourceSupportProbe();
  } catch {
    return;
  }
  try {
    for (let index = 0; index < candidates.length; index += 1) {
      const codec = candidates[index];
      try {
        const asset = requireMapValue(report.assets, codec);
        const result = await owner.probe(exactProbeConfig(asset.codecString));
        support.set(codec, result ? "supported" : "unsupported");
      } catch {
        support.set(codec, "unavailable");
        for (const remaining of candidates.slice(index + 1)) {
          support.set(remaining, "unavailable");
        }
        break;
      }
    }
  } finally {
    await owner.dispose().catch(() => undefined);
  }
}

function exactProbeConfig(codec) {
  return Object.freeze({
    codec,
    codedWidth: 1280,
    codedHeight: 720,
    displayAspectWidth: 1280,
    displayAspectHeight: 720,
    colorSpace: BT709_LIMITED
  });
}

function isPreparationInterruption(error) {
  return error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError");
}
