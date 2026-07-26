/// Public entry point for `aval_graph` — a pure-Dart, dependency-free port of
/// the TypeScript `@pixel-point/aval-graph` package (a deterministic state
/// graph for AVAL assets).
///
/// Mirrors the exports of `packages/graph/src/index.ts` exactly: the same
/// names are public here and nothing else is (route plan, intent router,
/// request ledger, operation journal, and engine-state internals stay
/// package-private under `lib/src/`, matching the TypeScript original, which
/// never re-exports those modules from its own `index.ts`).
library aval_graph;

export 'src/engine.dart' show MotionGraphEngine;
export 'src/errors.dart'
    show MotionGraphError, MotionGraphErrorCode, MotionGraphValidationError;
export 'src/limits.dart' show GraphLimits, graphIdentifierPattern;
export 'src/model.dart' hide listEquals;
export 'src/portal_search.dart'
    show
        BodyBoundarySearch,
        BodyFrameStep,
        findFinishBoundary,
        findNextPortalBoundary,
        greatestFinishWaitFrames,
        greatestPortalWaitFrames,
        nextBodyFrame;
export 'src/ring_plan.dart'
    show
        RingArc,
        RingRoute,
        RingRouteArc,
        RingRouteNone,
        RingRouteTooLong,
        planRingArc,
        resolveRingRoute;
export 'src/validate.dart' show validateMotionGraphDefinition;
