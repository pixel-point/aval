import { describe, expect, it } from "vitest";

import {
  createProductionProfileEvidence,
  assessProductionMotionPolicy
} from "./browser-resource-readiness-policy.js";
import { assertReadinessActive } from "./browser-readiness-driver.js";

describe("browser production readiness boundary", () => {
  it("rejects an abort before publishing production evidence", () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    expect(() => assertReadinessActive({
      signal: controller.signal,
      clock: { now: () => 1 },
      deadlineMs: 10
    })).toThrowError(expect.objectContaining({ name: "AbortError" }));
  });

  it("rejects an expired production readiness deadline", () => {
    expect(() => assertReadinessActive({
      signal: new AbortController().signal,
      clock: { now: () => 10 },
      deadlineMs: 10
    })).toThrowError(expect.objectContaining({ name: "TimeoutError" }));
  });

  it.each([
    {
      layout: "opaque" as const,
      alpha: null,
      alphaPaneAvailable: false
    },
    {
      layout: "packed-alpha" as const,
      alpha: [0, 72, 64, 64] as const,
      alphaPaneAvailable: true
    }
  ])("attests $layout geometry and real renderer counters without a pixel claim", ({
    layout,
    alpha,
    alphaPaneAvailable
  }) => {
    const evidence = createProductionProfileEvidence({
      context: {
        catalog: { manifest: { codec: "h264" } },
        inspection: { family: "h264", bitDepth: 8 },
        candidate: {
          rendition: { codec: "avc1.42E020", bitDepth: 8 },
          geometry: {
            layout,
            visibleColorRect: [0, 0, 64, 64],
            visibleAlphaRect: alpha,
            decodedStorageRect: alpha === null
              ? [0, 0, 64, 64]
              : [0, 0, 64, 136],
            codedWidth: 64,
            codedHeight: alpha === null ? 64 : 144
          }
        }
      },
      interactionCache: { layerCount: 3 },
      renderer: {
        snapshot: () => ({
          state: "active",
          allocatedLayers: 3,
          uploadedResidentLayers: 3,
          residentUploads: 3,
          streamingUploads: 8,
          draws: 9,
          errors: 0
        })
      }
    } as never);

    expect(evidence).toMatchObject({
      layout,
      codecFamily: "h264",
      codec: "avc1.42E020",
      bitDepth: 8,
      alphaPaneAvailable,
      uploadReady: true,
      pixelEvidence: "not-claimed-by-readiness",
      passed: true
    });
    expect(Object.isFrozen(evidence.visibleColorRect)).toBe(true);
    if (evidence.visibleAlphaRect !== null) {
      expect(Object.isFrozen(evidence.visibleAlphaRect)).toBe(true);
    }
  });

  it("assesses reduced, restored, superseded, suspended, and disposed phases", () => {
    const evidence = assessProductionMotionPolicy();

    expect(evidence).toMatchObject({
      passed: true,
      staleTransitionRejected: true,
      transientSuspensionReentered: true
    });
    expect(evidence.phases.map(({ phase }) => phase)).toEqual([
      "animated-installed",
      "reducing",
      "reduced",
      "restoring",
      "restored",
      "superseded-reduction",
      "visibility-suspended",
      "disposed"
    ]);
    expect(evidence.phases.at(-2)).toMatchObject({
      actualMode: "static",
      staticOrigin: "visibility-suspended"
    });
  });
});
