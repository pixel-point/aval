import { describe, expect, it } from "vitest";

import { createRuntimeTestAsset } from "./asset-test-support.js";
import { PageResourceManager } from "./page-resource-manager.js";
import { PlayerResourceAccount } from "./player-resource-account.js";
import { openRuntimeAssetBytes } from "./runtime-asset-session.js";
import { createPlayerRuntimeAssetSessionResources } from "./runtime-asset-resources.js";

describe("runtime rendition residency eviction", () => {
  it("releases a failed rendition exactly and reloads through the same catalog", async () => {
    const bytes = createRuntimeTestAsset();
    const manager = new PageResourceManager();
    const account = new PlayerResourceAccount(manager);
    const session = await openRuntimeAssetBytes(bytes, {
      resources: createPlayerRuntimeAssetSessionResources(account)
    });

    await session.ensureRenditionUnits("opaque");
    const verifiedBytes = session.snapshot().unitBlobs.verifiedBytes;
    expect(session.snapshot().unitBlobs.verified).toBe(2);
    expect(verifiedBytes).toBeGreaterThan(0);
    expect(manager.snapshot().categories.filter(({ bytes }) => bytes > 0))
      .toEqual([{ category: "asset-full", bytes: bytes.byteLength }]);
    expect(session.evictRenditionUnits("opaque")).toBe(verifiedBytes);
    expect(session.evictRenditionUnits("opaque")).toBe(0);
    expect(session.snapshot().unitBlobs).toMatchObject({
      verified: 0,
      verifiedBytes: 0
    });

    await session.ensureRenditionUnits("opaque");
    expect(session.snapshot().unitBlobs.verifiedBytes).toBe(verifiedBytes);
    expect(manager.snapshot().categories.filter(({ bytes }) => bytes > 0))
      .toEqual([{ category: "asset-full", bytes: bytes.byteLength }]);
    await session.dispose();
    account.dispose();
    expect(manager.snapshot().physicalBytes).toBe(0);
  });

  it("rejects unknown renditions without changing residency", async () => {
    const bytes = createRuntimeTestAsset();
    const manager = new PageResourceManager();
    const account = new PlayerResourceAccount(manager);
    const session = await openRuntimeAssetBytes(bytes, {
      resources: createPlayerRuntimeAssetSessionResources(account)
    });

    let failure: unknown;
    try {
      session.evictRenditionUnits("missing");
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "invalid-asset" });
    expect(session.snapshot().verifiedPayloadBytes).toBe(0);
    await session.dispose();
    account.dispose();
  });
});
