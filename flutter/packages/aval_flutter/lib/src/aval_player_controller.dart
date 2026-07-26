/// Loads an `.avl` asset, lazily decodes units via the platform decoder, and
/// drives the aval_graph MotionGraphEngine so the displayed unit follows the
/// graph state.
///
/// Generalized from the grass_rabbit example's `RabbitController`: the
/// state→unit mapping, loop kinds, intro unit, and input bindings that were
/// hardcoded there are all derived from the manifest here.
///
/// High-res (1280×720) RGBA is ~3.7 MiB/frame — keeping all units decoded at
/// once OOMs on desktop. Only the active unit is retained; others are decoded
/// on demand and previous units are evicted.
library;

import 'dart:async';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:aval_format/aval_format.dart';
import 'package:aval_graph/aval_graph.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show rootBundle;

import 'decode/unit_decoder.dart';

class AvalPlayerController extends ChangeNotifier {
  /// Decoded frames per unit id currently held in RAM.
  final Map<String, List<ui.Image>> unitFrames = <String, List<ui.Image>>{};

  final MotionGraphEngine engine = MotionGraphEngine();
  ValidatedMotionGraph? _graph;

  /// Bumped once per authored frame (see [tickGraph]); a cheap listenable for
  /// per-tick UI (state badges, debug overlays) without notifying the whole
  /// controller.
  final ValueNotifier<int> ticks = ValueNotifier<int>(0);

  bool loaded = false;
  Object? error;

  int canvasWidth = 1280;
  int canvasHeight = 720;
  int frameRateNumerator = 24;
  int frameRateDenominator = 1;

  int codedWidth = 1280;
  int codedHeight = 720;

  BigInt _contentOrdinal = BigInt.zero;

  Uint8List? _assetBytes;
  CompiledManifest? _manifest;
  List<EncodedChunkRecord>? _records;
  AvalUnitDecoder? _decoder;
  String _codecString = 'avc1.42E020';
  final Map<String, Future<void>> _decodeInFlight = <String, Future<void>>{};

  /// Body unit for each graph state (from the manifest graph definition).
  final Map<String, String> _unitForState = <String, String>{};

  /// Units whose body kind is `loop` (others play once and hold last frame).
  final Set<String> _loopUnitIds = <String>{};

  /// The initial state's one-shot intro unit, if authored.
  String? _introUnitId;

  /// Graph event for each input binding source (`activate`, `engagement.on`,
  /// …) from the manifest's `bindings` array.
  final Map<String, String> _eventForSource = <String, String>{};

  /// Human-readable decode backend (for error/diagnostic UI).
  String get decoderDescription => unitDecoderDescription;

  /// The graph state names, in manifest order.
  List<String> get stateNames =>
      _graph?.definition.states.map((s) => s.id).toList() ?? const <String>[];

  /// The state currently being presented (updates when a transition commits).
  String get visualState {
    final snap = engine.snapshot();
    if (snap.presentation is GraphPresentationIntro) return 'intro';
    return snap.visualState ?? _graph?.definition.initialState ?? '';
  }

  /// The state the graph is heading toward (updates immediately on an input
  /// event, before the transition commits).
  String get requestedState {
    final snap = engine.snapshot();
    return snap.requestedState ?? visualState;
  }

  bool get isTransitioning => engine.snapshot().isTransitioning;

  int get totalFrames =>
      unitFrames.values.fold(0, (sum, list) => sum + list.length);

  /// Authoring frame count for a unit (from the manifest), even if not decoded.
  int authoredFrameCount(String unitId) {
    final unit = _manifest?.units.where((u) => u.id == unitId).firstOrNull;
    return unit?.frameCount ?? 0;
  }

  /// The unit the graph says should be on screen right now: the intro unit
  /// while the initial state's one-shot plays, then the body unit for the
  /// current state.
  String currentUnitId() {
    final snap = engine.snapshot();
    final initial = _graph?.definition.initialState ?? '';
    if (snap.presentation is GraphPresentationIntro) {
      return _introUnitId ?? _unitForState[initial] ?? initial;
    }
    final vs = snap.visualState ?? initial;
    return _unitForState[vs] ?? vs;
  }

  bool isLoopUnit(String unitId) => _loopUnitIds.contains(unitId);

