import { createAlphaBinding, createAlphaConfiguration, type AlphaBinding, type AlphaStatus } from "@pixel-point/aval-alpha/adapter";
import type { AvalAlphaSvelteInstance, CreateAvalAlphaOptions } from "./types.js";

interface ControllerRecord {
  readonly binding: AlphaBinding;
  readonly readOptions: () => CreateAvalAlphaOptions;
}
// Svelte may proxy an instance held in $state; function identity survives that proxy.
const controllers = new WeakMap<AvalAlphaSvelteInstance["subscribe"], ControllerRecord>();

export function createAvalAlpha(readOptions: () => CreateAvalAlphaOptions): AvalAlphaSvelteInstance {
  if (typeof readOptions !== "function") throw new TypeError("createAvalAlpha requires an option getter");
  const binding = createAlphaBinding(createAlphaConfiguration(readOptions()));
  const alpha: AvalAlphaSvelteInstance = Object.freeze({
    ...binding.commands,
    subscribe(run: (value: AlphaStatus) => void) {
      run(binding.getStatus());
      return binding.subscribe(() => run(binding.getStatus()));
    }
  });
  controllers.set(alpha.subscribe, { binding, readOptions });
  return alpha;
}

export function getControllerRecord(alpha: AvalAlphaSvelteInstance): ControllerRecord {
  const record = controllers.get(alpha?.subscribe);
  if (!record) throw new TypeError("AvalAlphaComponent requires a controller created by createAvalAlpha");
  return record;
}
