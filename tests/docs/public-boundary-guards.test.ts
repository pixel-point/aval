import { describe, expect, it } from "vitest";

import {
  hasAvalHostSrc,
  hasAvalFallbackSlot,
  hasErrorListenerAfterDefinition,
  hasMissingInteractiveRecovery,
  hasRemovedImageApi,
  hasStaticReadyInRenderedSet,
  hasUnfilteredAvalErrorHandler
} from "../../scripts/docs/public-boundary-guards.mjs";

describe("public documentation boundary guards", () => {
  it.each([
    '<span slot="fallback">Unavailable</span>',
    "<span slot={'fallback'}>Unavailable</span>",
    'alternate.slot = "fallback"',
    'alternate.setAttribute("slot", "fallback")',
    'Object.assign(alternate, { slot: "fallback" })'
  ])("rejects AVAL-owned fallback construction: %s", (source) => {
    expect(hasAvalFallbackSlot(source)).toBe(true);
  });

  it.each([
    "poster-src",
    "posterSrc"
  ])("rejects removed image API text: %s", (source) => {
    expect(hasRemovedImageApi(source)).toBe(true);
  });

  it("does not reject consumer-owned alternate markup beside the player", () => {
    expect(hasAvalFallbackSlot(
      '<aval-player></aval-player><span id="motion-unavailable">Unavailable</span>'
    )).toBe(false);
  });

  it("rejects the removed host source API without rejecting child sources", () => {
    expect(hasAvalHostSrc('<aval-player src="motion.avl"></aval-player>'))
      .toBe(true);
    expect(hasAvalHostSrc(
      '<aval-player\n  aria-hidden="true"\n  src = {motionUrl}\n/>'
    )).toBe(true);
    expect(hasAvalHostSrc(
      '<aval-player><source src="motion.avl" data-codec="h264"></aval-player>'
    )).toBe(false);
    expect(hasAvalHostSrc(
      '<aval-player-source src="motion.avl"></aval-player-source>'
    )).toBe(false);
  });

  it("keeps an intentional negative type-contract case detectable", () => {
    const source = `
      // @ts-expect-error source URLs belong to direct-child source elements
      <aval-player src="/status.avl" />
    `;
    expect(hasAvalHostSrc(source)).toBe(true);
  });

  it("requires inline error handlers to branch on fatal events", () => {
    expect(hasUnfilteredAvalErrorHandler(
      'motion.addEventListener("error", (event) => show(event.detail));'
    )).toBe(true);
    expect(hasUnfilteredAvalErrorHandler(
      'motion.addEventListener("error", (event) => { console.log(event.detail.fatal); show(); });'
    )).toBe(true);
    expect(hasUnfilteredAvalErrorHandler(
      'motion.addEventListener("error", (event) => { if (event.detail.code === "fatal") show(); });'
    )).toBe(true);
    expect(hasUnfilteredAvalErrorHandler(
      'motion.addEventListener("error", (event) => { if (!event.detail.fatal) show(); });'
    )).toBe(true);
    expect(hasUnfilteredAvalErrorHandler(
      'motion.addEventListener("error", (event) => { if (event.detail.fatal) show(); });'
    )).toBe(false);
    expect(hasUnfilteredAvalErrorHandler(
      'motion.addEventListener("error", (event) => { if (event.detail.fatal !== true) return; show(); });'
    )).toBe(false);
    expect(hasUnfilteredAvalErrorHandler(
      'motion.addEventListener("error", (event) => { if (event.detail?.fatal === true) show(); });'
    )).toBe(false);
  });

  it("rejects work that escapes a positive fatal branch", () => {
    expect(hasUnfilteredAvalErrorHandler(`
      motion.addEventListener("error", (event) => {
        if (event.detail.fatal === true) recordFailure();
        unavailable.hidden = false;
      });
    `)).toBe(true);
    expect(hasUnfilteredAvalErrorHandler(`
      motion.addEventListener("error", (event) => {
        if (event.detail.fatal === true) recordFailure();
        revealAlternate();
      });
    `)).toBe(true);
    expect(hasUnfilteredAvalErrorHandler(`
      motion.addEventListener("error", (event) => {
        if (event.detail.fatal) unavailable.hidden = false;
        unavailable.hidden = false;
      });
    `)).toBe(true);
    expect(hasUnfilteredAvalErrorHandler(`
      motion.addEventListener("error", (event) => {
        if (event.detail.fatal === true) {
          unavailable.hidden = false;
        }
      });
    `)).toBe(false);
    expect(hasUnfilteredAvalErrorHandler(`
      motion.addEventListener("error", (event) => {
        if (event.detail.fatal !== true) return;
        unavailable.hidden = false;
      });
    `)).toBe(false);
  });

  it("resolves locally declared error handlers before accepting them", () => {
    expect(hasUnfilteredAvalErrorHandler(`
      const handleError = (event) => reveal(event.detail);
      motion.addEventListener("error", handleError);
    `)).toBe(true);
    expect(hasUnfilteredAvalErrorHandler(`
      function handleError(event) {
        if (!event.detail.fatal) return;
        reveal(event.detail.failure);
      }
      motion.addEventListener("error", handleError);
    `)).toBe(false);
    expect(hasUnfilteredAvalErrorHandler(
      'motion.addEventListener("error", injectedTelemetryObserver);'
    )).toBe(false);
  });

  it("requires error listeners before explicit element definition", () => {
    expect(hasErrorListenerAfterDefinition(
      'defineAvalElement(); motion.addEventListener("error", (event) => event.detail.fatal);'
    )).toBe(true);
    expect(hasErrorListenerAfterDefinition(
      'motion.addEventListener("error", (event) => event.detail.fatal); defineAvalElement();'
    )).toBe(false);
    expect(hasErrorListenerAfterDefinition(`
      defineAvalElement();
      motion?.addEventListener(
        "error",
        (event) => { if (event.detail.fatal) reveal(); }
      );
    `)).toBe(true);
  });

  it("requires a revealed alternate to recover only on interactive readiness", () => {
    expect(hasMissingInteractiveRecovery(
      'unavailable.hidden = false; motion.addEventListener("readinesschange", render);'
    )).toBe(true);
    expect(hasMissingInteractiveRecovery(
      'unavailable.hidden = false; motion.addEventListener("readinesschange", () => { if (motion.readiness === "interactiveReady") unavailable.hidden = true; });'
    )).toBe(false);
    expect(hasMissingInteractiveRecovery(`
      const handleError = (event) => {
        if (!event.detail.fatal) return;
        setFailed(true);
      };
      const handleReadiness = () => {
        if (motion.readiness === "interactiveReady") setFailed(false);
      };
      motion.addEventListener("error", handleError);
      motion.addEventListener("readinesschange", handleReadiness);
    `)).toBe(false);
    expect(hasMissingInteractiveRecovery(`
      setFailed(true);
      motion.addEventListener("readinesschange", () => {
        if (motion.readiness === "staticReady") setFailed(false);
      });
    `)).toBe(true);
    expect(hasMissingInteractiveRecovery(`
      alternate.classList.remove("hidden");
      motion.addEventListener("readinesschange", () => {
        if (motion.readiness !== "interactiveReady") return;
        alternate.classList.add("hidden");
      });
    `)).toBe(false);
  });

  it("rejects any hide that can run before interactive readiness", () => {
    expect(hasMissingInteractiveRecovery(`
      unavailable.hidden = true;
      motion.addEventListener("error", (event) => {
        if (!event.detail.fatal) return;
        unavailable.hidden = false;
      });
      motion.addEventListener("readinesschange", () => {
        if (motion.readiness === "interactiveReady") unavailable.hidden = true;
      });
    `)).toBe(false);
    expect(hasMissingInteractiveRecovery(`
      motion.addEventListener("error", (event) => {
        if (!event.detail.fatal) return;
        unavailable.hidden = false;
      });
      motion.addEventListener("readinesschange", () => {
        if (motion.readiness === "interactiveReady") unavailable.hidden = true;
      });
      function replaceSource() {
        unavailable.hidden = true;
        source.src = nextUrl;
      }
    `)).toBe(true);
    expect(hasMissingInteractiveRecovery(`
      motion.addEventListener("error", (event) => {
        if (!event.detail.fatal) return;
        unavailable.hidden = false;
      });
      motion.addEventListener("readinesschange", () => {
        if (motion.readiness === "interactiveReady") renderReady();
        unavailable.hidden = true;
      });
    `)).toBe(true);
    expect(hasMissingInteractiveRecovery(`
      motion.addEventListener("error", (event) => {
        if (!event.detail.fatal) return;
        unavailable.hidden = false;
      });
      motion.addEventListener("readinesschange", () => {
        if (motion.readiness === "staticReady") unavailable.hidden = true;
      });
    `)).toBe(true);
    expect(hasMissingInteractiveRecovery(`
      motion.addEventListener("error", (event) => {
        if (!event.detail.fatal) return;
        unavailable.hidden = false;
      });
      motion.addEventListener("readinesschange", () => {
        unavailable.hidden = motion.readiness === "interactiveReady";
      });
    `)).toBe(false);
  });

  it("rejects static policy in a rendered-readiness set", () => {
    expect(hasStaticReadyInRenderedSet(
      'const renderedReadiness = new Set(["visualReady", "staticReady"]);'
    )).toBe(true);
    expect(hasStaticReadyInRenderedSet(
      'const renderedReadiness = new Set(["visualReady", "interactiveReady"]);'
    )).toBe(false);
  });
});
