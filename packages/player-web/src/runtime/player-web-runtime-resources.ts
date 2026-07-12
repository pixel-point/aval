import type { AvcCandidateResourceAuthority } from "./avc-candidate-factory-model.js";
import type { BrowserCanvasBackingResourceHost } from "./browser-canvas-backing-resources.js";
import { PageDecoderLeases } from "./page-decoder-leases.js";
import {
  createIntegratedPlayerParticipantBinding,
  type IntegratedPlayerParticipantBinding
} from "./integrated-player-participant.js";
import {
  createPlayerCanvasBackingResourceHost,
  createPlayerStaticDecoderResourceHost,
  createPlayerStaticSurfaceResourceHost
} from "./player-resource-hosts.js";
import { PlayerResourceAccount } from "./player-resource-account.js";
import type { PlayerResourceAdmission } from "./player-resource-admission.js";
import { createPlayerRuntimeAssetSessionResources } from "./runtime-asset-resources.js";
import type { RuntimeAssetSessionResources } from "./runtime-asset-session.js";
import type { StaticSurfaceStoreResourceHost } from "./static-surface-store-resources.js";
import type { BrowserStaticDecoderResourceHost } from "./strict-static-decoder.js";

/** One-account composition used by the public player and the M8 element. */
export interface PlayerWebRuntimeResources {
  readonly assetSession: Readonly<RuntimeAssetSessionResources>;
  readonly candidate: Readonly<AvcCandidateResourceAuthority>;
  readonly participant: IntegratedPlayerParticipantBinding;
  readonly staticDecoder: Readonly<BrowserStaticDecoderResourceHost>;
  readonly staticSurfaces: Readonly<StaticSurfaceStoreResourceHost>;
  readonly canvasBacking: Readonly<BrowserCanvasBackingResourceHost>;
}

/**
 * Create every browser allocation host from one authentic player account and
 * one page decoder authority. The bundle owns no resources itself; component
 * owners release their leases and the account remains the terminal kill switch.
 */
export function createPlayerWebRuntimeResources(
  account: PlayerResourceAccount,
  decoders: PageDecoderLeases,
  admission?: Readonly<PlayerResourceAdmission>
): Readonly<PlayerWebRuntimeResources> {
  if (!(account instanceof PlayerResourceAccount)) {
    throw new TypeError("web runtime resources require a player account");
  }
  if (!(decoders instanceof PageDecoderLeases)) {
    throw new TypeError("web runtime resources require page decoder leases");
  }
  const participant = createIntegratedPlayerParticipantBinding({
    account,
    decoders,
    ...(admission === undefined ? {} : { admission })
  });
  return Object.freeze({
    assetSession: createPlayerRuntimeAssetSessionResources(account, admission),
    candidate: participant.candidateResourceAuthority,
    participant,
    staticDecoder: createPlayerStaticDecoderResourceHost(account, admission),
    staticSurfaces: createPlayerStaticSurfaceResourceHost(account, admission),
    canvasBacking: createPlayerCanvasBackingResourceHost(account, admission)
  });
}