  /// Resolves a unit-local frame counter to a real frame index: loop units
  /// wrap; finite units clamp to (and hold) the last frame.
  int frameIndexInUnit(String unitId, int localFrame) {
    final frames = unitFrames[unitId];
    if (frames == null || frames.isEmpty) return 0;
    if (isLoopUnit(unitId)) return localFrame % frames.length;
    return localFrame >= frames.length ? frames.length - 1 : localFrame;
  }

  ui.Image? imageFor(String unitId, int localFrame) {
    final frames = unitFrames[unitId];
    if (frames == null || frames.isEmpty) return null;
    return frames[frameIndexInUnit(unitId, localFrame)];
  }

  /// Whether [unitId] currently has decoded frames ready to paint.
  bool isUnitReady(String unitId) => unitFrames[unitId]?.isNotEmpty == true;

  /// Ensures [unitId] is decoded. Other units stay in memory until this unit
  /// is ready, then they are evicted — avoids a black gap during the ~1s
  /// decode.
  Future<void> ensureUnitDecoded(String unitId) {
    if (unitId.isEmpty) return Future<void>.value();
    if (unitFrames[unitId]?.isNotEmpty == true) {
      // Already cached — free anything else so we do not hold 2 full units.
      _evictUnitsExcept(unitId);
      return Future<void>.value();
    }
    return _decodeInFlight.putIfAbsent(unitId, () async {
      try {
        // Decode first with the previous unit still resident so the UI can
        // hold its last frame; only then evict.
        await _decodeUnit(unitId);
        _evictUnitsExcept(unitId);
      } finally {
        _decodeInFlight.remove(unitId);
      }
    });
  }

