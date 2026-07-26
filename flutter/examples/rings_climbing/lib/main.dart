// Advanced AVAL rings demo — climbing motion atlas.
//
// Graph: cyclic **stamina** ring (secure → strained → failing) plus action
// spokes (shake-out, lock-off, charge, reach, dyno, fall). Stills from Grok
// Imagine stand in for portal-aligned loop / one-shot clips until real video
// is compiled into an .avl.
//
// Multi-hop uses planFor() + sequential request() (same pattern as the web
// rings test bed).

import 'dart:async';

import 'package:aval_flutter/aval_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'climbing_graph.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const ClimbingRingsApp());
}

class ClimbingRingsApp extends StatelessWidget {
  const ClimbingRingsApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'AVAL — climbing rings atlas',
      debugShowCheckedModeBanner: false,
      theme: ThemeData.dark(useMaterial3: true).copyWith(
        scaffoldBackgroundColor: const Color(0xFF0E0E12),
      ),
      home: const ClimbingPage(),
    );
  }
}

class ClimbingPage extends StatefulWidget {
  const ClimbingPage({super.key});

  @override
  State<ClimbingPage> createState() => _ClimbingPageState();
}

class _ClimbingPageState extends State<ClimbingPage> {
  final AvalPlayerController _controller = AvalPlayerController();
  final List<String> _log = <String>[];
  final Map<String, ImageProvider> _images = <String, ImageProvider>{};

  bool _busy = false;
  String? _pending;
  String _visual = kHangSecure;
  Timer? _tick;

  @override
  void initState() {
    super.initState();
    _boot();
  }

  Future<void> _boot() async {
    try {
      final graph = buildClimbingGraph();
      _controller.installGraph(graph);
      _controller.loaded = true;
      _logLine('graph: stamina ring + action spokes installed');
      await _preloadImages();
      _visual = _controller.visualState;
      if (_visual.isEmpty) _visual = kHangSecure;
      _tick = Timer.periodic(const Duration(milliseconds: 33), (_) {
        if (!_controller.loaded) return;
        _controller.tickGraph();
        final v = _controller.visualState;
        if (v.isNotEmpty && v != _visual && mounted) {
          setState(() => _visual = v);
        }
      });
      _logLine('atlas stills ready · planFor + sequential request');
    } catch (e, st) {
      _logLine('boot failed: $e');
      debugPrint('$e\n$st');
    }
    if (mounted) setState(() {});
  }

  Future<void> _preloadImages() async {
    for (final entry in kStateAssets.entries) {
      try {
        final data = await rootBundle.load(entry.value);
        _images[entry.key] = MemoryImage(
          data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
        );
      } catch (e) {
        _logLine('missing asset ${entry.value}: $e');
      }
    }
    for (final entry in kPivotAssets.entries) {
      try {
        final data = await rootBundle.load(entry.value);
        _images[entry.key] = MemoryImage(
          data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
        );
      } catch (_) {}
    }
  }

  void _logLine(String text) {
    _log.insert(0, '[${_log.length.toString().padLeft(3, '0')}] $text');
    if (_log.length > 100) _log.removeLast();
  }

