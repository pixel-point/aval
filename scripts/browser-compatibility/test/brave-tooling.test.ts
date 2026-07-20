import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { afterEach, describe, expect, it } from "vitest";

import {
  acquireBuilds,
  verifyBraveVersionOutput,
  verifyFileSha256,
  verifyMacSignatureOutput,
  verifyWindowsSignatureRecord
} from "../brave/acquire-builds.mjs";
import {
  assertBoundaryReleaseProof,
  assertCertificationPolicyIntegrity,
  assertOfficialHttpsUrl,
  assertPolicyFinalized,
  fetchWithBoundedRedirects,
  parseSha256,
  resolveOfficialBuilds,
  selectNearestBoundaryRelease,
  updatePolicyWithBraveBuilds
} from "../brave/resolve-builds.mjs";
import {
  acquisitionEvidenceFilename,
  analyzePngWitness,
  assertAuthoredSources,
  assertCodecSelection,
  assertRuntimeChromiumVersion,
  createBraveCaseEvidenceContract,
  createBraveEvidenceSession,
  createBraveManifestFragment,
  createBraveManifestSlot,
  createMonotonicSoakClock,
  isMeaningfulPixelWitness,
  manifestFragmentFilename,
  planBraveRuns,
  requiredInteractionEvidence,
  validateEvidenceIdentity,
  validateBraveEvidencePlan
} from "../brave/run-matrix.mjs";
import {
  DIAGNOSTIC_REPORT_SCHEMA,
  EVIDENCE_MANIFEST_SCHEMA,
  EVIDENCE_SESSION_SCHEMA,
  INTERACTION_LEDGER_SCHEMA
} from "../evidence-schema.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) =>
    rm(path, { force: true, recursive: true })
  ));
});

