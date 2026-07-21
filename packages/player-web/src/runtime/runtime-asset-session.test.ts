import { validateCompleteAsset } from "@pixel-point/aval-format";
import { describe, expect, it } from "vitest";

import { createRuntimeTestAsset } from "./asset-test-support.js";
import type { BlobAssemblyResourceHost } from "./blob-assembly.js";
import type { BoundedBodyByteResourceHost } from "./bounded-body-reader.js";
import {
  openRuntimeAssetBytes,
  type RuntimeAssetSessionResources
} from "./runtime-asset-session.js";
import type { VerifiedBlobResourceHost } from "./verified-blob-store.js";

describe("runtime asset session", () => {
  it("loads and evicts animation units from a complete source", async () => {
    const bytes = createRuntimeTestAsset();
    const layout = validateCompleteAsset({ bytes });
    const session = await openRuntimeAssetBytes(bytes, {
      resources: resources()
    });

    const handles = await session.ensureRenditionUnits("opaque");
    expect(handles).toHaveLength(layout.frontIndex.unitBlobs.length);
    expect(handles.every(({ kind }) => kind === "unit")).toBe(true);
    expect(session.snapshot().unitBlobs.verified).toBe(handles.length);
    expect(session.evictRenditionUnits("opaque")).toBeGreaterThan(0);
    expect(session.snapshot().unitBlobs.verified).toBe(0);

    await session.dispose();
    expect(session.disposed).toBe(true);
  });
});

function resources(): RuntimeAssetSessionResources {
  const bytes: BoundedBodyByteResourceHost = {
    reserve() { return { release() {} }; }
  };
  const assembly: BlobAssemblyResourceHost = {
    reserve() { return { release() {} }; }
  };
  const verified: VerifiedBlobResourceHost = {
    reserve() { return { release() {} }; }
  };
  return { metadata: bytes, response: bytes, full: bytes, assembly, verified };
}
