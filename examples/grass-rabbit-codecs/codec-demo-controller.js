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
  requireMapValue,
  runtimeCodecFamily
} from "./codec-demo-model.js";
import {
  bindPlayerPresentation,
  failureCode,
  reflectPlayerRenderedState
} from "./codec-player-presentation.js";

const AUTOMATIC_ACTIVATION = Object.freeze({
  kind: "automatic",
  codec: CODECS[0],
  sourceCodecs: CODECS
});

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

  view.bindTabs((codec) => requestActivation(explicitActivation(codec)));
  const setup = initialize();
  const ready = setup.then(async () => {
    if (!explicitActivationRequested) {
      await requestActivation(AUTOMATIC_ACTIVATION);
    }
    await waitForLatestActivation();
  });

  const api = Object.freeze({
    ready,
    activate(codec) {
      return requestActivation(explicitActivation(codec));
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

  function requestActivation(activation) {
    const { codec } = activation;
    diagnostics?.checkpoint(
      `before:codec-activation:${codec}`,
      activePlayerValue ?? undefined
    );
    if (activation.kind === "explicit") explicitActivationRequested = true;
    const serial = ++activationSerial;
    view.selectTab(codec);
    const operation = activateAfterSetup(activation, serial);
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

  async function activateAfterSetup(activation, serial) {
    await setup;
    if (serial !== activationSerial) return;
    await retireActivePlayer();
    if (serial !== activationSerial) return;

    const { codec } = activation;
    let presentation = Object.freeze({ codec, parts: view.parts(codec) });
    view.reset(presentation.codec);
    if (activation.kind === "explicit") {
      const state = requireMapValue(support, codec);
      if (state === "unsupported") {
        view.setMessage(codec, UNSUPPORTED_MESSAGE, "unsupported");
        return;
      }
      if (state === "unavailable") {
        view.setMessage(codec, UNAVAILABLE_MESSAGE);
        return;
      }
    }
    if (report === null) {
      throw new Error("Codec build report is unavailable after setup.");
    }

    const player = createPlayer(activation.sourceCodecs);
    const hotspot = view.createHotspot();
    const isCurrent = () => serial === activationSerial && activePlayerValue === player;
    const finishPreparedActivation = () => {
      if (
        !isCurrent() ||
        player.readiness !== "interactiveReady"
      ) return;
      if (activation.kind === "automatic") reconcileAutomaticSelection();
      presentation.parts.stage.dataset.state = "ready";
      presentation.parts.stage.removeAttribute("aria-busy");
      presentation.parts.message.textContent = "";
      reflectPlayerRenderedState(player, hotspot, isCurrent);
    };
    const settlePendingActivation = (message) => {
      if (!isCurrent()) return;
      presentation.parts.stage.removeAttribute("aria-busy");
      presentation.parts.stage.dataset.state = "pending";
      presentation.parts.message.textContent = message;
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
      getStateBadge: () => presentation.parts.stateBadge,
      isCurrent,
      prefersReducedMotion,
      onFailure(kind) {
        const target = presentation;
        return finishFailedActivation(
          activation,
          target,
          player,
          serial,
          kind
        );
      }
    });
    presentation.parts.mount.replaceChildren(player, hotspot);
    presentation.parts.message.textContent = "Preparing this codec…";
    presentation.parts.stage.dataset.state = "preparing";
    presentation.parts.stage.setAttribute("aria-busy", "true");
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
      const target = presentation;
      await finishFailedActivation(
        activation,
        target,
        player,
        serial,
        failureKind
      );
    }

    function reconcileAutomaticSelection() {
      const selectedCodec = runtimeCodecFamily(
        player.getDiagnostics().runtime.selectedCodec
      );
      if (selectedCodec === presentation.codec) return;
      const previous = presentation;
      const nextParts = view.parts(selectedCodec);
      view.reset(selectedCodec);
      view.selectTab(selectedCodec);
      presentation = Object.freeze({ codec: selectedCodec, parts: nextParts });
      player.setAttribute(
        "aria-label",
        playerAriaLabel(selectedCodec)
      );
      nextParts.mount.replaceChildren(player, hotspot);
      view.reset(previous.codec);
      view.renderSupport(
        previous.codec,
        requireMapValue(support, previous.codec)
      );
    }
  }

  function createPlayer(codecs) {
    const primaryCodec = codecs[0];
    if (primaryCodec === undefined) {
      throw new Error("A codec player requires at least one source.");
    }
    const player = document.createElement("aval-player");
    player.className = "rabbit-player";
    player.setAttribute("width", "640");
    player.setAttribute("height", "360");
    player.setAttribute("autoplay", "visible");
    player.setAttribute("tabindex", "0");
    player.setAttribute("aria-label", playerAriaLabel(primaryCodec));
    for (const codec of codecs) {
      const asset = requireMapValue(report.assets, codec);
      const source = document.createElement("source");
      source.src = new URL(`grass-rabbit/${asset.path}`, publicBaseUrl).href;
      source.setAttribute("data-codec", codec);
      source.setAttribute("integrity", asset.integrity);
      player.append(source);
    }
    diagnostics?.attach(player, {
      example: "grass-rabbit-codecs",
      codec: codecs.length === 1 ? primaryCodec : "automatic-ladder",
      sourceCodec: primaryCodec,
      sourceCodecs: codecs
    });
    return player;
  }

  async function finishFailedActivation(
    activation,
    target,
    player,
    serial,
    kind
  ) {
    if (serial !== activationSerial || activePlayerValue !== player) return;
    const explicitUnsupported = activation.kind === "explicit" &&
      kind === "unsupported";
    if (explicitUnsupported) {
      support.set(target.codec, "unsupported");
      view.renderSupport(target.codec, "unsupported");
      publishProbeSummary();
      target.parts.stage.removeAttribute("aria-busy");
    }
    await retireActivePlayer();
    if (
      activePlayerValue === null ||
      !target.parts.mount.contains(activePlayerValue)
    ) {
      target.parts.mount.replaceChildren();
    }
    if (serial !== activationSerial) return;
    target.parts.stage.removeAttribute("aria-busy");
    if (explicitUnsupported) return;
    target.parts.stage.dataset.runtimeError = "true";
    target.parts.stage.dataset.state = "error";
    target.parts.message.textContent = PLAYBACK_FAILURE_MESSAGE;
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

function playerAriaLabel(codec) {
  return `Interactive grass rabbit animation encoded with ${codecLabel(codec)}. Hover or focus to change its state.`;
}

function explicitActivation(codec) {
  assertCodec(codec);
  return Object.freeze({
    kind: "explicit",
    codec,
    sourceCodecs: Object.freeze([codec])
  });
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