describe("rolling certification inventory", () => {
  it("is closed by its schema and freezes every provider slot without a moving browser alias", async () => {
    const [policy, schema] = await Promise.all([
      readJson("scripts/browser-compatibility/certification-policy.json"),
      readJson("scripts/browser-compatibility/certification-policy.schema.json")
    ]);
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    expect(validate(policy), JSON.stringify(validate.errors, null, 2)).toBe(true);
    const unclosed = { ...policy, browserAlias: "latest" };
    expect(validate(unclosed)).toBe(false);
    const moving = structuredClone(policy);
    moving.slots[0].browser.version = "latest";
    expect(validate(moving)).toBe(false);
    const oneSlot = structuredClone(policy);
    oneSlot.slots = [oneSlot.slots[0]];
    expect(validate(oneSlot)).toBe(false);
    const duplicateSlot = structuredClone(policy);
    duplicateSlot.slots[1] = structuredClone(duplicateSlot.slots[0]);
    expect(validate(duplicateSlot)).toBe(false);
    const changedSelector = structuredClone(policy);
    changedSelector.requirements.demos[0].playerSelector = "#not-the-certified-player";
    expect(validate(changedSelector)).toBe(false);
    const falselyResolved = structuredClone(policy);
    falselyResolved.inventoryState = "resolved";
    falselyResolved.unresolvedProductVersionSlotIds = [];
    falselyResolved.slots[0].browser.version = null;
    expect(validate(falselyResolved)).toBe(false);
    const replacedSlot = structuredClone(policy);
    replacedSlot.slots[0].id = "windows-11-chrome-147";
    expect(validate(replacedSlot)).toBe(true);
    expect(() => assertCertificationPolicyIntegrity(replacedSlot))
      .toThrowError("certification-policy-slot-set-invalid");
    expect(validate(policy), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(policy.rollingWindowMonths).toBe(24);
    expect(policy.requirements.demos.map(({ route }: { route: string }) => route)).toEqual([
      "/playground/",
      "/rabbit/",
      "/codecs/",
      "/orb/"
    ]);
    expect(policy.requirements.playbackModes).toEqual(["forced-h264", "full-ladder"]);
    expect(policy.requirements.authoredCodecsByMode).toEqual({
      "forced-h264": ["h264"],
      "full-ladder": ["av1", "vp9", "h265", "h264"]
    });
    expect(policy.requirements.demos.map((demo: { sourceContract: string }) =>
      demo.sourceContract
    )).toEqual(["multi-source", "multi-source", "multi-source", "multi-source"]);
    expect(policy.requirements.soakSeconds).toBe(60);
    expect(new Set(policy.slots.map(({ id }: { id: string }) => id)).size)
      .toBe(policy.slots.length);
    for (const slot of policy.slots) {
      expect(slot.demoIds).toEqual([
        "end-user-playground",
        "grass-rabbit",
        "grass-rabbit-codecs",
        "kinetic-orb"
      ]);
      expect(slot.playbackModes).toEqual(["forced-h264", "full-ladder"]);
      expect(slot.soakSeconds).toBe(60);
      if (slot.browser.version !== null) {
        expect(slot.browser.version).toMatch(/^\d+(?:\.\d+){1,3}$/u);
      }
      expect(String(slot.browser.version)).not.toMatch(/latest|default|current/iu);
    }
  });

  it("pins the exact signed-in BrowserStack desktop and mobile catalog", async () => {
    const policy = await readJson("scripts/browser-compatibility/certification-policy.json");
    const byId = new Map(policy.slots.map((slot: { id: string }) => [slot.id, slot]));
    expect([...byId.keys()].filter((id) => id.startsWith("ios-"))).toEqual([
      "ios-26-5-iphone-17-safari",
      "ios-26-4-iphone-17-safari",
      "ios-26-0-iphone-17-safari",
      "ios-18-6-iphone-16-safari"
    ]);
    expect(policy.slots.filter((slot: { browser: { brand: string }, platform: string }) =>
      slot.platform === "macos" && slot.browser.brand === "Safari"
    ).map((slot: { os: { providerLabel: string }, browser: { version: string } }) => [
      slot.os.providerLabel,
      slot.browser.version
    ])).toEqual([
      ["mactho", "26.4"],
      ["macsqa", "18.4"]
    ]);
    expect(JSON.stringify(policy)).not.toContain("Sonoma");
    const android = policy.slots.filter((slot: { platform: string }) =>
      slot.platform === "android"
    );
    expect(android.map((slot: { device: { providerLabel: string } }) =>
      slot.device.providerLabel
    )).toEqual([
        "Google Pixel 9-17.0-1080x2424",
        "Google Pixel 9-16.0-1080x2424",
        "Samsung Galaxy S25-15.0-1080x2340"
      ]);
    expect(android.map((slot: { browser: { version: string, engineVersion: string }, provider: { browserVersionLabel: string } }) => ({
      browserVersion: slot.browser.version,
      engineVersion: slot.browser.engineVersion,
      providerVersion: slot.provider.browserVersionLabel
    }))).toEqual(Array.from({ length: 3 }, () => ({
      browserVersion: "145.0.0.0",
      engineVersion: "145.0.0.0",
      providerVersion: "145.0.0.0"
    })));
    expect(policy.inventoryState).toBe("resolved");
    expect(policy.unresolvedProductVersionSlotIds).toEqual([]);
    expect(() => assertPolicyFinalized(policy)).not.toThrow();
  });

  it("pins the required Windows browser generations and deterministic Firefox sentinels", async () => {
    const policy = await readJson("scripts/browser-compatibility/certification-policy.json");
    const windows = policy.slots.filter((slot: { platform: string }) => slot.platform === "windows");
    expect(windows.filter((slot: { browser: { brand: string } }) => slot.browser.brand === "Chrome")
      .map((slot: { browser: { version: string } }) => slot.browser.version)).toEqual([
        "150.0", "149.0", "148.0", "127.0"
      ]);
    expect(windows.filter((slot: { browser: { brand: string } }) => slot.browser.brand === "Firefox")
      .map((slot: { browser: { version: string }, expectation: string }) => [
        slot.browser.version,
        slot.expectation
      ])).toEqual([
        ["152.0", "playback"],
        ["151.0", "playback"],
        ["150.0", "playback"],
        ["130.0", "playback"],
        ["129.0", "unsupported-sentinel"],
        ["128.0", "unsupported-sentinel"]
      ]);
  });
});

describe("official Brave release resolution", () => {
  it("resolves current stable and the stable release nearest the boundary with exact assets", async () => {
    const fixtures = releaseFixtures();
    const builds = await resolveOfficialBuilds({
      versionsResponse: fixtures.versions,
      releases: fixtures.releases,
      boundaryDate: "2024-07-19",
      readChecksum: async (asset: { fixtureText?: string }) => asset.fixtureText ?? ""
    });
    expect(builds.current).toMatchObject({
      role: "current",
      version: "1.92.141",
      chromiumVersion: "150.0.7871.128",
      releaseDate: "2026-07-17T08:01:30.000Z"
    });
    expect(builds.boundary).toMatchObject({
      role: "boundary",
      version: "1.67.134",
      chromiumVersion: "126.0.6478.186",
      releaseDate: "2024-07-17T06:23:43.000Z"
    });
    expect(builds.current.assets["macos-arm64"]).toMatchObject({
      name: "Brave-Browser-arm64.dmg",
      sha256: "1".repeat(64)
    });
    expect(builds.boundary.assets["windows-x64"].sha256).toBe("4".repeat(64));
  });

  it("uses a stable deterministic boundary tie break", () => {
    const before = fixtureRelease("1.0.1", "2024-07-18T00:00:00.000Z", "126.0.0.1");
    const after = fixtureRelease("1.0.2", "2024-07-20T00:00:00.000Z", "127.0.0.1");
    expect(selectNearestBoundaryRelease([after, before], Date.parse("2024-07-19T00:00:00Z")))
      .toBe(before);
  });

  it("proves the pinned boundary against the adjacent official stable releases", () => {
    const fixtures = releaseFixtures();
    expect(assertBoundaryReleaseProof(
      fixtures.releases,
      "2024-07-19",
      "1.67.134"
    )).toEqual({
      previous: "1.67.123",
      selected: "1.67.134",
      next: "1.68.128"
    });
    expect(() => assertBoundaryReleaseProof(
      fixtures.releases,
      "2024-07-19",
      "1.68.128"
    )).toThrowError("brave-policy-boundary-proof-missing");
    expect(() => assertBoundaryReleaseProof(
      fixtures.releases.filter(({ tag_name }) => tag_name !== "v1.67.123"),
      "2024-07-19",
      "1.67.134"
    )).toThrowError("brave-policy-boundary-adjacent-release-missing");
  });

  it.each([
    ["wrong host", (release: FixtureRelease) => {
      release.assets[0].browser_download_url = "https://example.test/Brave-Browser-arm64.dmg";
    }, "brave-url-wrong-host"],
    ["wrong version URL", (release: FixtureRelease) => {
      release.assets[0].browser_download_url = release.assets[0].browser_download_url
        .replace("v1.92.141", "v1.92.140");
    }, "brave-asset-wrong-version"],
    ["unsigned asset", (release: FixtureRelease) => {
      release.assets[0].digest = null;
      release.assets = release.assets.filter(({ name }) =>
        name !== "Brave-Browser-arm64.dmg.sha256"
      );
    }, "brave-asset-unsigned"]
  ])("rejects a %s", async (_label, mutate, expected) => {
    const fixtures = releaseFixtures();
    const current = fixtures.releases.find(({ tag_name }) => tag_name === "v1.92.141")!;
    mutate(current);
    await expect(resolveOfficialBuilds({
      versionsResponse: fixtures.versions,
      releases: fixtures.releases,
      boundaryDate: "2024-07-19",
      readChecksum: async (asset: { fixtureText?: string }) => asset.fixtureText ?? ""
    })).rejects.toThrowError(expected);
  });

  it("rejects a channel or Chromium mismatch instead of substituting Chrome evidence", async () => {
    const fixtures = releaseFixtures();
    fixtures.versions["v1.92.141"].dependencies.chrome = "149.0.0.1";
    await expect(resolveOfficialBuilds({
      versionsResponse: fixtures.versions,
      releases: fixtures.releases,
      boundaryDate: "2024-07-19",
      readChecksum: async (asset: { fixtureText?: string }) => asset.fixtureText ?? ""
    })).rejects.toThrowError("brave-chromium-version-mismatch");
  });

  it("updates only exact Brave versions/engine versions and preserves a closed unique slot set", async () => {
    const policy = await readJson("scripts/browser-compatibility/certification-policy.json");
    for (const slot of policy.slots) {
      if (slot.browser.brand !== "Brave") continue;
      slot.id = slot.id.replace(/-brave-[0-9-]+$/u, "-brave-1-0-0");
      slot.browser.version = "1.0.0";
      slot.browser.engineVersion = "1.0.0.0";
      slot.provider.browserVersionLabel = "1.0.0";
    }
    const fixtures = releaseFixtures();
    const builds = await resolveOfficialBuilds({
      versionsResponse: fixtures.versions,
      releases: fixtures.releases,
      boundaryDate: "2024-07-19",
      readChecksum: async (asset: { fixtureText?: string }) => asset.fixtureText ?? ""
    });
    const updated = updatePolicyWithBraveBuilds(
      policy,
      builds,
      "2026-07-19T12:00:00.000Z"
    );
    expect(updated.slots.filter((slot: { browser: { brand: string } }) =>
      slot.browser.brand === "Brave"
    ).every((slot: { browser: { version: string }, braveBuild: "current" | "boundary" }) =>
      slot.browser.version === builds[slot.braveBuild].version
    )).toBe(true);
    expect(new Set(updated.slots.map(({ id }: { id: string }) => id)).size)
      .toBe(updated.slots.length);
  });
});

describe("bounded transport and binary proof", () => {
  it("allows at most three redirects and rejects a redirect to a non-official host", async () => {
    const chainFetch = async (url: URL) => {
      const step = Number(url.searchParams.get("step") ?? "0");
      if (step < 3) {
        return new Response(null, {
          status: 302,
          headers: { location: `https://github.com/brave/brave-browser/releases/download/v1.2.3/a?step=${String(step + 1)}` }
        });
      }
      return new Response("ok", { status: 200 });
    };
    const result = await fetchWithBoundedRedirects(
      "https://github.com/brave/brave-browser/releases/download/v1.2.3/a?step=0",
      { fetchImpl: chainFetch, maxRedirects: 3, purpose: "asset" }
    );
    expect(result.redirects).toBe(3);

    const endless = async () => new Response(null, {
      status: 302,
      headers: { location: "https://github.com/brave/brave-browser/releases/download/v1.2.3/a" }
    });
    await expect(fetchWithBoundedRedirects(
      "https://github.com/brave/brave-browser/releases/download/v1.2.3/a",
      { fetchImpl: endless, maxRedirects: 3, purpose: "asset" }
    )).rejects.toThrowError("brave-redirect-limit-exceeded");

    const hostile = async () => new Response(null, {
      status: 302,
      headers: { location: "https://downloads.example.test/a" }
    });
    await expect(fetchWithBoundedRedirects(
      "https://github.com/brave/brave-browser/releases/download/v1.2.3/a",
      { fetchImpl: hostile, purpose: "asset" }
    )).rejects.toThrowError("brave-url-wrong-host");
  });

  it("requires full SHA-256 values and rejects a mismatched file", async () => {
    const root = await temporaryRoot();
    const path = resolve(root, "brave.bin");
    const bytes = Buffer.from("official brave fixture", "utf8");
    await writeFile(path, bytes);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await expect(verifyFileSha256(path, digest, bytes.length)).resolves.toEqual({
      sha256: digest,
      size: bytes.length
    });
    await expect(verifyFileSha256(path, "0".repeat(64), bytes.length))
      .rejects.toThrowError("brave-download-digest-mismatch");
    expect(() => parseSha256(`${"a".repeat(64)}  Brave-Browser-arm64.dmg`,
      "Brave-Browser-arm64.dmg")).not.toThrow();
    expect(() => parseSha256(
      `${"a".repeat(64)}  BraveBrowserStandaloneSetup_126_1_67_134.exe`,
      "BraveBrowserStandaloneSetup.exe",
      ["BraveBrowserStandaloneSetup_126_1_67_134.exe"]
    )).not.toThrow();
    expect(() => parseSha256(
      `${"a".repeat(64)}  BraveBrowserStandaloneSetup_unsigned.exe`,
      "BraveBrowserStandaloneSetup.exe",
      ["BraveBrowserStandaloneSetup_126_1_67_134.exe"]
    )).toThrowError("brave-checksum-wrong-asset");
    expect(() => parseSha256("abcd", "Brave-Browser-arm64.dmg"))
      .toThrowError("brave-checksum-invalid");
  });

  it("requires branded version output and the official macOS/Windows signer", () => {
    const build = { version: "1.92.141", chromiumVersion: "150.0.7871.128" };
    expect(verifyBraveVersionOutput(
      "Brave Browser 1.92.141 Chromium: 150.0.7871.128 (Official Build)",
      build
    )).toContain("Brave Browser");
    expect(verifyBraveVersionOutput(
      "Brave 150.1.92.141",
      build
    )).toBe("Brave 150.1.92.141");
    expect(() => verifyBraveVersionOutput(
      "Google Chrome 150.0.7871.128",
      build
    )).toThrowError("brave-binary-brand-mismatch");
    expect(() => verifyBraveVersionOutput(
      "Brave Browser 1.92.140 Chromium: 150.0.7871.128",
      build
    )).toThrowError("brave-binary-version-mismatch");
    expect(() => verifyBraveVersionOutput(
      "Brave 149.1.92.141",
      build
    )).toThrowError("brave-binary-version-mismatch");
    expect(verifyMacSignatureOutput([
      "Authority=Developer ID Application: Brave Software, Inc. (KL8N8XSYF4)",
      "Authority=Developer ID Certification Authority",
      "TeamIdentifier=KL8N8XSYF4"
    ].join("\n"))).toContain("Brave Software, Inc.");
    expect(() => verifyMacSignatureOutput(
      "Authority=Developer ID Application: Example, Inc.\nTeamIdentifier=EXAMPLE"
    )).toThrowError("brave-macos-signature-invalid");
    expect(verifyWindowsSignatureRecord({
      status: "Valid",
      subject: "CN=Brave Software, Inc., O=Brave Software, Inc., C=US"
    })).toContain("Brave Software, Inc.");
    expect(() => verifyWindowsSignatureRecord({
      status: "UnknownError",
      subject: "CN=Brave Software, Inc."
    })).toThrowError("brave-windows-signature-invalid");
    expect(() => verifyWindowsSignatureRecord({
      status: "Valid",
      subject: "CN=Example Corp, O=Brave Software, Inc."
    })).toThrowError("brave-windows-signature-invalid");
  });

  it("writes acquisition provenance for both builds without accepting an unlisted role", async () => {
    const root = await temporaryRoot("aval-brave-test-");
    const output = resolve(root, "owned-output");
    const policy = await readJson("scripts/browser-compatibility/certification-policy.json");
    const manifest = await acquireBuilds({
      policy,
      platform: "macos-arm64",
      output,
      acquiredAt: "2026-07-19T12:00:00.000Z",
      acquireOne: async ({ build, outputRoot, role, roleRoot }) => ({
        role,
        version: build.version,
        chromiumVersion: build.chromiumVersion,
        releaseDate: build.releaseDate,
        source: build.assets["macos-arm64"],
        executablePath: `${role}/Brave Browser.app/Contents/MacOS/Brave Browser`,
        signer: "Developer ID Application: Brave Software, Inc. (KL8N8XSYF4)",
        versionOutput: `Brave Browser ${build.version} Chromium: ${build.chromiumVersion}`,
        outputRoot,
        roleRoot
      })
    });
    expect(manifest.builds.map(({ role }) => role)).toEqual(["current", "boundary"]);
    expect(JSON.parse(await readFile(resolve(output, "manifest.json"), "utf8")))
      .toEqual(manifest);

    const wrongArchitecture = structuredClone(policy);
    wrongArchitecture.braveBuilds.current.assets["macos-arm64"].name =
      "Brave-Browser.dmg";
    await expect(acquireBuilds({
      policy: wrongArchitecture,
      platform: "macos-arm64",
      output: resolve(root, "wrong-architecture"),
      acquireOne: async () => {
        throw new Error("must not acquire a wrong-architecture asset");
      }
    })).rejects.toThrowError("brave-build-asset-invalid:current:macos-arm64");
  });
});

describe("Brave matrix planning", () => {
  it("keeps the Windows route ephemeral, signed, branded, and artifact-complete", async () => {
    const workflow = await readFile(
      ".github/workflows/brave-windows-compatibility.yml",
      "utf8"
    );
    expect(workflow).toContain("runs-on: windows-2025");
    expect(workflow).not.toContain("runs-on: windows-11");
    expect(workflow).toContain("hostOperatingSystem = 'Windows Server 2025'");
    expect(workflow).toContain("hostKernelVersion = [System.Environment]::OSVersion.Version.ToString()");
    expect(workflow).toContain("Get-AuthenticodeSignature");
    expect(workflow).toContain("Brave Software, Inc\\.");
    expect(workflow).toContain("& $executable.FullName --version");
    expect(workflow).toContain("--platform windows-x64");
    expect(workflow).toContain("--platform windows");
    expect(workflow).toContain("--tunnel-created-at $env:INPUT_TUNNEL_CREATED_AT");
    expect(workflow).toContain("Remove-Item -LiteralPath $env:BRAVE_INSTALL_ROOT -Recurse -Force");
    expect(workflow).toContain("name: brave-windows-${{ inputs.session_id }}");
    expect(workflow).toContain("name: brave-windows-${{ env.SAFE_SESSION_ID }}");
    expect(workflow).toContain(
      "path: artifacts/browser-compatibility/runs/${{ inputs.source_commit }}/${{ env.SAFE_SESSION_ID }}"
    );
    expect(workflow).toContain("retention-days: 30");
    const matrix = await readFile(
      "scripts/browser-compatibility/brave/run-matrix.mjs",
      "utf8"
    );
    expect(matrix).toContain("brave-manifest-fragment-");
    expect(matrix).toContain("`${mode}-${id}.png`");
    expect(matrix).toContain("canvas[data-aval-layer=\"animated\"]");
    expect(matrix).toContain("brave-run-pixel-witness-invalid");
    for (const match of workflow.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/gu)) {
      expect(match[1]).toMatch(/^[a-f0-9]{40}$/u);
    }
  });

  it("plans four demos in H.264 and ladder modes for each exact branded build", async () => {
    const policy = await readJson("scripts/browser-compatibility/certification-policy.json");
    const manifest = acquisitionManifest(policy, "windows-x64");
    const plans = validateBraveEvidencePlan(planBraveRuns(policy, {
      platform: "windows",
      hostOsVersion: "2025",
      manifest
    }));
    expect(plans).toHaveLength(2);
    expect(plans.map(({ slot }) => slot.id)).toEqual([
      "windows-server-2025-brave-1-67-134",
      "windows-server-2025-brave-1-92-141"
    ]);
    expect(plans.flatMap(({ cases }) => cases)).toHaveLength(16);
    expect(plans.every(({ slot }) => slot.browser.brand === "Brave")).toBe(true);
    expect(plans.every(({ cases }) => cases.some(({ mode }) => mode === "forced-h264") &&
      cases.some(({ mode }) => mode === "full-ladder"))).toBe(true);
    const byDemo = new Map(policy.requirements.demos.map((demo: any) => [demo.id, demo]));
    expect(requiredInteractionEvidence(byDemo.get("end-user-playground"))).toEqual({
      states: ["idle", "engaged"],
      edges: ["idle.engaged", "engaged.idle"]
    });
    expect(requiredInteractionEvidence(byDemo.get("grass-rabbit"))).toEqual({
      states: ["idle", "entering", "hover", "exiting"],
      edges: [
        "idle.entering",
        "entering.hover",
        "hover.exiting",
        "exiting.idle",
        "entering.exiting",
        "exiting.entering"
      ]
    });
  });

  it("selects the exact macOS generation and rejects Chrome as a Brave substitute", async () => {
    const policy = await readJson("scripts/browser-compatibility/certification-policy.json");
    const manifest = acquisitionManifest(policy, "macos-arm64");
    expect(planBraveRuns(policy, {
      platform: "macos",
      hostOsVersion: "26.4",
      manifest
    }).map(({ slot }) => slot.id)).toEqual([
      "macos-26-4-brave-1-67-134",
      "macos-26-4-brave-1-92-141"
    ]);
    expect(() => planBraveRuns(policy, {
      platform: "macos",
      hostOsVersion: "26.5",
      manifest
    })).toThrowError("brave-run-slot-count:0");
    const substituted = structuredClone(policy);
    for (const slot of substituted.slots) {
      if (slot.platform === "windows" && slot.browser.brand === "Brave") {
        slot.browser.brand = "Chrome";
      }
    }
    expect(() => planBraveRuns(substituted, {
      platform: "windows",
      hostOsVersion: "2025",
      manifest: acquisitionManifest(policy, "windows-x64")
    })).toThrowError("brave-run-slot-count:0");

    const extraBuild = acquisitionManifest(policy, "windows-x64");
    extraBuild.builds.push({ ...extraBuild.builds[0], role: "unlisted" });
    expect(() => planBraveRuns(policy, {
      platform: "windows",
      hostOsVersion: "2025",
      manifest: extraBuild
    })).toThrowError("brave-run-install-manifest-invalid");
  });
});

