import { describe, expect, it } from "vitest";

import { createRuntimeTestAsset } from "./asset-test-support.js";
import { RuntimeAssetCatalog } from "./asset-catalog.js";
import { StateStore } from "./state-store.js";

describe("state store", () => {
  it("tracks logical state without owning presentation UI", async () => {
    const catalog = new RuntimeAssetCatalog(createRuntimeTestAsset());
    const store = new StateStore(catalog);
    const signal = new AbortController().signal;

    await store.installInitial({ state: "idle", signal });
    expect(store.currentState()).toBe("idle");

    await store.presentState("idle", { signal });
    expect(store.currentState()).toBe("idle");

    store.dispose();
    expect(store.currentState()).toBeNull();
    catalog.dispose();
  });

  it("rejects unknown states and aborted operations", async () => {
    const catalog = new RuntimeAssetCatalog(createRuntimeTestAsset());
    const store = new StateStore(catalog);
    const active = new AbortController().signal;
    await expect(store.presentState("missing", { signal: active }))
      .rejects.toThrow();

    const aborted = new AbortController();
    aborted.abort(new DOMException("cancelled", "AbortError"));
    await expect(store.installInitial({
      state: "idle",
      signal: aborted.signal
    })).rejects.toMatchObject({ name: "AbortError" });

    store.dispose();
    catalog.dispose();
  });
});
