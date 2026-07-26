// AVAL Flutter — rings / turn-edges compass demo.
//
// Ports the web fixture at `fixtures/rings/v1-eight-way-facing/test.html`:
// 8 walk facings on a cyclic ring, `planFor()` multi-hop, sequential
// `request()` for reliable hard-cut unit switches.
//
// Video decode of the placeholder VP9 avl is best-effort (format rings + VP9
// decode backends vary by platform). The compass + planFor + request path is
// always driven by the pure-Dart MotionGraphEngine.

import 'dart:async';

import 'package:aval_flutter/aval_flutter.dart';
import 'package:aval_graph/aval_graph.dart';
import 'package:flutter/material.dart';

const _facings = <String>[
  'walk_n',
  'walk_ne',
  'walk_e',
  'walk_se',
  'walk_s',
  'walk_sw',
  'walk_w',
  'walk_nw',
];

const _colors = <String, Color>{
  'walk_n': Color(0xFFDC3C3C),
  'walk_ne': Color(0xFFDC8C3C),
  'walk_e': Color(0xFFC8C83C),
  'walk_se': Color(0xFF3CC850),
  'walk_s': Color(0xFF3CA0DC),
  'walk_sw': Color(0xFF5050DC),
  'walk_w': Color(0xFFA03CDC),
  'walk_nw': Color(0xFFDC3CB4),
};

const _labels = <String, String>{
  'walk_n': 'N',
  'walk_ne': 'NE',
  'walk_e': 'E',
  'walk_se': 'SE',
  'walk_s': 'S',
  'walk_sw': 'SW',
  'walk_w': 'W',
  'walk_nw': 'NW',
};

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const RingsApp());
}

class RingsApp extends StatelessWidget {
  const RingsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AVAL — rings eight-way',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark(useMaterial3: true),
      home: const RingsPage(),
    );
  }
}

class RingsPage extends StatefulWidget {
  const RingsPage({super.key});

  @override
  State<RingsPage> createState() => _RingsPageState();
}

