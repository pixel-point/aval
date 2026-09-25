import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

/** Verify the core independently, without installing a framework peer. */
export async function checkCoreConsumer(archive, artifacts, consumer, run) {
  await mkdir(consumer, { recursive: true });
  run("npm", ["install", "--prefix", consumer, "--ignore-scripts", "--no-package-lock", "--offline", "--cache", join(consumer, "npm-cache"),
    "--no-audit", "--no-fund", join(artifacts, archive.filename)]);
  const packageJson = JSON.parse(await readFile(join(consumer, "node_modules/@pixel-point/aval-alpha/package.json"), "utf8"));
  if (Object.keys(packageJson.dependencies ?? {}).length) throw Error("Packed runtime has dependencies");
  await writeFile(join(consumer, "consumer.ts"), `
import { createAvalAlpha, type AlphaSource } from '@pixel-point/aval-alpha';
import { defineAvalAlphaElement, type AvalAlphaElement } from '@pixel-point/aval-alpha/element';
const source: AlphaSource = {src:'clip.mp4',width:32,height:72,colorRect:[0,0,32,32],alphaRect:[0,40,32,32]};
export function create(canvas: HTMLCanvasElement) { return createAvalAlpha(canvas,{sources:[source]}); }
export {defineAvalAlphaElement};
export type Element = AvalAlphaElement;
`);
  run(resolve("node_modules/.bin/tsc"), ["--noEmit", "--strict", "--moduleResolution", "bundler", "--module", "esnext", "--target", "es2022", "consumer.ts"], consumer);
  run("node", ["--input-type=module", "-e", "await import('@pixel-point/aval-alpha'); await import('@pixel-point/aval-alpha/element'); await import('@pixel-point/aval-alpha/adapter');"], consumer);
}