  Future<void> _go(String target) async {
    if (_busy) {
      _pending = target;
      _logLine('queued → $target');
      if (mounted) setState(() {});
      return;
    }
    _busy = true;
    if (mounted) setState(() {});
    try {
      while (true) {
        final plan = _controller.planFor(target);
        _logLine('planFor("$target") = $plan');
        if (plan == null) {
          _logLine('unreachable: $target');
          break;
        }
        if (plan.isEmpty) {
          _logLine('already at $target');
          break;
        }
        for (final step in plan) {
          final result = _controller.request(step);
          _logLine(
            'request("$step") ok=${result?.accepted} '
            'visual=${_controller.visualState}',
          );
          for (var i = 0; i < 10; i++) {
            _controller.tickGraph();
            await Future<void>.delayed(const Duration(milliseconds: 32));
          }
          if (mounted) {
            setState(() => _visual = _controller.visualState);
          }
        }
        final next = _pending;
        _pending = null;
        if (next == null || next == _controller.visualState) break;
        target = next;
      }
    } finally {
      _busy = false;
      if (mounted) {
        setState(() => _visual = _controller.visualState);
      }
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
    final plan = _controller.planFor(_pending ?? _visual);
    final image = _images[_visual];

    return Scaffold(
      body: SafeArea(
        child: LayoutBuilder(
          builder: (context, constraints) {
            final narrow = constraints.maxWidth < 720;
            final stage = _Stage(
              image: image,
              visual: _visual,
              busy: _busy,
            );
            final side = _SidePanel(
              visual: _visual,
              busy: _busy,
              pending: _pending,
              plan: plan,
              log: _log,
              onGo: _go,
            );
            if (narrow) {
              return Column(
                children: [
                  Expanded(flex: 3, child: stage),
                  Expanded(flex: 4, child: side),
                ],
              );
            }
            return Row(
              children: [
                SizedBox(width: 340, child: side),
                const VerticalDivider(width: 1),
                Expanded(child: stage),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _Stage extends StatelessWidget {
  const _Stage({
    required this.image,
    required this.visual,
    required this.busy,
  });

  final ImageProvider? image;
  final String visual;
  final bool busy;

  @override
  Widget build(BuildContext context) {
    return Container(
      color: const Color(0xFF121218),
      child: Center(
        child: AspectRatio(
          aspectRatio: 9 / 16,
          child: Stack(
            fit: StackFit.expand,
            children: [
              DecoratedBox(
                decoration: BoxDecoration(
                  color: const Color(0xFF00B140),
                  borderRadius: BorderRadius.circular(12),
                  border: Border.all(color: const Color(0xFF2A2A34)),
                ),
              ),
              if (image != null)
                ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: Image(
                    image: image!,
                    fit: BoxFit.cover,
                    filterQuality: FilterQuality.medium,
                  ),
                )
              else
                Center(
                  child: Text(
                    kStateLabels[visual] ?? visual,
                    style: const TextStyle(fontSize: 28, color: Colors.white70),
                  ),
                ),
              Positioned(
                left: 12,
                bottom: 12,
                child: _Badge(
                  text: kStateLabels[visual] ?? visual,
                  accent: busy,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge({required this.text, required this.accent});

  final String text;
  final bool accent;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      decoration: BoxDecoration(
        color: Colors.black.withValues(alpha: 0.72),
        borderRadius: BorderRadius.circular(20),
        border: Border.all(
          color: accent ? const Color(0xFF88FF88) : const Color(0xFF444444),
        ),
      ),
      child: Text(
        text,
        style: TextStyle(
          color: accent ? const Color(0xFF88FF88) : Colors.white,
          fontFamily: 'monospace',
          fontSize: 13,
        ),
      ),
    );
  }
}

class _SidePanel extends StatelessWidget {
  const _SidePanel({
    required this.visual,
    required this.busy,
    required this.pending,
    required this.plan,
    required this.log,
    required this.onGo,
  });

  final String visual;
  final bool busy;
  final String? pending;
  final List<String>? plan;
  final List<String> log;
  final ValueChanged<String> onGo;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text(
          'CLIMBING RINGS ATLAS',
          style: TextStyle(
            color: Colors.white.withValues(alpha: 0.5),
            letterSpacing: 1.2,
            fontSize: 12,
          ),
        ),
        const SizedBox(height: 8),
        Text(
          kStateLabels[visual] ?? visual,
          style: const TextStyle(
            color: Color(0xFF88FF88),
            fontSize: 22,
            fontWeight: FontWeight.bold,
            fontFamily: 'monospace',
          ),
        ),
        Text(
          busy ? 'walking plan…' : (pending != null ? 'queued $pending' : 'idle'),
          style: const TextStyle(color: Color(0xFF888899), fontSize: 12),
        ),
        const SizedBox(height: 20),
        const _SectionTitle('Stamina ring (portal-shared)'),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final s in [kHangSecure, kHangStrained, kHangFailing])
              _Chip(
                label: kStateLabels[s]!,
                selected: visual == s,
                onTap: () => onGo(s),
              ),
          ],
        ),
        const SizedBox(height: 20),
        const _SectionTitle('Action loops'),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final s in [kShakeOut, kLockOff, kDynoCharge])
              _Chip(
                label: kStateLabels[s]!,
                selected: visual == s,
                onTap: () => onGo(s),
              ),
          ],
        ),
        const SizedBox(height: 20),
        const _SectionTitle('Jumps (rear camera)'),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final s in [
              kJumpLeftCharge,
              kJumpLeft,
              kJumpUpCharge,
              kJumpUp,
              kJumpRightCharge,
              kJumpRight,
            ])
              _Chip(
                label: kStateLabels[s]!,
                selected: visual == s,
                onTap: () => onGo(s),
              ),
          ],
        ),
        const SizedBox(height: 20),
        const _SectionTitle('One-shots (finite)'),
        const SizedBox(height: 8),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final s in [kReachRhUp, kDynoLeap, kFall])
              _Chip(
                label: kStateLabels[s]!,
                selected: visual == s,
                danger: s == kFall,
                onTap: () => onGo(s),
              ),
          ],
        ),
        const SizedBox(height: 20),
        const _SectionTitle('planFor'),
        const SizedBox(height: 8),
        Container(
          width: double.infinity,
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: const Color(0xFF0A1A0A),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: const Color(0xFF2A3A2A)),
          ),
          child: Text(
            plan == null
                ? 'null'
                : plan!.isEmpty
                    ? '[]  (already there)'
                    : plan!.join(' → '),
            style: const TextStyle(
              color: Color(0xFF88FF88),
              fontFamily: 'monospace',
              fontSize: 12,
            ),
          ),
        ),
        const SizedBox(height: 12),
        const Text(
          'Ring: stamina · 3 states · cyclic · maxChainedSteps 2\n'
          'Portal pose shared across hang_* loops\n'
          'Pivots forward-only; one-shots end settled',
          style: TextStyle(
            color: Color(0xFF8888FF),
            fontSize: 11,
            fontFamily: 'monospace',
            height: 1.45,
          ),
        ),
        const SizedBox(height: 20),
        const _SectionTitle('Event log'),
        const SizedBox(height: 8),
        Container(
          height: 200,
          width: double.infinity,
          padding: const EdgeInsets.all(10),
          decoration: BoxDecoration(
            color: const Color(0xFF1A1A0A),
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: const Color(0xFF3A3A2A)),
          ),
          child: ListView.builder(
            itemCount: log.length,
            itemBuilder: (_, i) => Text(
              log[i],
              style: const TextStyle(
                color: Color(0xFFDDDD88),
                fontSize: 11,
                fontFamily: 'monospace',
              ),
            ),
          ),
        ),
      ],
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    return Text(
      text.toUpperCase(),
      style: TextStyle(
        color: Colors.white.withValues(alpha: 0.45),
        fontSize: 11,
        letterSpacing: 1.1,
      ),
    );
  }
}

class _Chip extends StatelessWidget {
  const _Chip({
    required this.label,
    required this.selected,
    required this.onTap,
    this.danger = false,
  });

  final String label;
  final bool selected;
  final VoidCallback onTap;
  final bool danger;

  @override
  Widget build(BuildContext context) {
    final border = selected
        ? const Color(0xFF88FF88)
        : danger
            ? const Color(0xFF884444)
            : const Color(0xFF444455);
    final bg = selected
        ? const Color(0xFF1A3A1A)
        : danger
            ? const Color(0xFF2A1515)
            : const Color(0xFF1C1C24);
    return Material(
      color: bg,
      borderRadius: BorderRadius.circular(8),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(8),
        child: Container(
          constraints: const BoxConstraints(minWidth: 88, minHeight: 44),
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(8),
            border: Border.all(color: border),
          ),
          child: Text(
            label,
            textAlign: TextAlign.center,
            style: TextStyle(
              color: selected ? const Color(0xFF88FF88) : Colors.white70,
              fontFamily: 'monospace',
              fontSize: 12,
            ),
          ),
        ),
      ),
    );
  }
}
