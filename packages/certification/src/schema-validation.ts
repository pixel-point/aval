import {
  SHA256_PATTERN,
  type DigestReference,
  type DisplayCertificationReport,
  type RuntimeCertificationReport,
  type RuntimeEnvironment
} from "./model.js";
import {
  CertificationValidationError,
  assertCertificationStatus
} from "./status.js";
import {
  RELEASE_RUNTIME_REPETITIONS,
  DISPLAY_OBSERVATION_LEDGER_ATTACHMENT_ID,
  DISPLAY_RAW_CAPTURE_ATTACHMENT_ID,
  FATAL_ERROR_BOUNDARY_ATTACHMENT_ID,
  REQUIRED_DISPLAY_CRITERION_IDS,
  REQUIRED_RUNTIME_CRITERION_IDS,
  scenarioAttachmentId,
  validateScenarioCoverage
} from "./scenario-contract.js";
import { parseCaptureProvenance } from "./display-evidence-model.js";
import {
  browserBuildMatchesProductVersion,
  isExactBrowserBuild,
  isExactProductVersion
} from "./exact-version.js";

const MAX_ATTACHMENTS = 256;
const MAX_CRITERIA = 256;
const MAX_SCENARIOS = 256;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const CAPABILITY_KEY = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/u;

export function validateRuntimeReport(input: unknown): RuntimeCertificationReport {
  const report = object(input, "$runtime");
  rejectObservedDisplayFields(report, "$runtime");
  assertKeys(report, "$runtime", [
    "schemaVersion", "reportKind", "reportId", "status", "candidateManifestDigest",
    "commit", "tree", "startedAt", "endedAt", "operatorRole", "reviewerIds",
    "environment", "scenarios", "criteria", "attachments", "supersedes", "withdrawalReason"
  ]);
  scanUnsafeMetadata(report, "$runtime");
  literal(report.schemaVersion, "1.0", "$runtime.schemaVersion");
  literal(report.reportKind, "runtime-scheduling", "$runtime.reportKind");
  const reportId = identifier(report.reportId, "$runtime.reportId");
  assertCertificationStatus(report.status, "$runtime.status");
  const status = report.status;
  const candidateManifestDigest = digest(report.candidateManifestDigest, "$runtime.candidateManifestDigest");
  const commit = boundedString(report.commit, "$runtime.commit", 128);
  const tree = boundedString(report.tree, "$runtime.tree", 128);
  const startedAt = timestamp(report.startedAt, "$runtime.startedAt");
  const endedAt = timestamp(report.endedAt, "$runtime.endedAt");
  if (Date.parse(endedAt) < Date.parse(startedAt)) fail("$runtime.endedAt", "must not precede startedAt");
  const operatorRole = boundedString(report.operatorRole, "$runtime.operatorRole", 128);
  const reviewerIds = uniqueStrings(report.reviewerIds, "$runtime.reviewerIds", 16);
  const environment = validateEnvironment(report.environment, "$runtime.environment");
  const scenarios = boundedArray(report.scenarios, "$runtime.scenarios", MAX_SCENARIOS).map((value, index) => {
    const scenario = object(value, `$runtime.scenarios[${index}]`);
    assertKeys(scenario, `$runtime.scenarios[${index}]`, ["id", "repetition", "seed", "status", "boundaryCount", "frameCount", "operationCount", "headedOperationCount", "formatUnderflows", "firstFailingOrdinal", "ledgerDigest"]);
    assertCertificationStatus(scenario.status, `$runtime.scenarios[${index}].status`);
    const firstFailingOrdinal = scenario.firstFailingOrdinal === undefined
      ? undefined
      : nonnegativeInteger(scenario.firstFailingOrdinal, `$runtime.scenarios[${index}].firstFailingOrdinal`);
    const operationCount = scenario.operationCount === undefined
      ? undefined
      : nonnegativeInteger(scenario.operationCount, `$runtime.scenarios[${index}].operationCount`);
    const headedOperationCount = scenario.headedOperationCount === undefined
      ? undefined
      : nonnegativeInteger(scenario.headedOperationCount, `$runtime.scenarios[${index}].headedOperationCount`);
    return {
      id: identifier(scenario.id, `$runtime.scenarios[${index}].id`),
      repetition: boundedInteger(scenario.repetition, `$runtime.scenarios[${index}].repetition`, 1, RELEASE_RUNTIME_REPETITIONS),
      seed: nonnegativeInteger(scenario.seed, `$runtime.scenarios[${index}].seed`),
      status: scenario.status,
      boundaryCount: nonnegativeInteger(scenario.boundaryCount, `$runtime.scenarios[${index}].boundaryCount`),
      frameCount: nonnegativeInteger(scenario.frameCount, `$runtime.scenarios[${index}].frameCount`),
      ...(operationCount === undefined ? {} : { operationCount }),
      ...(headedOperationCount === undefined ? {} : { headedOperationCount }),
      formatUnderflows: nonnegativeInteger(scenario.formatUnderflows, `$runtime.scenarios[${index}].formatUnderflows`),
      ...(firstFailingOrdinal === undefined ? {} : { firstFailingOrdinal }),
      ledgerDigest: digest(scenario.ledgerDigest, `$runtime.scenarios[${index}].ledgerDigest`)
    };
  });
  rejectDuplicateScenarioRepetitions(scenarios, "$runtime.scenarios");
  const criteria = validateCriteria(report.criteria, "$runtime.criteria");
  const attachments = validateAttachments(report.attachments, "$runtime.attachments");
  const supersedes = report.supersedes === undefined ? undefined : identifier(report.supersedes, "$runtime.supersedes");
  const withdrawalReason = report.withdrawalReason === undefined ? undefined : boundedString(report.withdrawalReason, "$runtime.withdrawalReason", 2_000);
  if (status === "withdrawn" && withdrawalReason === undefined) fail("$runtime.withdrawalReason", "required for withdrawn reports");
  if (status === "passed") {
    if (reviewerIds.length < 2) fail("$runtime.reviewerIds", "passed runtime reports require two reviewers");
    if (scenarios.length === 0) fail("$runtime.scenarios", "passed runtime report requires scenarios");
    const coverageFailures = validateScenarioCoverage(scenarios);
    if (coverageFailures.length > 0) fail("$runtime.scenarios", `required scenario coverage is incomplete: ${coverageFailures[0]}`);
    if (scenarios.some((scenario) => scenario.status !== "passed" || scenario.formatUnderflows !== 0)) fail("$runtime.scenarios", "passed report contains a non-passing scenario");
    requireCriterionIds(criteria, REQUIRED_RUNTIME_CRITERION_IDS, "$runtime.criteria");
    if (criteria.some((criterion) => criterion.status !== "passed")) fail("$runtime.criteria", "passed report contains a non-passing criterion");
    if (attachments.length === 0) fail("$runtime.attachments", "passed runtime report requires evidence attachments");
    bindCriterionEvidence(criteria, attachments, "$runtime.criteria");
    const fatalErrorBoundaryAttachment = attachments.find(({ id }) => id === FATAL_ERROR_BOUNDARY_ATTACHMENT_ID);
    if (fatalErrorBoundaryAttachment === undefined) fail("$runtime.attachments", `fatal error-boundary attachment is missing: ${FATAL_ERROR_BOUNDARY_ATTACHMENT_ID}`);
    if (fatalErrorBoundaryAttachment.mediaType !== "application/json") fail("$runtime.attachments", "fatal error-boundary attachment must use application/json");
    const fatalErrorBoundaryCriterion = criteria.find(({ id }) => id === "runtime-fatal-error-boundary");
    if (fatalErrorBoundaryCriterion === undefined || !fatalErrorBoundaryCriterion.evidence.includes(FATAL_ERROR_BOUNDARY_ATTACHMENT_ID)) {
      fail("$runtime.criteria", "fatal error-boundary criterion is not bound to its raw ledger");
    }
    for (const scenario of scenarios) {
      const id = scenarioAttachmentId(scenario.id, scenario.repetition);
      const attachment = attachments.find((candidate) => candidate.id === id);
      if (attachment === undefined) fail("$runtime.attachments", `scenario ledger attachment is missing: ${id}`);
      if (attachment.sha256 !== scenario.ledgerDigest) fail("$runtime.scenarios", `scenario ledger digest mismatch: ${scenario.id}#${String(scenario.repetition)}`);
    }
  }
  return {
    schemaVersion: "1.0",
    reportKind: "runtime-scheduling",
    reportId,
    status,
    candidateManifestDigest,
    commit,
    tree,
    startedAt,
    endedAt,
    operatorRole,
    reviewerIds,
    environment,
    scenarios,
    criteria,
    attachments,
    ...(supersedes === undefined ? {} : { supersedes }),
    ...(withdrawalReason === undefined ? {} : { withdrawalReason })
  };
}

