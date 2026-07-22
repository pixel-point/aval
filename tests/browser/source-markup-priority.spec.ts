import { expect, test } from "@playwright/test";
import { SOURCE_CODEC_PRIORITY } from "@pixel-point/aval-element";

import { QUALIFIED_FIXTURE_PREFIX } from
  "../../apps/playground/fixture-routes.js";

const CODEC_ORDER = SOURCE_CODEC_PRIORITY;

interface PlaygroundApi {
  readonly ready: Promise<void>;
  readonly player: HTMLElement & {
    prepare(options?: Readonly<{ timeoutMs?: number }>): Promise<unknown>;
    getDiagnostics(): Readonly<{
      sourceGeneration: number;
      runtime: Readonly<{ selectedCodec: string | null }>;
    }>;
  };
  sourceSnapshot(): readonly Readonly<{
    codec: string | null;
    src: string | null;
    integrity: string | null;
  }>[];
}

test("publishes codec-declared child sources without host source authority", async ({
  page
}) => {
  await page.goto(`/?session=${uniqueSession("markup")}&integrity=0`);
  await expect.poll(() => page.evaluate(() => {
    const api = (window as unknown as { avalSourcePlayground: PlaygroundApi })
      .avalSourcePlayground;
    return api.sourceSnapshot().every(({ src }) => src !== null);
  })).toBe(true);

  const snapshot = await page.evaluate(() => {
    const api = (window as unknown as { avalSourcePlayground: PlaygroundApi })
      .avalSourcePlayground;
    return {
      hostSrc: api.player.getAttribute("src"),
      hostIntegrity: api.player.getAttribute("integrity"),
      sourceTypeCount: api.player.querySelectorAll(":scope > source[type]").length,
      sources: api.sourceSnapshot()
    };
  });

  expect(snapshot.hostSrc).toBeNull();
  expect(snapshot.hostIntegrity).toBeNull();
  expect(snapshot.sourceTypeCount).toBe(0);
  expect(snapshot.sources.map(({ codec }) => codec)).toEqual(CODEC_ORDER);
  for (const [index, source] of snapshot.sources.entries()) {
    const codec = CODEC_ORDER[index]!;
    expect(new URL(source.src!).pathname).toBe(
      `${QUALIFIED_FIXTURE_PREFIX}${codec}.avl`
    );
    expect(source.integrity).toBeNull();
  }
});

test("keeps canonical codec priority when DOM source order is shuffled", async ({
  browserName,
  page
}) => {
  test.skip(browserName !== "chromium", "the fixture AV1 expectation targets Chromium");
  test.setTimeout(90_000);
  await page.goto(`/?session=${uniqueSession("shuffled_priority")}&integrity=0`);

  const outcome = await page.evaluate(async () => {
    const api = (window as unknown as { avalSourcePlayground: PlaygroundApi })
      .avalSourcePlayground;
    await api.ready;
    const initialGeneration = api.player.getDiagnostics().sourceGeneration;
    const h264 = api.player.querySelector(':scope > source[data-codec="h264"]');
    if (h264 === null) throw new Error("H.264 source is unavailable");
    api.player.prepend(h264);
    await api.player.prepare({ timeoutMs: 30_000 });
    const diagnostics = api.player.getDiagnostics();
    return {
      domOrder: [...api.player.querySelectorAll(":scope > source")].map(
        (source) => source.getAttribute("data-codec")
      ),
      initialGeneration,
      selectedCodec: diagnostics.runtime.selectedCodec,
      sourceGeneration: diagnostics.sourceGeneration
    };
  });

  expect(outcome.domOrder).toEqual(["h264", "av1", "vp9", "h265"]);
  expect(outcome.selectedCodec).toMatch(/^av01\./u);
  expect(outcome.sourceGeneration).toBeGreaterThan(outcome.initialGeneration);
});

function uniqueSession(prefix: string): string {
  return `${prefix}_${process.pid.toString(36)}_${Date.now().toString(36)}`;
}
