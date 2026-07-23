import * as graph from "@pixel-point/aval-graph";
import * as format from "@pixel-point/aval-format";
import * as compiler from "@pixel-point/aval-compiler";
import * as playerWeb from "@pixel-point/aval-player-web";
import * as element from "@pixel-point/aval-element";
import * as reactBinding from "@pixel-point/aval-react";

for (const [name, module] of Object.entries({ graph, format, compiler, playerWeb, element, reactBinding })) {
  if (Object.keys(module).length === 0) throw new Error(`${name} has no public exports`);
}
if (typeof element.defineAvalElement !== "function") throw new Error("element root has no definition helper");
if (typeof reactBinding.useAval !== "function") throw new Error("React root has no useAval hook");
process.stdout.write("node-esm-consumer:passed\n");