  /// Loads the `.avl` at [assetKey] from the root bundle.
  Future<void> loadAsset(String assetKey) async {
    try {
      final data = await rootBundle.load(assetKey);
      await loadBytes(
          data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes));
    } catch (e, st) {
      error = e;
      debugPrint('[aval] load failed: $e\n$st');
      notifyListeners();
    }
  }

  /// Parses [bytes] as a format-1.0 `.avl` container and starts the graph.
  Future<void> loadBytes(Uint8List bytes) async {
    try {
      final parsed = parseFrontIndex(bytes);
      final manifest = parsed.manifest;
      canvasWidth = manifest.canvas.width;
      canvasHeight = manifest.canvas.height;
      frameRateNumerator = manifest.frameRate.numerator;
      frameRateDenominator = manifest.frameRate.denominator;

      // Visible surface (matches decoder output after SPS crop when present).
      final rendition = manifest.renditions.first;
      final visible = rendition.alphaLayout.colorRect;
      codedWidth = visible.width;
      codedHeight = visible.height;
      _codecString = rendition.codec;

      _assetBytes = bytes;
      _manifest = manifest;
      _records = parsed.records;
      _decoder = createUnitDecoder();

      installGraph(parsed.graph, bindings: manifest.bindings);

      // Decode only the initial unit so startup stays under RAM budget.
      final initialUnit = currentUnitId();
      await ensureUnitDecoded(initialUnit);

      loaded = true;
      notifyListeners();
      debugPrint(
        '[aval] ready: canvas ${canvasWidth}x$canvasHeight, '
        'coded ${codedWidth}x$codedHeight, unit "$initialUnit" '
        '${unitFrames[initialUnit]?.length ?? 0} frames, '
        'bindings $_eventForSource',
      );
    } catch (e, st) {
      error = e;
      debugPrint('[aval] load failed: $e\n$st');
      notifyListeners();
    }
  }

  /// Installs a parsed graph (and optional input [bindings]) and starts the
  /// engine — without any video bytes or decoder attached. [loadBytes] calls
  /// this; logic tests can call it directly to drive the graph decode-free.
  void installGraph(ValidatedMotionGraph graph, {List<Binding>? bindings}) {
    _graph = graph;
    _unitForState.clear();
    _loopUnitIds.clear();
    _eventForSource.clear();
    for (final state in graph.definition.states) {
      _unitForState[state.id] = state.body.unitId;
      if (state.body.kind == GraphBodyKind.loop) {
        _loopUnitIds.add(state.body.unitId);
      }
    }
    final initial = graph.definition.states
        .where((s) => s.id == graph.definition.initialState)
        .firstOrNull;
    _introUnitId = initial?.initialUnit?.unitId;
    for (final binding in bindings ?? const <Binding>[]) {
      _eventForSource[binding.source] = binding.event;
    }
    engine.install(graph);
    engine.beginAnimated();
  }

  Future<void> _decodeUnit(String unitId) async {
    final bytes = _assetBytes;
    final manifest = _manifest;
    final records = _records;
    final decoder = _decoder;
    if (bytes == null ||
        manifest == null ||
        records == null ||
        decoder == null) {
      throw StateError('decode before load completed');
    }

    final unit = manifest.units.where((u) => u.id == unitId).firstOrNull;
    if (unit == null || unit.chunks.isEmpty) {
      debugPrint('[aval] unknown/empty unit "$unitId"');
      return;
    }

    final span = unit.chunks.first;
    final unitRecords = <EncodedChunkRecord>[];
    for (var c = 0; c < span.chunkCount; c++) {
      final idx = span.chunkStart + c;
      if (idx < 0 || idx >= records.length) break;
      unitRecords.add(records[idx]);
    }
    if (unitRecords.isEmpty) return;
    if (!unitRecords.first.randomAccess) {
      throw StateError('unit $unitId first chunk is not a key frame');
    }

    final chunks = <EncodedUnitChunk>[
      for (final record in unitRecords)
        EncodedUnitChunk(
          data: Uint8List.sublistView(
            bytes,
            record.byteOffset,
            record.byteOffset + record.byteLength,
          ),
          presentationTimestamp: record.presentationTimestamp,
          duration: record.duration == 0 ? 1 : record.duration,
          randomAccess: record.randomAccess,
          displayedFrameCount:
              record.displayedFrameCount == 0 ? 1 : record.displayedFrameCount,
        ),
    ];

    final ordered = await decoder.decodeUnit(
      unitId: unit.id,
      unitFrameCount: unit.frameCount,
      codedWidth: codedWidth,
      codedHeight: codedHeight,
      codecString: _codecString,
      chunks: chunks,
    );
    unitFrames[unitId] = ordered;
    debugPrint(
      '[aval] decoded unit "$unitId": ${ordered.length}/${unitRecords.length} '
      'frames @ ${codedWidth}x$codedHeight',
    );
    notifyListeners();
  }

  void _evictUnitsExcept(String keep) {
    final toRemove =
        unitFrames.keys.where((id) => id != keep).toList(growable: false);
    for (final id in toRemove) {
      final list = unitFrames.remove(id);
      if (list == null) continue;
      for (final img in list) {
        img.dispose();
      }
      debugPrint('[aval] evicted unit "$id"');
    }
  }

  /// Advances the graph by exactly one authored frame. Called at the manifest
  /// frame rate.
  void tickGraph() {
    if (_graph == null) return;
    engine.tick(MotionGraphTickOptions(contentOrdinal: _contentOrdinal));
    _contentOrdinal += BigInt.one;
    ticks.value = ticks.value + 1;
  }

  /// Sends the graph event bound to an input [source] (`activate`,
  /// `engagement.on`, `pointer.enter`, …), if the manifest binds one.
  void sendSource(String source) {
    if (_graph == null) return;
    final event = _eventForSource[source];
    if (event != null) engine.send(event);
  }

  /// Sends a graph event by name directly.
  void send(String event) {
    if (_graph != null) engine.send(event);
  }

  /// Dry-run landings for a [request] toward [target], or `null` if unreachable.
  /// Empty means already at [target]. Does not advance the graph.
  List<String>? planFor(String target) {
    if (_graph == null) return null;
    return engine.planFor(target);
  }

  /// Requests a graph state by id (turn / locomotion). Preloads the body unit
  /// for [target] so the first painted frame is ready after the edge commits.
  MotionGraphResult? request(String target) {
    if (_graph == null) return null;
    final result = engine.request(target);
    final unit = _unitForState[target];
    if (unit != null) {
      // Fire-and-forget decode for the landing unit.
      unawaited(ensureUnitDecoded(unit));
    }
    notifyListeners();
    return result;
  }

  @override
  void dispose() {
    for (final list in unitFrames.values) {
      for (final img in list) {
        img.dispose();
      }
    }
    unitFrames.clear();
    ticks.dispose();
    super.dispose();
  }
}
