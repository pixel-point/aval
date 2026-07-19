import { describe, expect, it } from "vitest";

import { deriveBrowserEnvironmentIdentity } from "../../apps/playground/src/certification/environment-identity.js";
import { createPublicProfileId, runtimeEnvironmentDigest } from "../../packages/certification/src/environment-validation.js";
import { validRuntimeReport } from "../../packages/certification/test/test-report.js";

describe("browser certification environment identity", () => {
  it("matches the independent Node certification authority", async () => {
    const environment = validRuntimeReport().environment;
    await expect(deriveBrowserEnvironmentIdentity(environment as unknown as Readonly<Record<string, unknown>>)).resolves.toEqual({
      environmentDigest: runtimeEnvironmentDigest(environment),
      profileId: createPublicProfileId(environment)
    });
  });

  it("rejects strings that the independent canonicalizer cannot identify", async () => {
    const environment = structuredClone(validRuntimeReport().environment) as any;
    environment.browser.build = "20600.1\ud800";
    expect(() => runtimeEnvironmentDigest(environment)).toThrow(/surrogate/u);
    await expect(deriveBrowserEnvironmentIdentity(environment)).rejects.toThrow(/surrogate/u);
  });
});