describe("certifying Brave evidence invariants", () => {
  it("uses exact runtime Chromium identity and immutable evidence identifiers", () => {
    expect(assertRuntimeChromiumVersion(
      "150.0.7871.128",
      "150.0.7871.128"
    )).toBe("150.0.7871.128");
    expect(() => assertRuntimeChromiumVersion(
      "150.0.0.0",
      "150.0.7871.128"
    )).toThrowError("brave-run-runtime-chromium-mismatch");
    expect(validateEvidenceIdentity({
      sessionId: "20260719T120000Z-brave",
      sourceCommit: "a".repeat(40)
    })).toEqual({
      sessionId: "20260719T120000Z-brave",
      sourceCommit: "a".repeat(40)
    });
    expect(() => validateEvidenceIdentity({
      sessionId: "latest",
      sourceCommit: "a".repeat(40)
    })).toThrowError("brave-run-session-id-invalid");
    expect(() => validateEvidenceIdentity({
      sessionId: "20260719T120000Z",
      sourceCommit: "HEAD"
    })).toThrowError("brave-run-source-commit-invalid");
  });

  it("keys acquisition evidence by exact host OS generation", () => {
    expect(acquisitionEvidenceFilename("macos", "26.4"))
      .toBe("brave-acquisition-macos-26-4.json");
    expect(acquisitionEvidenceFilename("macos", "15.4"))
      .toBe("brave-acquisition-macos-15-4.json");
    expect(acquisitionEvidenceFilename("windows", "2025"))
      .toBe("brave-acquisition-windows-2025.json");
    expect(manifestFragmentFilename("windows", "2025"))
      .toBe("brave-manifest-fragment-windows-2025.json");
  });

  it("emits Task 7 session, flat checkpoint, ledger, and assembly-fragment shapes", async () => {
    const policy = await readJson("scripts/browser-compatibility/certification-policy.json");
    const slot = policy.slots.find(({ id }: { id: string }) =>
      id === "windows-server-2025-brave-1-92-141"
    );
    expect(slot).toBeDefined();
    const session = createBraveEvidenceSession({
      sessionId: "20260719T120000Z-brave",
      slot,
      sourceCommit: "a".repeat(40),
      testedAt: "2026-07-19T12:02:00.000Z",
      tunnelCreatedAt: "2026-07-19T12:00:00.000Z",
      tunnelUrl: "https://immutable-evidence.example/"
    });
    expect(session).toMatchObject({
      provider: {
        kind: "github-hosted-windows-x64",
        sessionId: "20260719T120000Z-brave_windows-server-2025-brave-1-92-141"
      },
      tunnelUrl: "https://immutable-evidence.example/",
      os: { name: "Windows Server", version: "2025" },
      device: null,
      browser: {
        brand: "Brave",
        version: "1.92.141",
        engine: "Chromium",
        engineVersion: "150.0.7871.128"
      }
    });

    const manifestCases = [];
    const ledgers = [];
    for (const demo of policy.requirements.demos) {
      for (const mode of ["forced-h264", "full-ladder"] as const) {
        const expectedCodecs = expectedTask7Codecs(policy, demo, mode);
        const checkpointInputs = demo.states.map((state: string, index: number) => {
          const beforeCanvasSha256 = createHash("sha256")
            .update(`${demo.id}:${mode}:${state}:before`)
            .digest("hex");
          const pngSha256 = createHash("sha256")
            .update(`${demo.id}:${mode}:${state}:after`)
            .digest("hex");
          return {
            id: state,
            visualState: state,
            advancingFrame: true,
            pngSha256,
            contextPngSha256: createHash("sha256")
              .update(`${demo.id}:${mode}:${state}:context`)
              .digest("hex"),
            frameProof: {
              beforeCanvasSha256,
              afterCanvasSha256: pngSha256,
              sampleIntervalMilliseconds: 50,
              beforeDrawsCompleted: index,
              afterDrawsCompleted: index + 1
            }
          };
        });
        const contract = createBraveCaseEvidenceContract({
          checkpoints: checkpointInputs,
          demo,
          events: rawTask7InteractionEvents(demo),
          expectedAuthoredCodecs: expectedCodecs,
          finishedAt: "2026-07-19T12:01:01.000Z",
          mode,
          soak: {
            requiredMilliseconds: 60_000,
            elapsedMilliseconds: 60_001,
            samples: [
              {
                elapsedMilliseconds: 0,
                terminalFailures: 0,
                counters: task7Counters(0)
              },
              {
                elapsedMilliseconds: 60_001,
                terminalFailures: 0,
                counters: task7Counters(1)
              }
            ]
          },
          startedAt: "2026-07-19T12:00:00.000Z",
          selectedCodec: expectedCodecs[0],
          slotId: slot.id
        });
        expect(contract.ledgerPath).toBe(
          `${slot.id}/${demo.id}/${mode}-interaction-ledger.json`
        );
        expect(contract.manifestCase.checkpoints).toHaveLength(demo.states.length);
        expect(contract.manifestCase.checkpoints[0]).toEqual(expect.objectContaining({
          id: demo.states[0],
          reportPath: `${slot.id}/${demo.id}/${mode}-${demo.states[0]}.json`,
          pngPath: `${slot.id}/${demo.id}/${mode}-${demo.states[0]}.png`
        }));
        manifestCases.push(contract.manifestCase);
        ledgers.push(contract.ledger);
      }
    }
    const manifestSlot = createBraveManifestSlot(slot, manifestCases);
    const fragment = createBraveManifestFragment({
      createdAt: "2026-07-19T12:00:00.000Z",
      sessionId: "20260719T120000Z-brave",
      slots: [manifestSlot],
      sourceCommit: "a".repeat(40)
    });
    expect(fragment.sourceCommit).toBe("a".repeat(40));
    expect(fragment.slots[0]?.cases).toHaveLength(8);

    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const validateSession = ajv.compile(EVIDENCE_SESSION_SCHEMA);
    const validateLedger = ajv.compile(INTERACTION_LEDGER_SCHEMA);
    const validateManifest = ajv.compile(EVIDENCE_MANIFEST_SCHEMA);
    const validateReport = ajv.compile(DIAGNOSTIC_REPORT_SCHEMA);
    expect(validateSession(session), JSON.stringify(validateSession.errors, null, 2)).toBe(true);
    for (const ledger of ledgers) {
      expect(validateLedger(ledger), JSON.stringify(validateLedger.errors, null, 2)).toBe(true);
    }
    const { sourceCommit: fragmentCommit, ...manifestBase } = fragment;
    expect(validateManifest({
      ...manifestBase,
      sourceAttestation: {
        headCommit: fragmentCommit,
        trackedDiffSha256: "1".repeat(64),
        untrackedSourceTreeSha256: "2".repeat(64),
        policySha256: "3".repeat(64),
        servedTreeSha256: "4".repeat(64)
      }
    }), JSON.stringify(validateManifest.errors, null, 2)).toBe(true);
    const report = task7BraveDiagnosticReport(slot, ["h264"], "idle");
    expect(validateReport(report), JSON.stringify(validateReport.errors, null, 2)).toBe(true);
    expect(() => createBraveEvidenceSession({
      sessionId: "20260719T120000Z-brave",
      slot,
      sourceCommit: "a".repeat(40),
      testedAt: "2026-07-19T12:02:00.000Z",
      tunnelCreatedAt: "not-a-time",
      tunnelUrl: "https://immutable-evidence.example/"
    })).toThrowError("brave-run-tunnel-created-at-invalid");
  });

  it("measures the soak threshold with a monotonic injected clock", () => {
    const values = [100, 100, 60_100, 60_101];
    const clock = createMonotonicSoakClock(60, () => values.shift()!);
    expect(clock.shouldContinue()).toBe(true);
    expect(clock.shouldContinue()).toBe(false);
    expect(clock.elapsedMilliseconds()).toBe(60_001);
    const backwards = [100, 99];
    const invalid = createMonotonicSoakClock(60, () => backwards.shift()!);
    expect(() => invalid.shouldContinue())
      .toThrowError("brave-run-soak-clock-nonmonotonic");
  });

  it("requires the selected codec and proof for every earlier ladder skip", async () => {
    const policy = await readJson("scripts/browser-compatibility/certification-policy.json");
    const selectedAv1 = codecSelectionReport("av01.0.08M.08", []);
    expect(assertCodecSelection(
      selectedAv1,
      "end-user-playground",
      "full-ladder",
      policy
    )).toMatchObject({ selectedCodec: "av1", skipped: [] });

    const unprovenH264 = codecSelectionReport("avc1.42E020", []);
    expect(() => assertCodecSelection(
      unprovenH264,
      "end-user-playground",
      "full-ladder",
      policy
    )).toThrowError("brave-run-unproven-codec-skip");

    const provenH264 = codecSelectionReport("avc1.42E020", [
      {
        sourceIndex: 0,
        code: "invalid-output",
        outputFailure: { kind: "display-aspect" },
        phase: "output-validation"
      },
      { sourceIndex: 1, code: "unsupported-config", phase: "probe" },
      {
        sourceIndex: 2,
        code: "decoder-operation",
        exception: { name: "NotSupportedError", message: "unsupported" },
        phase: "decode"
      }
    ]);
    expect(assertCodecSelection(
      provenH264,
      "end-user-playground",
      "full-ladder",
      policy
    )).toMatchObject({
      selectedCodec: "h264",
      skipped: [
        { codec: "av1", sourceIndex: 0 },
        { codec: "vp9", sourceIndex: 1 },
        { codec: "h265", sourceIndex: 2 }
      ]
    });
    const wrongRendition = codecSelectionReport("avc1.42E020", [
      { sourceIndex: 0, code: "unsupported-config", phase: "probe" },
      { sourceIndex: 1, code: "unsupported-config", phase: "probe" },
      { sourceIndex: 2, code: "unsupported-config", phase: "probe" }
    ], "wrong.1x");
    expect(() => assertCodecSelection(
      wrongRendition,
      "end-user-playground",
      "full-ladder",
      policy
    )).toThrowError("brave-run-selected-rendition-mismatch");
    const rendererProvenH264 = codecSelectionReport(
      "avc1.42E020",
      [
        { sourceIndex: 1, code: "unsupported-config", phase: "probe" },
        { sourceIndex: 2, code: "unsupported-config", phase: "probe" }
      ],
      "motion.1x",
      [{ sourceIndex: 0 }]
    );
    expect(assertCodecSelection(
      rendererProvenH264,
      "end-user-playground",
      "full-ladder",
      policy
    )).toMatchObject({ selectedCodec: "h264" });
    rendererProvenH264.latest.element.diagnostics.runtime.rendererDiagnostics.push({
      ...rendererProvenH264.latest.element.diagnostics.runtime.rendererDiagnostics[0],
      phase: "native-upload"
    });
    expect(() => assertCodecSelection(
      rendererProvenH264,
      "end-user-playground",
      "full-ladder",
      policy
    )).toThrowError("brave-run-unproven-codec-skip");
    expect(() => assertCodecSelection(
      codecSelectionReport("vp09.00.10.08", []),
      "end-user-playground",
      "forced-h264",
      policy
    )).toThrowError("brave-run-forced-h264-not-selected");
    const codecLabH264 = codecSelectionReport(
      "avc1.42E020",
      [],
      "video.1x"
    );
    codecLabH264.authoredSources = [codecLabH264.authoredSources[3]];
    expect(() => assertAuthoredSources(
      codecLabH264,
      "grass-rabbit-codecs",
      "full-ladder",
      policy
    )).toThrowError("brave-run-authored-sources-mismatch");
  });

  it("rejects transparent or flat-black screenshots even when their PNG bytes differ", () => {
    const transparent = rgbaPng(8, 8, () => [0, 0, 0, 0]);
    const black = rgbaPng(8, 8, () => [0, 0, 0, 255]);
    const gradient = rgbaPng(16, 16, (x, y) => [
      x * 16,
      y * 16,
      (x + y) * 8,
      255
    ]);
    expect(createHash("sha256").update(transparent).digest("hex"))
      .not.toBe(createHash("sha256").update(black).digest("hex"));
    expect(isMeaningfulPixelWitness(analyzePngWitness(transparent))).toBe(false);
    expect(isMeaningfulPixelWitness(analyzePngWitness(black))).toBe(false);
    expect(isMeaningfulPixelWitness(analyzePngWitness(gradient))).toBe(true);
  });
});

