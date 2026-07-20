import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

import { validateCompleteAsset } from "@pixel-point/aval-format";

import {
  LEGACY_UNSUPPORTED_FIXTURE_PREFIX,
  QUALIFIED_FIXTURE_PREFIX
} from "../../apps/playground/fixture-routes.js";
import { FUNCTIONAL_FIXTURE_DIGEST } from
  "../../apps/playground/src/certification/functional-fixture.js";

test("routes qualified playback bytes under their exact wire identity", async ({ request }) => {
  const session = uniqueSession("qualified_identity");
  const response = await request.get(
    `${QUALIFIED_FIXTURE_PREFIX}h264.avl?session=${session}`
  );
  expect(response.ok()).toBe(true);
  const bytes = await response.body();
  const asset = validateCompleteAsset({ bytes });

  expect(asset.frontIndex.header).toMatchObject({ major: 1, minor: 1 });
  expect(asset.frontIndex.manifest.formatVersion).toBe("1.1");
  expect(createHash("sha256").update(bytes).digest("hex"))
    .toBe(FUNCTIONAL_FIXTURE_DIGEST);
});

test("raises one typed unsupported-profile error for frozen wire 1.0", async ({ page }) => {
  test.setTimeout(90_000);
  const session = uniqueSession("legacy_unsupported");
  await page.goto(`/?session=${session}&integrity=0`);
  const outcome = await page.evaluate(async ({ prefix, session }) => {
    const api = (window as unknown as {
      avalSourcePlayground: {
        readonly ready: Promise<void>;
        readonly player: HTMLElement;
      };
    }).avalSourcePlayground;
    await api.ready;

    const reportResponse = await fetch(`${prefix}build.json`, {
      cache: "no-store",
      headers: { "X-Aval-Session": session }
    });
    if (!reportResponse.ok) {
      throw new Error(`legacy fixture report failed (${String(reportResponse.status)})`);
    }
    const report = await reportResponse.json() as {
      assets: readonly Readonly<{
        codec: string;
        path: string;
        type: string;
      }>[];
    };
    const asset = report.assets.find(({ codec }) => codec === "h264");
    if (asset === undefined) throw new Error("legacy H.264 fixture is unavailable");

    const player = api.player as HTMLElement & {
      readonly readiness?: string;
      prepare?(options?: Readonly<{ timeoutMs?: number }>): Promise<unknown>;
      dispose?(): Promise<void>;
      getDiagnostics?(): Readonly<{
        lastFailure: unknown;
        outstanding: Readonly<Record<string, number>>;
        runtime: Readonly<{ selectedCodec: string | null }>;
      }>;
    };
    const source = document.createElement("source");
    source.src = `${prefix}${asset.path}?session=${encodeURIComponent(session)}`;
    source.type = asset.type;

    const events: Array<Readonly<{ fatal: boolean; failure: unknown }>> = [];
    player.addEventListener("error", ((event: CustomEvent) => {
      events.push(event.detail as Readonly<{ fatal: boolean; failure: unknown }>);
    }) as EventListener);
    player.replaceChildren(source);

    let rejected: Readonly<{
      name: string;
      failure: unknown;
    }> | null = null;
    try {
      await player.prepare?.({ timeoutMs: 30_000 });
    } catch (error) {
      rejected = {
        name: error instanceof Error ? error.name : "unknown",
        failure: (error as { failure?: unknown })?.failure ?? null
      };
    }
    const beforeDispose = {
      readiness: player.readiness ?? "unavailable",
      selectedCodec: player.getDiagnostics?.().runtime.selectedCodec ?? null,
      lastFailure: player.getDiagnostics?.().lastFailure ?? null,
      eventCount: events.length,
      eventFatal: events[0]?.fatal ?? null,
      eventFailureMatches: events[0]?.failure === rejected?.failure
    };
    await player.dispose?.();
    const disposedDiagnostics = player.getDiagnostics?.();
    const outstanding = disposedDiagnostics === undefined ? null : {
      player: disposedDiagnostics.outstanding.player ?? -1,
      decoder: disposedDiagnostics.outstanding.decoder ?? -1,
      bytes: disposedDiagnostics.outstanding.bytes ?? -1
    };
    player.remove();
    return { rejected, beforeDispose, outstanding };
  }, { prefix: LEGACY_UNSUPPORTED_FIXTURE_PREFIX, session });

  expect(outcome).toMatchObject({
    rejected: {
      name: "AvalPlaybackError",
      failure: { code: "unsupported-profile", operation: "prepare" }
    },
    beforeDispose: {
      readiness: "error",
      selectedCodec: null,
      lastFailure: { code: "unsupported-profile", operation: "prepare" },
      eventCount: 1,
      eventFatal: true,
      eventFailureMatches: true
    },
    outstanding: { player: 0, decoder: 0, bytes: 0 }
  });
});

function uniqueSession(prefix: string): string {
  return `${prefix}_${process.pid.toString(36)}_${Date.now().toString(36)}`;
}
