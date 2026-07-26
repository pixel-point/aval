/// Climbing motion atlas graph — stamina ring + action branches.
///
/// **Reversibility (PRD v3):** ring adjacencies and action pivots use
/// **pivot-symmetric** reversible units — one pivot `unitId` serves both
/// directions (forward base + reverse inverse with `reverseOf`). Hard-cuts
/// remain only for one-shots (reach / dyno / fall) where mid-flight reverse
/// is not wanted.
///
/// Canonical rule: along declared ring order, **+1 is the base**
/// (`exact-authored`, `direction: forward`, no `reverseOf`); **-1 is the
/// inverse** (`exact-reverse`, `direction: reverse`, `reverseOf: base.id`).
library;

import 'package:aval_graph/aval_graph.dart';

/// Loop / dwell states (portal-compatible).
const kHangSecure = 'hang_secure';
const kHangStrained = 'hang_strained';
const kHangFailing = 'hang_failing';
const kShakeOut = 'shake_out';
const kLockOff = 'lock_off_hold';
const kDynoCharge = 'dyno_charge';
const kJumpLeftCharge = 'jump_left_charge';
const kJumpRightCharge = 'jump_right_charge';
const kJumpUpCharge = 'jump_up_charge';

/// Finite one-shot end states (held final pose).
const kReachRhUp = 'reach_rh_up';
const kDynoLeap = 'dyno_leap';
const kJumpLeft = 'jump_left';
const kJumpRight = 'jump_right';
const kJumpUp = 'jump_up';
const kFall = 'fall';

const kAllStates = <String>[
  kHangSecure,
  kHangStrained,
  kHangFailing,
  kShakeOut,
  kLockOff,
  kDynoCharge,
  kJumpLeftCharge,
  kJumpRightCharge,
  kJumpUpCharge,
  kReachRhUp,
  kDynoLeap,
  kJumpLeft,
  kJumpRight,
  kJumpUp,
  kFall,
];

/// Display labels for the UI.
const kStateLabels = <String, String>{
  kHangSecure: 'Secure',
  kHangStrained: 'Strained',
  kHangFailing: 'Failing',
  kShakeOut: 'Shake-out',
  kLockOff: 'Lock-off',
  kDynoCharge: 'Charge',
  kJumpLeftCharge: 'Coil ←',
  kJumpRightCharge: 'Coil →',
  kJumpUpCharge: 'Coil ↑',
  kReachRhUp: 'Reach RH↑',
  kDynoLeap: 'Dyno leap',
  kJumpLeft: 'Jump ←',
  kJumpRight: 'Jump →',
  kJumpUp: 'Jump ↑',
  kFall: 'Fall',
};

/// Asset path relative to package assets/ for each visual state.
const kStateAssets = <String, String>{
  kHangSecure: 'assets/atlas/loops/hang_secure.jpg',
  kHangStrained: 'assets/atlas/loops/hang_strained.jpg',
  kHangFailing: 'assets/atlas/loops/hang_failing.jpg',
  kShakeOut: 'assets/atlas/loops/shake_out.jpg',
  kLockOff: 'assets/atlas/loops/lock_off_hold.jpg',
  kDynoCharge: 'assets/atlas/loops/dyno_charge.jpg',
  kJumpLeftCharge: 'assets/atlas/loops/jump_left_charge.jpg',
  kJumpRightCharge: 'assets/atlas/loops/jump_right_charge.jpg',
  kJumpUpCharge: 'assets/atlas/loops/jump_up_charge.jpg',
  kReachRhUp: 'assets/atlas/oneshots/reach_rh_up.jpg',
  kDynoLeap: 'assets/atlas/oneshots/dyno_leap.jpg',
  kJumpLeft: 'assets/atlas/oneshots/jump_left.jpg',
  kJumpRight: 'assets/atlas/oneshots/jump_right.jpg',
  kJumpUp: 'assets/atlas/oneshots/jump_up.jpg',
  kFall: 'assets/atlas/oneshots/fall.jpg',
};