export function validateDisplayReport(input: unknown): DisplayCertificationReport {
  const report = object(input, "$display");
  rejectRuntimeOnlyEvidence(report, "$display");
  assertKeys(report, "$display", [
    "schemaVersion", "reportKind", "reportId", "status", "candidateManifestDigest",
    "runtimeReportId", "runtimeReportDigest", "runtimeReportStatus", "runtimeScenarioId",
    "runtimeScenarioRepetition", "runtimeScenarioLedgerDigest", "patternDigest", "method",
    "captureRateMilliHz", "measuredRefreshMilliHz", "minimumConfidenceMillionths",
    "startedAt", "endedAt", "observationCount", "refreshCount", "distinctAppearanceCount",
    "thresholdMicroseconds", "firstFailingRefreshOrdinal", "observationLedgerDigest",
    "captureProvenance", "criteria", "attachments"
  ]);
  scanUnsafeMetadata(report, "$display");
  literal(report.schemaVersion, "1.0", "$display.schemaVersion");
  literal(report.reportKind, "observed-display", "$display.reportKind");
  assertCertificationStatus(report.status, "$display.status");
  literal(report.runtimeReportStatus, "passed", "$display.runtimeReportStatus");
  const method = report.method;
  if (method !== "external-high-speed-capture" && method !== "qualified-scanout-trace") {
    fail("$display.method", "unsupported observation method");
  }
  const captureRateMilliHz = positiveInteger(report.captureRateMilliHz, "$display.captureRateMilliHz");
  const measuredRefreshMilliHz = positiveInteger(report.measuredRefreshMilliHz, "$display.measuredRefreshMilliHz");
  if (method === "external-high-speed-capture" && captureRateMilliHz / measuredRefreshMilliHz < 4) {
    fail("$display.captureRateMilliHz", "external capture must be at least four times refresh");
  }
  const firstFailingRefreshOrdinal = report.firstFailingRefreshOrdinal === null
    ? null
    : nonnegativeInteger(report.firstFailingRefreshOrdinal, "$display.firstFailingRefreshOrdinal");
  const startedAt = timestamp(report.startedAt, "$display.startedAt");
  const endedAt = timestamp(report.endedAt, "$display.endedAt");
  if (Date.parse(endedAt) < Date.parse(startedAt)) fail("$display.endedAt", "must not precede startedAt");
  const criteria = validateCriteria(report.criteria, "$display.criteria");
  const attachments = validateAttachments(report.attachments, "$display.attachments");
  const observationLedgerDigest = digest(report.observationLedgerDigest, "$display.observationLedgerDigest");
  const ledgerAttachment = attachments.find(({ id }) => id === DISPLAY_OBSERVATION_LEDGER_ATTACHMENT_ID);
  if (ledgerAttachment === undefined) fail("$display.attachments", `required attachment is missing: ${DISPLAY_OBSERVATION_LEDGER_ATTACHMENT_ID}`);
  if (ledgerAttachment.mediaType !== "application/json" || ledgerAttachment.sha256 !== observationLedgerDigest) fail("$display.observationLedgerDigest", "observation ledger attachment identity mismatch");
  const rawCapture = attachments.find(({ id }) => id === DISPLAY_RAW_CAPTURE_ATTACHMENT_ID);
  if (rawCapture === undefined) fail("$display.attachments", `required attachment is missing: ${DISPLAY_RAW_CAPTURE_ATTACHMENT_ID}`);
  const captureProvenance = parseCaptureProvenance(report.captureProvenance, "$display.captureProvenance");
  if (captureProvenance.rawCaptureDigest !== rawCapture.sha256) fail("$display.captureProvenance.rawCaptureDigest", "raw capture attachment identity mismatch");
  if (report.status === "passed") {
    if (nonnegativeInteger(report.observationCount, "$display.observationCount") === 0) fail("$display.observationCount", "passed display report requires observations");
    requireCriterionIds(criteria, REQUIRED_DISPLAY_CRITERION_IDS, "$display.criteria");
    if (criteria.some((criterion) => criterion.status !== "passed")) fail("$display.criteria", "passed display report contains a non-passing criterion");
    bindCriterionEvidence(criteria, attachments, "$display.criteria");
    for (const criterion of criteria) {
      if (!criterion.evidence.includes(DISPLAY_OBSERVATION_LEDGER_ATTACHMENT_ID) || !criterion.evidence.includes(DISPLAY_RAW_CAPTURE_ATTACHMENT_ID)) fail("$display.criteria", `criterion ${criterion.id} is not bound to both raw display artifacts`);
    }
  }
  return {
    schemaVersion: "1.0",
    reportKind: "observed-display",
    reportId: identifier(report.reportId, "$display.reportId"),
    status: report.status,
    candidateManifestDigest: digest(report.candidateManifestDigest, "$display.candidateManifestDigest"),
    runtimeReportId: identifier(report.runtimeReportId, "$display.runtimeReportId"),
    runtimeReportDigest: digest(report.runtimeReportDigest, "$display.runtimeReportDigest"),
    runtimeReportStatus: "passed",
    runtimeScenarioId: identifier(report.runtimeScenarioId, "$display.runtimeScenarioId"),
    runtimeScenarioRepetition: boundedInteger(report.runtimeScenarioRepetition, "$display.runtimeScenarioRepetition", 1, RELEASE_RUNTIME_REPETITIONS),
    runtimeScenarioLedgerDigest: digest(report.runtimeScenarioLedgerDigest, "$display.runtimeScenarioLedgerDigest"),
    patternDigest: digest(report.patternDigest, "$display.patternDigest"),
    method,
    captureRateMilliHz,
    measuredRefreshMilliHz,
    minimumConfidenceMillionths: boundedInteger(report.minimumConfidenceMillionths, "$display.minimumConfidenceMillionths", 0, 1_000_000),
    startedAt,
    endedAt,
    observationCount: nonnegativeInteger(report.observationCount, "$display.observationCount"),
    refreshCount: nonnegativeInteger(report.refreshCount, "$display.refreshCount"),
    distinctAppearanceCount: nonnegativeInteger(report.distinctAppearanceCount, "$display.distinctAppearanceCount"),
    thresholdMicroseconds: nonnegativeInteger(report.thresholdMicroseconds, "$display.thresholdMicroseconds"),
    firstFailingRefreshOrdinal,
    observationLedgerDigest,
    captureProvenance,
    criteria,
    attachments
  };
}

