import { describe, expect, it } from "vitest";

import * as api from "../index.js";
import { createRuntimeTestAsset } from "./asset-test-support.js";

const PUBLIC_RUNTIME_EXPORTS = Object.freeze([
  "PageDecoderLeases",
  "PageReclamationCoordinator",
  "PageResourceManager",
  "PlayerWebPageRuntime",
  "PlayerResourceAccount",
  "RuntimeSessionLifecycle",
  "SourceSupportProbe",
  "VideoCandidateFactory",
  "VisibilityPolicyCoordinator",
  "createBrowserVideoCandidateComposition",
  "createPlayerRuntimeAssetSessionResources",
  "createPlayerWebRuntimeResources",
  "createRuntimePageResourcePolicy",
  "createSourceSupportProbe",
  "openRuntimeAsset",
  "openRuntimeAssetBytes"
] as const);

const PRIVATE_RESOURCE_EXPORTS = Object.freeze([
  "BlobAssembly",
  "LEASED_STATIC_PNG_DECODER",
  "RuntimeEntityIdentity",
  "VerifiedBlobStore",
  "adoptPlayerResourceLease",
  "assertPageResourceByteLeaseOwner",
  "captureRuntimeAssetRequest",
  "createIntegratedPlayerParticipantBinding",
  "createPlayerBlobAssemblyResourceHost",
  "createPlayerBodyResourceHost",
  "createPlayerCandidateResourceAuthority",
  "createPlayerCanvasBackingResourceHost",
  "createPlayerResourceAdmission",
  "createPlayerFullBodyResourceHost",
  "createPlayerStaticDecoderResourceHost",
  "createPlayerStaticSurfaceResourceHost",
  "createPlayerVerifiedBlobResourceHost",
  "captureLeasedStaticPngDecoder",
  "openRangeAssetSession",
  "parseCanonicalContentRange",
  "readBoundedBody",
  "reserveRuntimeAssetBytes",
  "reclassifyPageResourceByteLease",
  "reclassifyPlayerResourceLease",
  "registerPageResourceCounterContributor",
  "refreshPlayerAutomaticReclaimablePublication",
  "retainPlayerReclaimableCategories",
  "retirePlayerResourceGeneration",
  "shrinkPageResourceByteLease",
  "shrinkPlayerResourceLease",
  "snapshotPlayerResourceCategories",
  "setPlayerResourceLeaseReclaimable",
  "MARK_VERIFIED_BLOB_RECLAIMABLE",
  "PROMOTE_BORROWED_VERIFIED_BLOB",
  "verifySha256AndPromote"
] as const);

const REMOVED_FALLBACK_EXPORTS = Object.freeze([
  "PlaybackFallbackError",
  "StateFallbackStore",
  "summarizeStaticReason"
] as const);

const VIDEO_FIXTURE = createRuntimeTestAsset();

