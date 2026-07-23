import "@pixel-point/aval-element/auto";
import { useAval } from "@pixel-point/aval-react";

if (customElements.get("aval-player") === undefined) {
  throw new Error("auto entry did not register the element");
}
if (typeof useAval !== "function") {
  throw new Error("React root has no useAval hook");
}
