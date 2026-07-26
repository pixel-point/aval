import type {
  NormalizedSourceProject
} from "./model.js";

/** Freeze the project after schema ingress has normalized its encoding set. */
export function normalizeSourceProject(
  project: Readonly<NormalizedSourceProject>
): Readonly<NormalizedSourceProject> {
  return Object.freeze({
    projectVersion: project.projectVersion,
    alpha: project.alpha,
    canvas: project.canvas,
    frameRate: project.frameRate,
    sources: project.sources,
    encodings: project.encodings,
    units: project.units,
    initialState: project.initialState,
    states: project.states,
    edges: project.edges,
    bindings: project.bindings,
    ...(project.rings === undefined ? {} : { rings: project.rings }),
    ...(project.ringNotes === undefined ? {} : { ringNotes: project.ringNotes })
  });
}