type FixtureAsset = {
  name: string;
  browser_download_url: string;
  digest: string | null;
  fixtureText?: string;
  size: number;
};

type FixtureRelease = {
  tag_name: string;
  name: string;
  body: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  html_url: string;
  assets: FixtureAsset[];
};

function releaseFixtures() {
  const current = fixtureRelease(
    "1.92.141",
    "2026-07-17T08:01:30.000Z",
    "150.0.7871.128",
    ["1".repeat(64), "2".repeat(64)]
  );
  const boundary = fixtureRelease(
    "1.67.134",
    "2024-07-17T06:23:43.000Z",
    "126.0.6478.186",
    [null, null]
  );
  const previous = fixtureRelease(
    "1.67.123",
    "2024-06-25T06:12:42.000Z",
    "126.0.6478.126"
  );
  for (const [index, name] of [
    "Brave-Browser-arm64.dmg",
    "BraveBrowserStandaloneSetup.exe"
  ].entries()) {
    boundary.assets.push({
      name: `${name}.sha256`,
      browser_download_url:
        `https://github.com/brave/brave-browser/releases/download/v1.67.134/${name}.sha256`,
      digest: `sha256:${"f".repeat(64)}`,
      fixtureText: `${index === 0 ? "3" : "4".repeat(64)}  ${name}`,
      size: 90
    });
  }
  boundary.assets.find(({ name }) => name === "Brave-Browser-arm64.dmg.sha256")!
    .fixtureText = `${"3".repeat(64)}  Brave-Browser-arm64.dmg`;
  const later = fixtureRelease(
    "1.68.128",
    "2024-07-24T00:15:07.000Z",
    "127.0.6533.73"
  );
  const beta = fixtureRelease("1.93.1", "2026-07-18T00:00:00.000Z", "151.0.0.1");
  beta.name = "Beta v1.93.1 (Chromium 151.0.0.1)";
  beta.prerelease = true;
  return {
    versions: {
      "v1.92.141": {
        tag: "v1.92.141",
        channel: "release",
        published: "2026-07-17T08:01:30.000Z",
        dependencies: { chrome: "150.0.7871.128" }
      },
      "v1.93.1": {
        tag: "v1.93.1",
        channel: "beta",
        published: "2026-07-18T00:00:00.000Z",
        dependencies: { chrome: "151.0.0.1" }
      }
    },
    releases: [beta, current, later, boundary, previous]
  };
}