describe("player-web public boundary", () => {
  it("publishes the complete composition surface without raw ownership bridges", () => {
    const runtime = api as Record<string, unknown>;

    for (const name of PUBLIC_RUNTIME_EXPORTS) {
      expect(runtime[name], name).toBeTypeOf("function");
    }
    for (const name of PRIVATE_RESOURCE_EXPORTS) {
      expect(runtime[name], name).toBeUndefined();
    }
    for (const name of REMOVED_FALLBACK_EXPORTS) {
      expect(runtime[name], name).toBeUndefined();
    }
    expect(api.STATIC_REASONS).toEqual([
      "reduced-motion",
      "visibility-suspended",
      "decoder-queued"
    ]);
  });

  it("composes asset, page, decoder, reclamation, and lifecycle owners through only package exports", async () => {
    const policy = api.createRuntimePageResourcePolicy({
      maximumDecoderLeases: 1,
      maximumPagePhysicalBytes: 4 * 1024 * 1024,
      maximumPlayerLogicalBytes: 4 * 1024 * 1024
    });
    const manager = new api.PageResourceManager(policy);
    const account = new api.PlayerResourceAccount(manager, {
      generation: 1,
      visibility: "visible",
      phase: "loading"
    });
    const decoders = new api.PageDecoderLeases(manager);
    const reclamation = new api.PageReclamationCoordinator(manager);
    const lifecycle = new api.RuntimeSessionLifecycle();
    const runtimeResources = api.createPlayerWebRuntimeResources(
      account,
      decoders
    );
    const resources = runtimeResources.assetSession;

    expect(Object.isFrozen(runtimeResources)).toBe(true);
    expect(Object.keys(runtimeResources).sort()).toEqual([
      "assetSession",
      "candidate",
      "canvasBacking",
      "participant"
    ]);
    expect(Object.isFrozen(resources)).toBe(true);
    expect(Object.keys(resources).sort()).toEqual([
      "assembly",
      "full",
      "metadata",
      "response",
      "verified"
    ]);

    const session = await api.openRuntimeAssetBytes(VIDEO_FIXTURE, {
      resources,
      generation: lifecycle.current().generation
    });
    const rendition = session.catalog.renditions.keys()[0];
    if (rendition === undefined) {
      throw new Error("public video fixture has no rendition");
    }
    await session.ensureRenditionUnits(rendition);
    const renditionRecord = session.catalog.chunks.values().find((record) =>
      record.rendition === rendition
    );
    if (renditionRecord === undefined) {
      throw new Error("public video fixture rendition has no chunks");
    }
    const chunkBeforeEviction = new Uint8Array(session.catalog.copyChunk(
      renditionRecord.rendition,
      renditionRecord.unit,
      renditionRecord.decodeIndex
    ));
    const beforeEviction = session.snapshot();
    const evictedBytes = session.evictRenditionUnits(rendition);
    expect(evictedBytes).toBe(beforeEviction.unitBlobs.verifiedBytes);
    expect(evictedBytes).toBeGreaterThan(0);
    expect(session.evictRenditionUnits(rendition)).toBe(0);
    expect(() => session.catalog.copyChunk(
      renditionRecord.rendition,
      renditionRecord.unit,
      renditionRecord.decodeIndex
    )).toThrow();
    expect(session.snapshot().unitBlobs).toMatchObject({
      verified: 0,
      verifiedBytes: 0
    });
    await session.ensureRenditionUnits(rendition);
    expect(session.snapshot().unitBlobs.verifiedBytes).toBe(evictedBytes);
    expect(new Uint8Array(session.catalog.copyChunk(
      renditionRecord.rendition,
      renditionRecord.unit,
      renditionRecord.decodeIndex
    ))).toEqual(chunkBeforeEviction);

    const ticket = decoders.request(
      account.participantId,
      lifecycle.current().generation
    );
    const decoderLease = await ticket.wait();
    expect(decoderLease.snapshot().released).toBe(false);

    const unregisterReclamation = reclamation.registerParticipant(
      account.participantId,
      {
        async reclaim(request) {
          return {
            token: request.token,
            releasedBytes: 0,
            covered: true
          };
        }
      }
    );
    const generation = lifecycle.current();
    generation.registerCleanup("network-digest", () => session.dispose());
    generation.registerCleanup("candidate-gl", () => decoders.dispose());
    generation.registerCleanup("candidate-gl", () => decoderLease.release());
    generation.registerCleanup("participant", () => account.dispose());
    generation.registerCleanup("queues", () => reclamation.dispose());
    generation.registerCleanup("queues", unregisterReclamation);

    const liveSession = session.snapshot();
    expect(liveSession.disposed).toBe(false);
    expect(liveSession.verifiedPayloadBytes).toBeGreaterThan(0);
    expect(Object.isFrozen(liveSession)).toBe(true);
    expect(JSON.stringify(liveSession)).not.toMatch(/etag|https?:|entity-v/u);
    expect(manager.snapshot()).toMatchObject({
      decoderLeaseCount: 1,
      participants: [{ id: account.participantId }]
    });

    await lifecycle.dispose();

    expect(session.snapshot()).toMatchObject({
      disposed: true,
      metadataBytes: 0,
      verifiedPayloadBytes: 0,
      activeTransportBodies: 0,
      pendingLoads: 0,
      interestedWaiters: 0
    });
    expect(manager.snapshot()).toMatchObject({
      physicalBytes: 0,
      byteLeaseCount: 0,
      decoderLeaseCount: 0,
      decoderQueueLength: 0,
      pendingReclamations: 0,
      participants: []
    });

    manager.dispose();
  });

  it("offers one production page composition for replacement and terminal cleanup", async () => {
    const page = new api.PlayerWebPageRuntime();
    const participant = page.createParticipant();
    const session = await participant.openAssetBytes(VIDEO_FIXTURE);
    participant.ownPlayer({ dispose: () => undefined });

    expect(participant.resources.participant.candidateResourceAuthority)
      .toBe(participant.resources.candidate);
    await participant.replace();
    expect(session.disposed).toBe(true);
    expect(participant.snapshot()).toMatchObject({
      generation: 2,
      account: { participant: { generation: 2 } },
      lifecycle: { retiredGenerationCount: 1 }
    });

    await page.dispose();
    expect(page.snapshot()).toMatchObject({
      disposed: true,
      activeParticipants: 0,
      resources: {
        physicalBytes: 0,
        byteLeaseCount: 0,
        decoderLeaseCount: 0,
        decoderQueueLength: 0,
        pendingReclamations: 0,
        participants: []
      }
    });
  });
});