function bindCriterionEvidence(
  criteria: readonly { readonly id: string; readonly evidence: readonly string[] }[],
  attachments: readonly DigestReference[],
  path: string
): void {
  const ids = new Set(attachments.map(({ id }) => id));
  for (const criterion of criteria) {
    for (const evidence of criterion.evidence) if (!ids.has(evidence)) fail(path, `criterion ${criterion.id} references missing attachment: ${evidence}`);
  }
}

export function validateRuntimeEnvironment(input: unknown): RuntimeEnvironment {
  return validateEnvironment(input, "$environment");
}

function validateEnvironment(input: unknown, path: string): RuntimeEnvironment {
  const environment = object(input, path);
  assertKeys(environment, path, ["platformClass", "browser", "os", "hardware", "display", "power", "capabilities"]);
  const browser = object(environment.browser, `${path}.browser`);
  const os = object(environment.os, `${path}.os`);
  const hardware = object(environment.hardware, `${path}.hardware`);
  const display = object(environment.display, `${path}.display`);
  const power = object(environment.power, `${path}.power`);
  assertKeys(browser, `${path}.browser`, ["product", "version", "build", "channel", "engineVersion", "flags", "profileClean"]);
  assertKeys(os, `${path}.os`, ["product", "version", "build", "architecture", "patchState"]);
  assertKeys(hardware, `${path}.hardware`, ["deviceClass", "cpu", "gpu", "driver", "physicalMemoryMiB", "virtualization", "decoderMode"]);
  assertKeys(display, `${path}.display`, ["displayClass", "connection", "nativeWidth", "nativeHeight", "width", "height", "refreshMilliHz", "devicePixelRatioMilli", "colorMode", "hdr", "multiDisplay"]);
  assertKeys(power, `${path}.power`, ["source", "mode", "chargeRange", "browserEnergyMode", "thermal", "backgroundLoad"]);
  const decoderMode = hardware.decoderMode;
  if (decoderMode !== "hardware" && decoderMode !== "software" && decoderMode !== "unknown") fail(`${path}.hardware.decoderMode`, "invalid decoder mode");
  const virtualization = hardware.virtualization;
  if (virtualization !== "none" && virtualization !== "virtualized" && virtualization !== "unknown") fail(`${path}.hardware.virtualization`, "invalid virtualization state");
  const source = power.source;
  if (source !== "ac" && source !== "battery" && source !== "unknown") fail(`${path}.power.source`, "invalid power source");
  const capabilitiesInput = object(environment.capabilities, `${path}.capabilities`);
  if (Object.keys(capabilitiesInput).length > 128) fail(`${path}.capabilities`, "too many capability fields");
  const capabilities: Record<string, boolean | number | string> = Object.create(null) as Record<string, boolean | number | string>;
  for (const [key, value] of Object.entries(capabilitiesInput)) {
    if (!CAPABILITY_KEY.test(key)) fail(`${path}.capabilities.<key>`, "invalid capability key");
    if (typeof value === "number") finiteNumber(value, `${path}.capabilities.${key}`);
    else if (typeof value === "string") boundedString(value, `${path}.capabilities.${key}`, 512);
    else if (typeof value !== "boolean") fail(`${path}.capabilities.${key}`, "capability must be boolean, number, or string");
    capabilities[key] = value;
  }
  const browserProduct = boundedString(browser.product, `${path}.browser.product`, 128);
  const browserVersion = exactProductVersion(browser.version, `${path}.browser.version`);
  const browserBuild = exactBrowserBuild(browser.build, `${path}.browser.build`);
  if (!browserBuildMatchesProductVersion(browserProduct, browserVersion, browserBuild)) {
    fail(`${path}.browser.build`, "browser build does not match the product version");
  }
  const result: RuntimeEnvironment = {
    platformClass: identifier(environment.platformClass, `${path}.platformClass`),
    browser: {
      product: browserProduct,
      version: browserVersion,
      build: browserBuild,
      channel: boundedString(browser.channel, `${path}.browser.channel`, 64),
      engineVersion: fullVersion(browser.engineVersion, `${path}.browser.engineVersion`),
      flags: uniqueStrings(browser.flags, `${path}.browser.flags`, 64),
      profileClean: booleanValue(browser.profileClean, `${path}.browser.profileClean`)
    },
    os: {
      product: boundedString(os.product, `${path}.os.product`, 128),
      version: exactProductVersion(os.version, `${path}.os.version`),
      build: boundedString(os.build, `${path}.os.build`, 128),
      architecture: boundedString(os.architecture, `${path}.os.architecture`, 64),
      patchState: boundedString(os.patchState, `${path}.os.patchState`, 128)
    },
    hardware: {
      deviceClass: boundedString(hardware.deviceClass, `${path}.hardware.deviceClass`, 128),
      cpu: boundedString(hardware.cpu, `${path}.hardware.cpu`, 256),
      gpu: boundedString(hardware.gpu, `${path}.hardware.gpu`, 256),
      driver: boundedString(hardware.driver, `${path}.hardware.driver`, 256),
      physicalMemoryMiB: positiveInteger(hardware.physicalMemoryMiB, `${path}.hardware.physicalMemoryMiB`),
      virtualization,
      decoderMode
    },
    display: {
      displayClass: boundedString(display.displayClass, `${path}.display.displayClass`, 128),
      connection: boundedString(display.connection, `${path}.display.connection`, 128),
      nativeWidth: positiveInteger(display.nativeWidth, `${path}.display.nativeWidth`),
      nativeHeight: positiveInteger(display.nativeHeight, `${path}.display.nativeHeight`),
      width: positiveInteger(display.width, `${path}.display.width`),
      height: positiveInteger(display.height, `${path}.display.height`),
      refreshMilliHz: positiveInteger(display.refreshMilliHz, `${path}.display.refreshMilliHz`),
      devicePixelRatioMilli: positiveInteger(display.devicePixelRatioMilli, `${path}.display.devicePixelRatioMilli`),
      colorMode: boundedString(display.colorMode, `${path}.display.colorMode`, 128),
      hdr: booleanValue(display.hdr, `${path}.display.hdr`),
      multiDisplay: booleanValue(display.multiDisplay, `${path}.display.multiDisplay`)
    },
    power: {
      source,
      mode: boundedString(power.mode, `${path}.power.mode`, 128),
      chargeRange: boundedString(power.chargeRange, `${path}.power.chargeRange`, 128),
      browserEnergyMode: boundedString(power.browserEnergyMode, `${path}.power.browserEnergyMode`, 128),
      thermal: boundedString(power.thermal, `${path}.power.thermal`, 128),
      backgroundLoad: boundedString(power.backgroundLoad, `${path}.power.backgroundLoad`, 512)
    },
    capabilities
  };
  scanUnsafeMetadata(result, path);
  return result;
}

