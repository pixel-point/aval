const HARD_BYTES = Number.MAX_SAFE_INTEGER;
const RESIDENT_ID = /^[a-z][a-z0-9._-]{0,63}$/;

export function rendererResidentKey(group: string, index: number): string {
  if (!RESIDENT_ID.test(group) || !Number.isSafeInteger(index) || index < 0) {
    throw new RangeError("resident frame key is invalid");
  }
  return `${group}\0${String(index)}`;
}

export function rendererCap(value: number | undefined, label: string): number {
  if (value === undefined) return HARD_BYTES;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${label} is invalid`);
  }
  return Math.min(value, HARD_BYTES);
}

export function rendererDiagnosticScalar(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : 0;
}

export function namedError(reason: unknown, name: string): boolean {
  if (typeof reason !== "object" || reason === null) return false;
  try { return (reason as Readonly<{ name?: unknown }>).name === name; }
  catch { return false; }
}
