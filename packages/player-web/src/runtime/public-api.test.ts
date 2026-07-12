import { describe, expect, it } from "vitest";

// @ts-expect-error Vite exposes the checked-in binary as a data URL in tests.
import packedFixtureDataUrl from "../../../../fixtures/conformance/m7/reference-packed.rma?url&inline";

import * as api from "../index.js";

const PUBLIC_M7_RUNTIME_EXPORTS = Object.freeze([
  "PageDecoderLeases",
  "PageReclamationCoordinator",
  "PageResourceManager",
  "PlayerWebPageRuntime",
  "PlayerResourceAccount",
  "RuntimeSessionLifecycle",
  "VisibilityPolicyCoordinator",
  "createPlayerRuntimeAssetSessionResources",
  "createPlayerWebRuntimeResources",
  "createRuntimePageResourcePolicy",
  "openRuntimeAsset",
  "openRuntimeAssetBytes"
] as const);

const PRIVATE_RESOURCE_EXPORTS = Object.freeze([
  "BlobAssembly",
  "LEASED_STATIC_PNG_DECODER",
  "RUNTIME_CATALOG_AVC_INSPECTION",
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
  "inspectBorrowedAvcRendition",
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

const PACKED_FIXTURE = decodeFixture(packedFixtureDataUrl);

describe("M7 player-web public boundary", () => {
  it("publishes the complete composition surface without raw ownership bridges", () => {
    const runtime = api as Record<string, unknown>;

    for (const name of PUBLIC_M7_RUNTIME_EXPORTS) {
      expect(runtime[name], name).toBeTypeOf("function");
    }
    for (const name of PRIVATE_RESOURCE_EXPORTS) {
      expect(runtime[name], name).toBeUndefined();
    }
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
      "participant",
      "staticDecoder",
      "staticSurfaces"
    ]);
    expect(Object.isFrozen(resources)).toBe(true);
    expect(Object.keys(resources).sort()).toEqual([
      "assembly",
      "full",
      "metadata",
      "response",
      "verified"
    ]);

    const session = await api.openRuntimeAssetBytes(PACKED_FIXTURE, {
      resources,
      generation: lifecycle.current().generation
    });
    const staticFrame = session.catalog.staticFrames.keys()[0];
    const rendition = session.catalog.renditions.keys()[0];
    if (staticFrame === undefined || rendition === undefined) {
      throw new Error("M7 public fixture has no static or rendition");
    }
    await session.ensureStatic(staticFrame);
    await session.ensureAllUnits(rendition);
    const renditionRecord = session.catalog.records.values().find((record) =>
      record.rendition === rendition
    );
    if (renditionRecord === undefined) {
      throw new Error("M7 public fixture rendition has no access units");
    }
    const sampleBeforeEviction = new Uint8Array(session.catalog.copySample(
      renditionRecord.rendition,
      renditionRecord.unit,
      renditionRecord.localFrame
    ));
    const beforeEviction = session.snapshot();
    const evictedBytes = session.evictRenditionUnits(rendition);
    expect(evictedBytes).toBe(beforeEviction.unitBlobs.verifiedBytes);
    expect(evictedBytes).toBeGreaterThan(0);
    expect(session.evictRenditionUnits(rendition)).toBe(0);
    expect(() => session.catalog.copySample(
      renditionRecord.rendition,
      renditionRecord.unit,
      renditionRecord.localFrame
    )).toThrow();
    expect(session.snapshot().unitBlobs).toMatchObject({
      verified: 0,
      verifiedBytes: 0
    });
    await session.ensureAllUnits(rendition);
    expect(session.snapshot().unitBlobs.verifiedBytes).toBe(evictedBytes);
    expect(new Uint8Array(session.catalog.copySample(
      renditionRecord.rendition,
      renditionRecord.unit,
      renditionRecord.localFrame
    ))).toEqual(sampleBeforeEviction);

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
    const session = await participant.openAssetBytes(PACKED_FIXTURE);
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

function decodeFixture(dataUrl: string): Uint8Array {
  const separator = dataUrl.indexOf(",");
  if (
    !dataUrl.startsWith("data:") ||
    separator < 0 ||
    !dataUrl.slice(0, separator).endsWith(";base64")
  ) {
    throw new Error("Vite did not inline the M7 fixture as base64");
  }
  const binary = atob(dataUrl.slice(separator + 1));
  return Uint8Array.from(binary, (value) => value.charCodeAt(0));
}
