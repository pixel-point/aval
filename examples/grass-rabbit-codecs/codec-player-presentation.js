import { RENDERED_READINESS, isRecord } from "./codec-demo-model.js";

export function bindPlayerPresentation({
  player,
  hotspot,
  getStateBadge,
  isCurrent,
  onFailure,
  prefersReducedMotion
}) {
  const reflectRendered = () => reflectPlayerRenderedState(
    player,
    hotspot,
    isCurrent
  );
  player.addEventListener("readinesschange", reflectRendered);
  player.addEventListener("readinesschange", () => {
    if (!isCurrent()) return;
    if (player.readiness === "interactiveReady") {
      requestAnimationFrame(() => trackInitialPresentation(
        player,
        getStateBadge(),
        isCurrent
      ));
    }
  });
  player.addEventListener("visualstatechange", (event) => {
    if (isCurrent()) setStateLabel(getStateBadge(), event.detail.to);
  });
  player.addEventListener("error", (event) => {
    if (!isCurrent() || !isRecord(event.detail) || event.detail.fatal !== true) return;
    const kind = failureCode(event.detail) === "unsupported-profile"
      ? "unsupported"
      : "playback";
    void onFailure(kind).catch(() => undefined);
  });

  const dismiss = () => dismissHotspot(
    hotspot,
    getStateBadge(),
    prefersReducedMotion
  );
  const armPointer = () => player.addEventListener("pointerenter", dismiss, { once: true });
  player.addEventListener("focusin", dismiss, { once: true });
  if (player.matches(":hover")) {
    player.addEventListener("pointerleave", armPointer, { once: true });
  } else {
    armPointer();
  }
}

export function reflectPlayerRenderedState(player, hotspot, isCurrent) {
  if (!isCurrent()) return;
  if (!RENDERED_READINESS.has(player.readiness)) {
    delete player.dataset.rendered;
    hotspot.classList.remove("is-rendered");
    return;
  }
  requestAnimationFrame(() => {
    if (!isCurrent() || !RENDERED_READINESS.has(player.readiness)) return;
    player.dataset.rendered = "";
    hotspot.classList.add("is-rendered");
  });
}

export function failureCode(value) {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    if (!isRecord(current)) return null;
    if (typeof current.code === "string") return current.code;
    const nested = current.failure;
    if (nested === current) return null;
    current = nested;
  }
  return null;
}

function trackInitialPresentation(player, stateBadge, isCurrent) {
  if (!isCurrent() || player.readiness !== "interactiveReady") return;
  const trace = player.getDiagnostics({ trace: true }).runtimeTrace ?? [];
  const presentation = trace.at(-1)?.graph?.presentation ?? null;
  if (presentation?.kind === "intro") {
    setStateLabel(stateBadge, "intro");
    requestAnimationFrame(() => trackInitialPresentation(
      player,
      stateBadge,
      isCurrent
    ));
    return;
  }
  setStateLabel(stateBadge, presentation?.state ?? player.visualState);
}

function setStateLabel(badge, state) {
  if (typeof state !== "string" || badge.textContent?.trim() === state) return;
  badge.textContent = state;
}

function dismissHotspot(hotspot, stateBadge, prefersReducedMotion) {
  if (hotspot.classList.contains("is-dismissed")) return;
  const style = getComputedStyle(hotspot);
  const visible = style.display !== "none" &&
    style.visibility === "visible" &&
    Number.parseFloat(style.opacity) > 0;
  if (visible && !prefersReducedMotion) {
    const revealAfterFade = (event) => {
      if (event.target !== hotspot || event.propertyName !== "opacity") return;
      hotspot.removeEventListener("transitionend", revealAfterFade);
      stateBadge.dataset.visible = "";
    };
    hotspot.addEventListener("transitionend", revealAfterFade);
  } else {
    stateBadge.dataset.visible = "";
  }
  hotspot.classList.add("is-dismissed");
}
