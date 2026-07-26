export const GRAPH_IDENTIFIER_PATTERN = /^[a-z][a-z0-9._-]{0,63}$/;

export const GRAPH_LIMITS = Object.freeze({
  maxStates: 32,
  maxEdges: 64,
  maxRings: 8,
  maxRingStates: 32,
  maxChainedSteps: 16,
  maxPortsPerBody: 16,
  maxInputsPerTick: 32,
  maxRoutingOperationsPerTick: 64,
  maxTraceRecords: 256
});
