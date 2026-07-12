import { IDENTIFIER_PATTERN } from "@rendered-motion/format";

import { CompilerError } from "./diagnostics.js";

export function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

export function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  path: string,
  optional: readonly string[] = []
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      invalid(path, `contains unknown field ${String(key)}`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      invalid(`${path}.${key}`, "is required");
    }
  }
}

export function boundedArray(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): readonly unknown[] {
  if (!Array.isArray(value)) invalid(path, "must be an array");
  if (value.length < minimum || value.length > maximum) {
    invalid(
      path,
      `must contain ${String(minimum)} to ${String(maximum)} entries`
    );
  }
  return value;
}

export function tuple(
  value: unknown,
  length: number,
  path: string
): readonly unknown[] {
  return boundedArray(value, path, length, length);
}

export function identifier(value: unknown, path: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    invalid(path, `must match ${String(IDENTIFIER_PATTERN)}`);
  }
  return value;
}

export function integer(
  value: unknown,
  path: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(
      path,
      `must be a safe integer from ${String(minimum)} to ${String(maximum)}`
    );
  }
  return value;
}

export function literal<T extends string | number>(
  value: unknown,
  expected: T,
  path: string
): T {
  if (value !== expected) invalid(path, `must be ${String(expected)}`);
  return expected;
}

export function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    invalid(path, `must be one of ${values.join(", ")}`);
  }
  return value as T[number];
}

export function optionalIdentifier(
  value: unknown,
  path: string
): string | undefined {
  return value === undefined ? undefined : identifier(value, path);
}

export function sortUniqueById<T extends { readonly id: string }>(
  values: readonly T[],
  path: string
): readonly T[] {
  const result = [...values].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1]!.id === result[index]!.id) {
      invalid(path, `duplicates id ${result[index]!.id}`);
    }
  }
  return Object.freeze(result);
}

export function invalid(path: string, message: string): never {
  throw new CompilerError("INPUT_INVALID", `${path} ${message}`, {
    field: path
  });
}