function validateCriteria(input: unknown, path: string) {
  const criteria = boundedArray(input, path, MAX_CRITERIA).map((value, index) => {
    const criterion = object(value, `${path}[${index}]`);
    assertKeys(criterion, `${path}[${index}]`, ["id", "status", "evidence", "summary"]);
    assertCertificationStatus(criterion.status, `${path}[${index}].status`);
    const summary = criterion.summary === undefined ? undefined : boundedString(criterion.summary, `${path}[${index}].summary`, 2_000);
    return {
      id: identifier(criterion.id, `${path}[${index}].id`),
      status: criterion.status,
      evidence: uniqueStrings(criterion.evidence, `${path}[${index}].evidence`, 128),
      ...(summary === undefined ? {} : { summary })
    };
  });
  rejectDuplicateIds(criteria, path);
  return criteria;
}

function requireCriterionIds(
  criteria: readonly { readonly id: string; readonly evidence: readonly string[] }[],
  required: readonly string[],
  path: string
): void {
  const ids = new Set(criteria.map(({ id }) => id));
  for (const id of required) if (!ids.has(id)) fail(path, `required criterion is missing: ${id}`);
  const empty = criteria.find(({ evidence }) => evidence.length === 0);
  if (empty !== undefined) fail(path, `criterion has no evidence: ${empty.id}`);
}