/// Optional mid-pivot stills (for transition previews).
const kPivotAssets = <String, String>{
  'pivot_hang_to_lead': 'assets/atlas/pivots/pivot_hang_to_lead.jpg',
  'pivot_hang_to_lockoff': 'assets/atlas/pivots/pivot_hang_to_lockoff.jpg',
  'pivot_hang_to_charge': 'assets/atlas/pivots/pivot_hang_to_charge.jpg',
};

/// Shared pivot frame count (short reverse-safe clips).
const kPivotFrames = 18;

/// Portal start maxWait for 8-frame loop with portals [0, 4]:
/// greatest gap = 4 → minimum maxWaitFrames = 3 (validate floor).
const kPortalMaxWait = 3;

/// Build a validated motion graph for the climbing atlas.
ValidatedMotionGraph buildClimbingGraph() {
  return validateMotionGraphDefinition(_climbingGraphJson());
}

/// How many reversible `unitId` groups the graph owns (each = one pivot clip).
int countReversiblePivotUnits(ValidatedMotionGraph graph) {
  final units = <String>{};
  for (final edge in graph.definition.edges) {
    final t = edge.transition;
    if (t is GraphTransitionReversible) units.add(t.unitId);
  }
  return units.length;
}

Map<String, Object?> _climbingGraphJson() {
  Map<String, Object?> loopBody(String id, {int frames = 8}) => {
        'id': id,
        'body': {
          'unitId': '$id.body',
          'kind': 'loop',
          'frameCount': frames,
          'ports': [
            {
              'id': 'default',
              'entryFrame': 0,
              // 2 portals → maxWait floor = 3 on an 8-frame loop.
              'portalFrames': [0, frames ~/ 2],
            }
          ],
        },
      };

  Map<String, Object?> finiteBody(String id, {int frames = 8}) => {
        'id': id,
        'body': {
          'unitId': '$id.body',
          'kind': 'finite',
          'frameCount': frames,
          'ports': [
            {
              'id': 'default',
              'entryFrame': 0,
              // Final frame is a portal so one-shots can depart again.
              'portalFrames': [0, frames - 1],
            }
          ],
        },
      };

  /// Portal-gated start (not hard-cut). Source port is specialized per edge.
  Map<String, Object?> portalStart() => {
        'type': 'portal',
        'sourcePort': 'default',
        'targetPort': 'default',
        'maxWaitFrames': kPortalMaxWait,
      };

  /// Symmetric pivot pair: +1 base / -1 inverse, shared [unitId] (PRD §1.2).
  List<Map<String, Object?>> pivotPair({
    required String from,
    required String to,
    required String unitId,
    String? ring,
    int frameCount = kPivotFrames,
  }) {
    // Dot-separated ids (GRAPH_IDENTIFIER_PATTERN forbids `:`).
    final baseId = ring != null
        ? '$ring.$from.$to'
        : 'pivot.$from.$to';
    final invId = ring != null
        ? '$ring.$to.$from'
        : 'pivot.$to.$from';
    return [
      {
        'id': baseId,
        'from': from,
        'to': to,
        if (ring != null) 'ring': ring,
        if (ring != null) 'step': 1,
        'start': portalStart(),
        'transition': {
          'kind': 'reversible',
          'unitId': unitId,
          'frameCount': frameCount,
          'direction': 'forward',
          // no reverseOf — this is the base
        },
        'continuity': 'exact-authored',
      },
      {
        'id': invId,
        'from': to,
        'to': from,
        if (ring != null) 'ring': ring,
        if (ring != null) 'step': -1,
        'start': portalStart(),
        'transition': {
          'kind': 'reversible',
          'unitId': unitId,
          'frameCount': frameCount,
          'direction': 'reverse',
          'reverseOf': baseId,
        },
        'continuity': 'exact-reverse',
      },
    ];
  }

  /// One-shot / recovery: hard-cut (no mid-flight reverse — intentional).
  Map<String, Object?> hardCut(String id, String from, String to) => {
        'id': id,
        'from': from,
        'to': to,
        'start': {
          'type': 'cut',
          'targetPort': 'default',
          'maxWaitFrames': 1,
        },
        'continuity': 'cut',
      };

  final states = <Map<String, Object?>>[
    loopBody(kHangSecure),
    loopBody(kHangStrained),
    loopBody(kHangFailing),
    loopBody(kShakeOut),
    loopBody(kLockOff),
    loopBody(kDynoCharge),
    loopBody(kJumpLeftCharge),
    loopBody(kJumpRightCharge),
    loopBody(kJumpUpCharge),
    finiteBody(kReachRhUp),
    finiteBody(kDynoLeap),
    finiteBody(kJumpLeft),
    finiteBody(kJumpRight),
    finiteBody(kJumpUp),
    finiteBody(kFall),
  ];

  final edges = <Map<String, Object?>>[];

  // Stamina ring (3 states → 3 symmetric pivot units → 6 edges).
  // Order: secure → strained → failing → secure.
  const stamina = [kHangSecure, kHangStrained, kHangFailing];
  for (var i = 0; i < stamina.length; i++) {
    final a = stamina[i];
    final b = stamina[(i + 1) % stamina.length];
    edges.addAll(
      pivotPair(
        from: a,
        to: b,
        unitId: 'pivot.stamina.$a.$b',
        ring: 'stamina',
      ),
    );
  }

  // Action pivots from hang_secure (symmetric = mid-flight reverse OK).
  edges.addAll(
    pivotPair(
      from: kHangSecure,
      to: kShakeOut,
      unitId: 'pivot.secure.shake_out',
    ),
  );
  edges.addAll(
    pivotPair(
      from: kHangSecure,
      to: kLockOff,
      unitId: 'pivot.secure.lock_off',
    ),
  );
  edges.addAll(
    pivotPair(
      from: kHangSecure,
      to: kDynoCharge,
      unitId: 'pivot.secure.charge',
    ),
  );
  // Directional jump coils (symmetric pivots — reverse-safe load poses).
  edges.addAll(
    pivotPair(
      from: kHangSecure,
      to: kJumpLeftCharge,
      unitId: 'pivot.secure.jump_left_charge',
    ),
  );
  edges.addAll(
    pivotPair(
      from: kHangSecure,
      to: kJumpRightCharge,
      unitId: 'pivot.secure.jump_right_charge',
    ),
  );
  edges.addAll(
    pivotPair(
      from: kHangSecure,
      to: kJumpUpCharge,
      unitId: 'pivot.secure.jump_up_charge',
    ),
  );

  // One-shots: hard-cut (AC15 — no inverse, no mid-step reverse).
  edges.add(hardCut('action.secure.reach', kHangSecure, kReachRhUp));
  edges.add(hardCut('action.reach.secure', kReachRhUp, kHangSecure));
  edges.add(hardCut('action.charge.leap', kDynoCharge, kDynoLeap));
  edges.add(hardCut('action.leap.secure', kDynoLeap, kHangSecure));
  // Jump L/R/Up: charge → apex → catch back to secure.
  edges.add(hardCut('action.jlc.jl', kJumpLeftCharge, kJumpLeft));
  edges.add(hardCut('action.jl.secure', kJumpLeft, kHangSecure));
  edges.add(hardCut('action.jrc.jr', kJumpRightCharge, kJumpRight));
  edges.add(hardCut('action.jr.secure', kJumpRight, kHangSecure));
  edges.add(hardCut('action.juc.ju', kJumpUpCharge, kJumpUp));
  edges.add(hardCut('action.ju.secure', kJumpUp, kHangSecure));
  // Direct jump from secure (skips coil when plan allows).
  edges.add(hardCut('action.secure.jl', kHangSecure, kJumpLeft));
  edges.add(hardCut('action.secure.jr', kHangSecure, kJumpRight));
  edges.add(hardCut('action.secure.ju', kHangSecure, kJumpUp));
  edges.add(hardCut('action.failing.fall', kHangFailing, kFall));
  edges.add(hardCut('action.secure.fall', kHangSecure, kFall));
  edges.add(hardCut('action.fall.secure', kFall, kHangSecure));

  return {
    'initialState': kHangSecure,
    'states': states,
    'edges': edges,
    'rings': [
      {
        'id': 'stamina',
        'states': stamina,
        'cyclic': true,
        'tieBreak': 'forward',
        'maxChainedSteps': 2,
      },
    ],
  };
}