function fixtureRelease(
  version: string,
  publishedAt: string,
  chromiumVersion: string,
  digests: readonly (string | null)[] = ["a".repeat(64), "b".repeat(64)]
): FixtureRelease {
  const names = ["Brave-Browser-arm64.dmg", "BraveBrowserStandaloneSetup.exe"];
  return {
    tag_name: `v${version}`,
    name: `Release v${version} (Chromium ${chromiumVersion})`,
    body: "Official stable release.",
    draft: false,
    prerelease: false,
    published_at: publishedAt,
    html_url: `https://github.com/brave/brave-browser/releases/tag/v${version}`,
    assets: names.map((name, index) => ({
      name,
      browser_download_url:
        `https://github.com/brave/brave-browser/releases/download/v${version}/${name}`,
      digest: digests[index] === null ? null : `sha256:${digests[index]}`,
      size: 1_000 + index
    }))
  };
}

function codecSelectionReport(
  selectedCodec: string,
  decoderDiagnostics: readonly Readonly<{
    sourceIndex: number;
    code: string;
    phase: string;
    exception?: Readonly<{ name: string; message: string }>;
    outputFailure?: Readonly<Record<string, unknown>>;
  }>[],
  rendition = "motion.1x",
  rendererDiagnostics: readonly Readonly<{ sourceIndex: number }>[] = []
) {
  const authoredSources = [
    { playerId: "player-1", index: 0, codec: "av01.0.08M.08" },
    { playerId: "player-1", index: 1, codec: "vp09.00.10.08" },
    { playerId: "player-1", index: 2, codec: "hvc1.1.6.L93.B0" },
    { playerId: "player-1", index: 3, codec: "avc1.42E020" }
  ];
  return {
    latest: {
      playerId: "player-1",
      element: {
        diagnostics: {
          sourceGeneration: 1,
          runtime: {
            selectedRendition: rendition,
            selectedCodec,
            decoderDiagnostics: decoderDiagnostics.map((diagnostic) => ({
              ...diagnostic,
              sourceGeneration: 1,
              codec: authoredSources[diagnostic.sourceIndex]?.codec,
              rendition,
              exception: diagnostic.exception ?? null,
              outputFailure: diagnostic.outputFailure ?? null
            })),
            rendererDiagnostics: rendererDiagnostics.map((diagnostic) => ({
              sourceGeneration: 1,
              sourceIndex: diagnostic.sourceIndex,
              codec: authoredSources[diagnostic.sourceIndex]?.codec,
              rendition,
              phase: "rgba-copy",
              operation: "runtime",
              exception: { name: "NotSupportedError", message: "unsupported" },
              glError: null,
              contextLost: false,
              uploadPath: "rgba-copy"
            }))
          }
        }
      }
    },
    authoredSources
  };
}

