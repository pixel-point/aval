import { describe, expect, it } from "vitest";

import { PageDecoderLeases } from "./page-decoder-leases.js";
import { PageResourceManager } from "./page-resource-manager.js";
import { createPlayerWebRuntimeResources } from "./player-web-runtime-resources.js";
import { PlayerResourceAccount } from "./player-resource-account.js";

describe("player web runtime resource composition", () => {
  it("freezes one complete host bundle backed by one account", async () => {
    const manager = new PageResourceManager();
    const decoders = new PageDecoderLeases(manager);
    const account = new PlayerResourceAccount(manager);
    const resources = createPlayerWebRuntimeResources(account, decoders);

    expect(Object.isFrozen(resources)).toBe(true);
    expect(Object.keys(resources).sort()).toEqual([
      "assetSession",
      "candidate",
      "canvasBacking",
      "participant",
      "staticDecoder",
      "staticSurfaces"
    ]);
    expect(resources.candidate).toBe(
      resources.participant.candidateResourceAuthority
    );
    const body = await resources.assetSession.response.reserve(5);
    const png = await resources.staticDecoder.reserve("png-copy", 7);
    expect(manager.snapshot().physicalBytes).toBe(12);
    png.release();
    body.release();
    account.dispose();
    decoders.dispose();
    expect(manager.snapshot().physicalBytes).toBe(0);
  });

  it("rejects mixed unauthentic roots before constructing hosts", () => {
    const manager = new PageResourceManager();
    const decoders = new PageDecoderLeases(manager);
    const account = new PlayerResourceAccount(manager);
    expect(() => createPlayerWebRuntimeResources(
      {} as PlayerResourceAccount,
      decoders
    )).toThrow(TypeError);
    expect(() => createPlayerWebRuntimeResources(
      account,
      {} as PageDecoderLeases
    )).toThrow(TypeError);
    account.dispose();
    decoders.dispose();
  });
});