class _RingsPageState extends State<RingsPage> {
  final AvalPlayerController _controller = AvalPlayerController();
  final List<String> _log = <String>[];
  bool _busy = false;
  String? _pending;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    // Prefer the pure graph path so planFor/rings work even if format rings
    // adaptation is not yet wired for this avl.
    try {
      final graph = validateMotionGraphDefinition(_facingGraphJson());
      _controller.installGraph(graph);
      _controller.loaded = true;
      _logLine('graph installed (rings + 16 turn edges)');
      // Best-effort avl load for real decode when platform supports it.
      unawaited(_tryLoadAvl());
    } catch (e, st) {
      _logLine('boot failed: $e');
      debugPrint('$e\n$st');
    }
    _tick = Timer.periodic(const Duration(milliseconds: 33), (_) {
      if (!_controller.loaded) return;
      _controller.tickGraph();
      if (mounted) setState(() {});
    });
    if (mounted) setState(() {});
  }

  Future<void> _tryLoadAvl() async {
    try {
      await _controller.loadAsset('assets/rings.vp9.avl');
      _logLine('avl load ok — decoder: ${_controller.decoderDescription}');
    } catch (e) {
      _logLine('avl load skipped/failed (placeholder UI still works): $e');
    }
    if (mounted) setState(() {});
  }

  void _logLine(String text) {
    _log.insert(0, text);
    if (_log.length > 80) _log.removeLast();
  }

  Future<void> _go(String target) async {
    if (_busy) {
      _pending = target;
      _logLine('queued $target');
      return;
    }
    _busy = true;
    try {
      while (true) {
        final plan = _controller.planFor(target);
        _logLine('planFor("$target") = $plan');
        if (plan == null) {
          _logLine('unreachable $target');
          break;
        }
        if (plan.isEmpty) {
          _logLine('already at $target');
          break;
        }
        for (final step in plan) {
          final result = _controller.request(step);
          _logLine(
            'request("$step") accepted=${result?.accepted} '
            '→ visual=${_controller.visualState}',
          );
          // Hard-cut unit hops need a couple of ticks + unit decode.
          for (var i = 0; i < 12; i++) {
            _controller.tickGraph();
            await Future<void>.delayed(const Duration(milliseconds: 40));
          }
          await _controller.ensureUnitDecoded(_controller.currentUnitId());
        }
        final next = _pending;
        _pending = null;
        if (next == null || next == _controller.visualState) break;
        target = next;
      }
    } finally {
      _busy = false;
      if (mounted) setState(() {});
    }
  }

  @override
  void dispose() {
    _tick?.cancel();
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final visual = _controller.visualState;
    final color = _colors[visual] ?? const Color(0xFF333333);
    final planPreview = _controller.planFor(
      _pending ?? visual,
    );

    return Scaffold(
      backgroundColor: const Color(0xFF111111),
      body: Row(
        children: [
          SizedBox(
            width: 300,
            child: ListView(
              padding: const EdgeInsets.all(16),
              children: [
                Text(
                  visual.isEmpty ? '—' : visual,
                  style: const TextStyle(
                    color: Color(0xFF88FF88),
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                    fontFamily: 'monospace',
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 4),
                Text(
                  'readiness: ${_controller.loaded ? "ready" : "loading"}'
                  '${_busy ? " · walking" : ""}',
                  style: const TextStyle(
                    color: Color(0xFF888888),
                    fontSize: 11,
                    fontFamily: 'monospace',
                  ),
                  textAlign: TextAlign.center,
                ),
                const SizedBox(height: 16),
                _DirPad(
                  active: visual,
                  onSelect: _go,
                ),
                const SizedBox(height: 16),
                const Text(
                  'planFor',
                  style: TextStyle(
                    color: Color(0xFF999999),
                    fontSize: 12,
                    letterSpacing: 1,
                  ),
                ),
                Container(
                  margin: const EdgeInsets.only(top: 8),
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: const Color(0xFF0A1A0A),
                    border: Border.all(color: const Color(0xFF2A3A2A)),
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Text(
                    planPreview == null
                        ? 'null'
                        : planPreview.isEmpty
                            ? '[]'
                            : planPreview.join('\n'),
                    style: const TextStyle(
                      color: Color(0xFF88FF88),
                      fontSize: 11,
                      fontFamily: 'monospace',
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                const Text(
                  'Ring: facing.walk · 8 states · cyclic\n'
                  '16 turn edges · maxChainedSteps: 4',
                  style: TextStyle(
                    color: Color(0xFF8888FF),
                    fontSize: 11,
                    fontFamily: 'monospace',
                    height: 1.4,
                  ),
                ),
              ],
            ),
          ),
          const VerticalDivider(width: 1, color: Color(0xFF333333)),
          Expanded(
            child: Column(
              children: [
                Expanded(
                  child: Center(
                    child: Container(
                      width: 256,
                      height: 256,
                      decoration: BoxDecoration(
                        color: color,
                        borderRadius: BorderRadius.circular(8),
                      ),
                      alignment: Alignment.center,
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Text(
                            _labels[visual] ?? '?',
                            style: const TextStyle(
                              color: Colors.white,
                              fontSize: 48,
                              fontWeight: FontWeight.bold,
                            ),
                          ),
                          Text(
                            visual,
                            style: const TextStyle(
                              color: Colors.white70,
                              fontFamily: 'monospace',
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
                Container(
                  height: 180,
                  width: double.infinity,
                  color: const Color(0xFF1A1A0A),
                  padding: const EdgeInsets.all(10),
                  child: ListView.builder(
                    itemCount: _log.length,
                    itemBuilder: (context, i) => Text(
                      _log[i],
                      style: const TextStyle(
                        color: Color(0xFFDDDD88),
                        fontSize: 11,
                        fontFamily: 'monospace',
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _DirPad extends StatelessWidget {
  const _DirPad({required this.active, required this.onSelect});

  final String active;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    Widget cell(String? state) {
      if (state == null) return const SizedBox(width: 72, height: 48);
      final selected = state == active;
      return Padding(
        padding: const EdgeInsets.all(2),
        child: Material(
          color: selected ? const Color(0xFF2A4A2A) : const Color(0xFF222222),
          borderRadius: BorderRadius.circular(4),
          child: InkWell(
            onTap: () => onSelect(state),
            borderRadius: BorderRadius.circular(4),
            child: SizedBox(
              width: 72,
              height: 48,
              child: Center(
                child: Text(
                  _labels[state]!,
                  style: TextStyle(
                    color: selected
                        ? const Color(0xFF88FF88)
                        : const Color(0xFFCCCCCC),
                    fontFamily: 'monospace',
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    }

    return Column(
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [cell(null), cell('walk_n'), cell(null)],
        ),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [cell('walk_nw'), cell(null), cell('walk_ne')],
        ),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [cell('walk_w'), cell(null), cell('walk_e')],
        ),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [cell('walk_sw'), cell(null), cell('walk_se')],
        ),
        Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [cell(null), cell('walk_s'), cell(null)],
        ),
      ],
    );
  }
}

/// Authoring graph matching the rings fixture (hard-cut turn edges + ring).
Map<String, Object?> _facingGraphJson() {
  final states = <Map<String, Object?>>[
    for (final id in _facings)
      {
        'id': id,
        'body': {
          'unitId': '$id.body',
          'kind': 'loop',
          'frameCount': 16,
          'ports': [
            {
              'id': 'default',
              'entryFrame': 0,
              'portalFrames': [0, 8],
            }
          ],
        },
      },
  ];
  final edges = <Map<String, Object?>>[];
  for (var i = 0; i < _facings.length; i += 1) {
    final from = _facings[i];
    for (final step in [1, -1]) {
      final to = _facings[(i + step + _facings.length) % _facings.length];
      final short = from.replaceFirst('walk_', '');
      final shortTo = to.replaceFirst('walk_', '');
      edges.add({
        'id': 'facing.walk.$short.$shortTo',
        'from': from,
        'to': to,
        'start': {
          'type': 'cut',
          'targetPort': 'default',
          'maxWaitFrames': 1,
        },
        'continuity': 'cut',
        'ring': 'facing.walk',
        'step': step,
      });
    }
  }
  return {
    'initialState': 'walk_n',
    'states': states,
    'edges': edges,
    'rings': [
      {
        'id': 'facing.walk',
        'states': _facings,
        'cyclic': true,
        'tieBreak': 'forward',
        'maxChainedSteps': 4,
      }
    ],
  };
}