function expectedTask7Codecs(policy: any, demo: any, mode: "forced-h264" | "full-ladder") {
  if (demo.sourceContract === "h264-only") return ["h264"];
  return [...policy.requirements.authoredCodecsByMode[mode]];
}

function rawTask7InteractionEvents(demo: any) {
  let at = 0;
  const events: any[] = demo.states.map((state: string) => ({
    type: "visualstatechange",
    at: at++,
    detail: { from: null, to: state, edge: null }
  }));
  for (const edge of requiredInteractionEvidence(demo).edges) {
    const [from, to] = edge.split(".");
    events.push({
      type: "transitionstart",
      at: at++,
      detail: { from, to, edge }
    }, {
      type: "transitionend",
      at: at++,
      detail: { from, to, edge }
    });
  }
  return events;
}

function task7Counters(value: number) {
  return {
    outputsAccepted: value,
    drawsCompleted: value,
    logicalRunsCreated: value,
    candidateCommits: value,
    runsClosed: value,
    transitionStarts: value,
    transitionEnds: value,
    loopCrossings: value,
    nativeDecoderCreatesByLane: [value, value],
    nativeDecoderClosesByLane: [value, value]
  };
}

function task7BraveDiagnosticReport(
  slot: any,
  codecs: readonly string[],
  visualState: string
) {
  const codecStrings: Record<string, string> = {
    av1: "av01.0.08M.08",
    vp9: "vp09.00.10.08",
    h265: "hvc1.1.6.L93.B0",
    h264: "avc1.42E020"
  };
  return {
    schemaVersion: 1,
    generatedAt: "2026-07-19T12:00:00.000Z",
    serializationBudgetExhausted: false,
    session: { url: "/?avalDiagnostics=1" },
    environment: {
      userAgent:
        `Mozilla/5.0 Chrome/${slot.browser.engineVersion} Safari/537.36`,
      userAgentData: {
        brands: [{ brand: "Chromium", version: slot.browser.engineVersion.split(".")[0] }],
        mobile: false,
        platform: "Windows"
      },
      capabilities: { braveBrandApi: true }
    },
    players: [],
    authoredSources: codecs.map((codec, index) => ({
      playerId: "player-1",
      index,
      codec: codecStrings[codec]
    })),
    checkpoints: [],
    latest: {
      playerId: "player-1",
      element: {
        readiness: "interactiveReady",
        visualState,
        diagnostics: {
          lastFailure: null,
          sourceGeneration: 1,
          outstanding: {},
          terminalCleanup: null,
          runtime: {
            selectedRendition: "video.1x",
            selectedCodec: codecStrings[codecs[0]!],
            activeTransportBodies: 0,
            pendingLoads: 0,
            interestedWaiters: 0,
            activeLeaseCount: 0,
            pageActiveDecoderSlotCount: 0,
            pageQueuedDecoderTicketCount: 0,
            pageParkedDecoderTicketCount: 0,
            pageParticipantCount: 1,
            cleanupFailureCount: 0,
            playbackLifecycle: task7Counters(1),
            decoderDiagnostics: [],
            rendererDiagnostics: []
          },
          presentation: { backingWidth: 640, backingHeight: 360 }
        }
      }
    }
  };
}

