import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";

import { validateCompleteAsset } from "@pixel-point/aval-format";

import { QUALIFIED_FIXTURE_PREFIX } from
  "../../apps/playground/fixture-routes.js";
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

function uniqueSession(prefix: string): string {
  return `${prefix}_${process.pid.toString(36)}_${Date.now().toString(36)}`;
}
