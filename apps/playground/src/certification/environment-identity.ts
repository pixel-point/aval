const MAXIMUM_ENVIRONMENT_BYTES = 256 * 1024;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export interface BrowserEnvironmentIdentity {
  readonly environmentDigest: string;
  readonly profileId: `profile-${string}`;
}

/** Browser-side equivalent of the certification package's canonical environment identity. */
export async function deriveBrowserEnvironmentIdentity(
  environment: Readonly<Record<string, unknown>>
): Promise<Readonly<BrowserEnvironmentIdentity>> {
  const canonical = `${canonicalValue(environment, "$environment", new Set(), 1)}\n`;
  const bytes = new TextEncoder().encode(canonical);
  if (bytes.byteLength > MAXIMUM_ENVIRONMENT_BYTES) throw new RangeError("environment identity exceeds the byte limit");
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const environmentDigest = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return Object.freeze({
    environmentDigest,
    profileId: `profile-${environmentDigest.slice(0, 20)}`
  });
}

function canonicalValue(
  value: unknown,
  path: string,
  ancestors: Set<object>,
  depth: number
): string {
  if (depth > 64) throw new RangeError(`${path} exceeds the canonical depth limit`);
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) throw new TypeError(`${path} contains an invalid number`);
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (typeof value === "string") {
    rejectUnpairedSurrogates(value, path);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`${path} contains a non-JSON value`);
  if (ancestors.has(value)) throw new TypeError(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => canonicalValue(item, `${path}[${String(index)}]`, ancestors, depth + 1)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${path} must have a plain prototype`);
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record).sort(compareUnicodeScalars).map((key) => {
      if (FORBIDDEN_KEYS.has(key)) throw new TypeError(`${path}.${key} is forbidden`);
      rejectUnpairedSurrogates(key, `${path}.<key>`);
      return `${JSON.stringify(key)}:${canonicalValue(record[key], `${path}.${key}`, ancestors, depth + 1)}`;
    });
    return `{${fields.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function rejectUnpairedSurrogates(value: string, path: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError(`${path} contains an unpaired high surrogate`);
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${path} contains an unpaired low surrogate`);
    }
  }
}

function compareUnicodeScalars(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const leftPoint = leftPoints[index]?.codePointAt(0) ?? 0;
    const rightPoint = rightPoints[index]?.codePointAt(0) ?? 0;
    if (leftPoint !== rightPoint) return leftPoint - rightPoint;
  }
  return leftPoints.length - rightPoints.length;
}