function rgbaPng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number]
) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * (width * 4 + 1);
    rows[rowOffset] = 0;
    for (let x = 0; x < width; x += 1) {
      const rgba = pixel(x, y);
      const offset = rowOffset + 1 + x * 4;
      for (let channel = 0; channel < 4; channel += 1) rows[offset + channel] = rgba[channel]!;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function pngChunk(type: string, data: Buffer) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

function acquisitionManifest(policy: any, platform: "macos-arm64" | "windows-x64") {
  return {
    schemaVersion: 1,
    acquiredAt: "2026-07-19T12:00:00.000Z",
    platform,
    builds: (["current", "boundary"] as const).map((role) => ({
      role,
      version: policy.braveBuilds[role].version,
      chromiumVersion: policy.braveBuilds[role].chromiumVersion,
      releaseDate: policy.braveBuilds[role].releaseDate,
      source: policy.braveBuilds[role].assets[platform],
      executablePath: `${role}/brave${platform === "windows-x64" ? ".exe" : ""}`,
      signer: platform === "macos-arm64"
        ? "Developer ID Application: Brave Software, Inc. (KL8N8XSYF4)"
        : "CN=Brave Software, Inc., O=Brave Software, Inc., C=US",
      versionOutput: `Brave Browser ${policy.braveBuilds[role].version} Chromium: ${policy.braveBuilds[role].chromiumVersion}`
    }))
  };
}

async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function temporaryRoot(prefix = "aval-brave-tooling-") {
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}