function validateAttachments(input: unknown, path: string): readonly DigestReference[] {
  const attachments = boundedArray(input, path, MAX_ATTACHMENTS).map((value, index) => {
    const item = object(value, `${path}[${index}]`);
    assertKeys(item, `${path}[${index}]`, ["id", "path", "sha256", "byteLength", "mediaType"]);
    const attachment: DigestReference = {
      id: identifier(item.id, `${path}[${index}].id`),
      path: safeRelativePath(item.path, `${path}[${index}].path`),
      sha256: digest(item.sha256, `${path}[${index}].sha256`),
      byteLength: nonnegativeInteger(item.byteLength, `${path}[${index}].byteLength`),
      mediaType: boundedString(item.mediaType, `${path}[${index}].mediaType`, 128)
    };
    return attachment;
  });
  rejectDuplicateIds(attachments, path);
  rejectDuplicateStrings(attachments.map((item) => item.path), `${path}.path`);
  return attachments;
}

function rejectObservedDisplayFields(report: Record<string, unknown>, path: string): void {
  for (const field of ["displayedTime", "scanoutTime", "observedRefreshOrdinal", "observedDisplayPassed"]) {
    if (field in report) fail(`${path}.${field}`, "observed-display evidence is forbidden in runtime reports");
  }
}

