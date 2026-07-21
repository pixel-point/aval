import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function loadCertificationSchema(name: string): Promise<unknown> {
  if (!/^[a-z0-9-]+\.schema\.json$/u.test(name)) {
    throw new TypeError("schema name is invalid");
  }
  const url = new URL(`../../../schemas/${name}`, import.meta.url);
  return JSON.parse(await readFile(fileURLToPath(url), "utf8")) as unknown;
}
