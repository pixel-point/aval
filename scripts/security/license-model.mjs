import { createHash } from "node:crypto";

export function validateLicensePolicy(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "allowed,denied,reviewRequired,schemaVersion" || input.schemaVersion !== "1.0") throw new Error("license policy fields are invalid");
  for (const key of ["allowed", "reviewRequired", "denied"]) if (!Array.isArray(input[key]) || new Set(input[key]).size !== input[key].length || input[key].some((value) => typeof value !== "string" || !LICENSE_ID.test(value))) throw new Error(`license policy ${key} is invalid`);
  const all = [...input.allowed, ...input.reviewRequired, ...input.denied];
  if (new Set(all).size !== all.length) throw new Error("license policy categories overlap");
  return input;
}

const LICENSE_ID = /^[A-Za-z0-9.+-]{1,64}$/u;

export function createLicenseReport(lockBytes, policyBytes) {
  const lock = parseJson(lockBytes, "lockfile");
  const policy = validateLicensePolicy(parseJson(policyBytes, "license policy"));
  const packages = dependencyLicenseRecords(lock);
  assertAllowed(packages, policy);
  return {
    schemaVersion: "1.0",
    lockfileSha256: sha256(lockBytes),
    policySha256: sha256(policyBytes),
    packages
  };
}

export function reconcileLicenseReport(report, lockBytes, policyBytes) {
  if (report === null || typeof report !== "object" || Array.isArray(report) || Object.keys(report).sort().join(",") !== "lockfileSha256,packages,policySha256,schemaVersion") throw new Error("license report fields are invalid");
  const expected = createLicenseReport(lockBytes, policyBytes);
  if (JSON.stringify(report) !== JSON.stringify(expected)) throw new Error("license report does not reconstruct from lockfile and policy bytes");
  return report;
}

export function dependencyLicenseRecords(lock) {
  return Object.entries(lock.packages ?? {}).filter(([path, entry]) => path.startsWith("node_modules/") && !entry.link).map(([path, entry]) => ({
    path,
    name: entry.name ?? path.split("node_modules/").at(-1),
    version: entry.version,
    license: entry.license ?? null,
    integrity: entry.integrity ?? null
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function assertAllowed(records, policy) {
  const allowed = new Set(policy.allowed);
  const denied = new Set(policy.denied);
  const reviewed = new Set(policy.reviewRequired);
  const failures = [];
  for (const record of records) {
    if (typeof record.name !== "string" || typeof record.version !== "string" || typeof record.integrity !== "string") failures.push(`${record.path}: incomplete lock identity`);
    if (record.license === null) {
      failures.push(`${record.path}: unknown license`);
      continue;
    }
    const atoms = requiredLicenseAtoms(record.license);
    if (atoms === null) {
      failures.push(`${record.path}: unsupported license expression ${record.license}`);
      continue;
    }
    const deniedAtom = atoms.find((license) => denied.has(license));
    const reviewedAtom = atoms.find((license) => reviewed.has(license));
    const unapprovedAtom = atoms.find((license) => !allowed.has(license));
    if (deniedAtom !== undefined) {
      failures.push(atoms.length === 1
        ? `${record.path}: denied license ${deniedAtom}`
        : `${record.path}: denied license ${deniedAtom} in expression ${record.license}`);
    } else if (reviewedAtom !== undefined) {
      failures.push(`${record.path}: license ${record.license} requires an explicit policy record`);
    } else if (unapprovedAtom !== undefined) {
      failures.push(`${record.path}: unapproved license ${unapprovedAtom} in expression ${record.license}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
}

function requiredLicenseAtoms(expression) {
  if (expression.length > 256) return null;
  const atoms = expression.split(" AND ");
  if (atoms.join(" AND ") !== expression || atoms.some((atom) => !LICENSE_ID.test(atom))) return null;
  return atoms;
}

function parseJson(bytes, label) { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch (error) { throw new Error(`${label} is not strict UTF-8 JSON`, { cause: error }); } }
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