function rejectRuntimeOnlyEvidence(report: Record<string, unknown>, path: string): void {
  for (const field of ["requestAnimationFrame", "rafTime", "canvasSubmissionTime", "readPixels", "screenshotTime", "videoFrameTimestamp"]) {
    if (field in report) fail(`${path}.${field}`, "runtime callback evidence cannot be used as observed display evidence");
  }
}

function scanUnsafeMetadata(value: unknown, path: string): void {
  if (typeof value === "string") {
    if (/^(?:\/|[A-Za-z]:[\\/]|~[\\/])/u.test(value)) fail(path, "absolute or home path is forbidden");
    if (/https?:\/\/[^\s?]+\?[^\s]+/iu.test(value)) fail(path, "URL query is forbidden");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanUnsafeMetadata(item, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/serial|username|user-name|profile-path/iu.test(key)) fail(`${path}.${key}`, "personal or serial metadata field is forbidden");
      scanUnsafeMetadata(item, `${path}.${key}`);
    }
  }
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(path, "expected object");
  return value as Record<string, unknown>;
}

function assertKeys(value: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) fail(`${path}.${key}`, "unknown field");
}

function boundedArray(value: unknown, path: string, maximum: number): readonly unknown[] {
  if (!Array.isArray(value)) fail(path, "expected array");
  if (value.length > maximum) fail(path, `array exceeds ${maximum} items`);
  return value;
}

