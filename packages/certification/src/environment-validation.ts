import { createHash } from "node:crypto";
import { canonicalJsonBytes } from "./canonical-json.js";
import type { RuntimeEnvironment } from "./model.js";

export function createPublicProfileId(environment: RuntimeEnvironment): string {
  return `profile-${runtimeEnvironmentDigest(environment).slice(0, 20)}`;
}

/** Canonical identity shared by runtime reports and browser-produced evidence ledgers. */
export function runtimeEnvironmentDigest(environment: RuntimeEnvironment): string {
  const publicFields = {
    platformClass: environment.platformClass,
    browser: environment.browser,
    os: environment.os,
    hardware: environment.hardware,
    display: environment.display,
    power: environment.power,
    capabilities: environment.capabilities
  };
  return createHash("sha256").update(canonicalJsonBytes(publicFields)).digest("hex");
}

export function assertForegroundEnvironment(input: {
  readonly documentVisible: boolean;
  readonly documentFocused: boolean;
  readonly profileClean: boolean;
  readonly sourceMatched: boolean;
}): void {
  if (!input.documentVisible) throw new Error("certification document is hidden");
  if (!input.documentFocused) throw new Error("certification document is not focused");
  if (!input.profileClean) throw new Error("browser profile is not clean");
  if (!input.sourceMatched) throw new Error("candidate source digest does not match");
}
