/** Accepts ordinary records from this realm or another same-origin realm. */
export function isPlainRecord(
  value: unknown
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  try {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype === null || prototype === Object.prototype) return true;
    if (Object.getPrototypeOf(prototype) !== null) return false;
    const constructor = Object.getOwnPropertyDescriptor(
      prototype,
      "constructor"
    );
    return constructor !== undefined && "value" in constructor &&
      typeof constructor.value === "function" &&
      constructor.value.name === "Object" &&
      constructor.enumerable === false;
  } catch {
    return false;
  }
}