function boundedString(value: unknown, path: string, maximum: number): string {
  if (typeof value !== "string") fail(path, "expected string");
  if (value.length === 0 || value.length > maximum) fail(path, `string length must be 1..${maximum}`);
  return value;
}

function identifier(value: unknown, path: string): string {
  const result = boundedString(value, path, 128);
  if (!ID.test(result)) fail(path, "invalid identifier");
  return result;
}

function digest(value: unknown, path: string): string {
  const result = boundedString(value, path, 64);
  if (!SHA256_PATTERN.test(result)) fail(path, "expected lowercase SHA-256");
  return result;
}

function safeRelativePath(value: unknown, path: string): string {
  const result = boundedString(value, path, 1_024);
  if (result.includes("\\") || result.startsWith("/") || /^(?:[A-Za-z]:|~)/u.test(result)) fail(path, "absolute or platform-specific path is forbidden");
  const parts = result.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) fail(path, "path traversal or empty segment is forbidden");
  if (result.includes("?")) fail(path, "URL query is forbidden");
  return result;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "expected finite number");
  return value;
}

function nonnegativeInteger(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (!Number.isSafeInteger(result) || result < 0) fail(path, "expected nonnegative safe integer");
  return result;
}

function positiveInteger(value: unknown, path: string): number {
  const result = nonnegativeInteger(value, path);
  if (result === 0) fail(path, "expected positive integer");
  return result;
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  const result = nonnegativeInteger(value, path);
  if (result < minimum || result > maximum) fail(path, `expected integer in ${minimum}..${maximum}`);
  return result;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected boolean");
  return value;
}

function timestamp(value: unknown, path: string): string {
  const result = boundedString(value, path, 32);
  const milliseconds = Date.parse(result);
  const normalized = result.length === 20 ? result.replace("Z", ".000Z") : result;
  if (!ISO_UTC.test(result) || !Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) fail(path, "expected canonical UTC timestamp");
  return result;
}

function fullVersion(value: unknown, path: string): string {
  const result = boundedString(value, path, 128);
  if (/^(?:latest|stable|current)$/iu.test(result) || !/\d/u.test(result)) fail(path, "exact version/build is required");
  return result;
}

function exactProductVersion(value: unknown, path: string): string {
  const result = boundedString(value, path, 128);
  if (!isExactProductVersion(result)) fail(path, "exact version is required");
  return result;
}

function exactBrowserBuild(value: unknown, path: string): string {
  const result = boundedString(value, path, 128);
  if (!isExactBrowserBuild(result)) fail(path, "exact browser build is required");
  return result;
}

function literal<T extends string>(value: unknown, expected: T, path: string): asserts value is T {
  if (value !== expected) fail(path, `expected ${expected}`);
}

function uniqueStrings(value: unknown, path: string, maximum: number): readonly string[] {
  const result = boundedArray(value, path, maximum).map((item, index) => boundedString(item, `${path}[${index}]`, 256));
  rejectDuplicateStrings(result, path);
  return result;
}

function rejectDuplicateIds(values: readonly { readonly id: string }[], path: string): void {
  rejectDuplicateStrings(values.map((value) => value.id), `${path}.id`);
}

function rejectDuplicateScenarioRepetitions(
  values: readonly { readonly id: string; readonly repetition: number }[],
  path: string
): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const key = `${value.id}#${String(value.repetition)}`;
    if (seen.has(key)) fail(`${path}[${index}]`, "duplicate scenario/repetition pair");
    seen.add(key);
  });
}

function rejectDuplicateStrings(values: readonly string[], path: string): void {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) fail(`${path}[${index}]`, "duplicate value");
    seen.add(value);
  });
}

function rejectDuplicateNumbers(values: readonly number[], path: string): void {
  const seen = new Set<number>();
  values.forEach((value, index) => {
    if (seen.has(value)) fail(`${path}[${index}]`, "duplicate value");
    seen.add(value);
  });
}

function fail(path: string, message: string): never {
  throw new CertificationValidationError(path, message);
}
