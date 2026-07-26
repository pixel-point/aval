/// Identifier pattern shared by every graph ID (states, edges, ports, units).
///
/// Direct port of `GRAPH_IDENTIFIER_PATTERN` in `packages/graph/src/limits.ts`.
final RegExp graphIdentifierPattern = RegExp(r'^[a-z][a-z0-9._-]{0,63}$');

/// Hard bounds enforced by [validateMotionGraphDefinition] and the runtime
/// engine, ported verbatim from `GRAPH_LIMITS` in
/// `packages/graph/src/limits.ts`.
abstract final class GraphLimits {
  static const int maxStates = 32;
  static const int maxEdges = 64;
  static const int maxPortsPerBody = 16;
  static const int maxInputsPerTick = 32;
  static const int maxRoutingOperationsPerTick = 64;
  static const int maxTraceRecords = 256;
  static const int maxRings = 8;
  static const int maxRingStates = 32;
  static const int maxChainedSteps = 16;
}
