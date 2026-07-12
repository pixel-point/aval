# M5 Opaque AVC Compiler and Dedicated Worker Design

**Date:** 2026-07-11

**Status:** Approved implementation slice derived from the committed web
rendered-motion design and the frozen M4 format contract

## 1. Objective

M5 turns rendered source media into the first production-codec `.rma` assets
and proves that their H.264 access units decode in a dedicated web worker
without a seek, decoder reset, reconfiguration, flush, or end-of-stream action
at a loop or unit boundary.

This milestone adds:

- a Node-only `@rendered-motion/compiler` package and noninteractive CLI;
- a pure, platform-independent `avc/` extension inside
  `@rendered-motion/format` containing the one Annex B parser and opaque-
  profile inspector used by both compiler and player;
- deterministic ingestion of local PNG sequences and local rendered video;
- independently decodable opaque H.264 units for bodies, intros, bridges, and
  reversible clips;
- compiler-owned per-state static PNG generation and SHA-256 calculation;
- deterministic pre-encode loop and transition continuity reports;
- a low-level dedicated-worker decoder client in `@rendered-motion/player-web`;
  and
- checked-in compiler and real-AVC worker conformance fixtures.

M5 is deliberately an opaque-media milestone. It emits only
`avc-annexb-opaque-v0`; any source pixel whose alpha is not 255 is rejected.
Packed alpha and the compositor remain M6 work.

M5 also does not join graph routing to decoder submission. Portal selection,
submission horizons, presentation rings, resident reversal scheduling,
readiness dry runs, and static recovery settlement remain M5.5. The worker in
this milestone is a bounded sequential decoding primitive, not a hidden
scheduler.

The CLI is functional and scriptable in M5. Guided authoring, a polished
starter, watch-mode playground integration, continuity visualization, and
friendlier remediation UX remain M8.

## 2. Authority and Package Boundaries

M4 remains the only authority for version-0.1 container bytes and compiled
manifest validity. The compiler must construct `CanonicalAssetInputV01`, call
`writeCanonicalAsset`, and then call `validateCompleteAsset` on the returned
bytes. It must not reproduce header, index, layout, canonical-JSON, sample
ordering, or graph-relation logic.

M5 also promotes format's existing bounded `parseStrictJson`,
`serializeCanonicalJson`, and immutable JSON value types through the root
public API. The editable-project parser reuses that duplicate-aware UTF-8/
scalar owner and then applies the compiler's closed source schema; provenance
uses the same canonical serializer. Compiler does not create a second JSON
tokenizer or writer.

The packages form this dependency graph:

```text
@rendered-motion/graph
          ↑
@rendered-motion/format (including its pure avc/ profile inspector)
          ↑                                      ↑
@rendered-motion/compiler          @rendered-motion/player-web
```

The M5 `format/src/avc/` extension preserves format's existing
`lib: ["ES2023"]`, `types: []`, and sole production dependency on graph. It
owns checked bit reads, Annex B normalization, RBSP decoding, SPS/PPS/slice
parsing, access-unit inspection, and the AVC rejection paths on M4's stable
`FormatError` surface. It imports neither Node nor browser APIs. The approved
inspector entry points are exported from `@rendered-motion/format`; unchecked
bit readers and mutable parser state remain private.

The default inspector policy requires exact `42 E0 20`. A separately named
encoder-candidate entry point permits only `42 C0 20` or `42 E0 20` while
enforcing every other profile and dependency rule. Only the Node compiler uses
that candidate entry point; worker/runtime code always uses strict inspection.

`@rendered-motion/compiler` is Node-only. It depends on `format`, uses Node
filesystem/process/crypto APIs behind narrow adapters, and never enters a
browser dependency graph. `player-web` also depends on `format` so its worker
uses the same inspector rather than a second H.264 parser.

The worker protocol model is platform-free. The worker implementation is
compiled with `ES2023` plus `WebWorker`, not `DOM`; importing `Window`,
`document`, canvas rendering, graph routing, or loader APIs into the worker is
a compile-time error. The main-thread client is the only M5 module that creates
and owns a `Worker`.

## 3. Compiler Architecture

The compiler is split into independently testable owners:

```text
project parser and closed source schema
                 ↓
secure path resolver and media probe
                 ↓
exact timing / normalized-frame plan
                 ↓
bounded canonical RGBA spool
                 ↓
source range and graph lowering
          ┌──────┴────────┐
          ↓               ↓
opaque AVC encoder   strict static PNG encoder
          ↓               ↓
Annex B inspector    compiler SHA-256 owner
          └──────┬────────┘
                 ↓
M4 CanonicalAssetInputV01 and writer
                 ↓
complete validation and deterministic build report
```

No stage receives broader authority than it needs. Project validation and all
output-size preflight happen before FFmpeg is spawned. FFmpeg receives only
resolved local inputs, raw frame pipes, and private temporary outputs. The AVC
inspector receives bytes but no paths. The M4 writer receives already
inspected access units and already calculated digests.

## 4. Editable Source Project

The editable project is ordinary strict UTF-8 JSON, not canonical on-wire
JSON. Whitespace and object-key order are insignificant. Parsing is duplicate-
key-aware, rejects the dangerous keys `__proto__`, `prototype`, and
`constructor` at every depth, rejects invalid Unicode and unsafe integers, and
constructs null-prototype objects before cloning into immutable values. JSON
comments, trailing commas, YAML, environment substitution, remote URLs, and
JavaScript configuration are not accepted in 0.1.

Every object is closed. Optional fields may be omitted but never replaced by
`null`. IDs and graph fields use the exact M4 identifier, trigger, start,
transition, binding, port, residency, and relationship rules.

### 4.1 Exact project schema

```ts
type Id = string; // ^[a-z][a-z0-9._-]{0,63}$
type FrameRange = readonly [startInclusive: number, endExclusive: number];
type Rect = readonly [x: number, y: number, width: number, height: number];

interface MotionProjectV01 {
  readonly projectVersion: "0.1";
  readonly profile: "avc-annexb-opaque-v0";
  readonly canvas: {
    readonly width: number;
    readonly height: number;
    readonly fit: "contain" | "cover" | "fill" | "none";
    readonly pixelAspect: readonly [1, 1];
    readonly colorSpace: "srgb";
  };
  readonly frameRate: {
    readonly numerator: number;
    readonly denominator: number;
  };
  readonly sources: readonly ProjectSourceV01[];
  readonly renditions: readonly OpaqueRenditionTargetV01[];
  readonly units: readonly ProjectUnitV01[];
  readonly initialState: Id;
  readonly states: readonly ProjectStateV01[];
  readonly edges: readonly ProjectEdgeV01[];
  readonly bindings: readonly ProjectBindingV01[];
}

type ProjectSourceV01 = VideoSourceV01 | PngSequenceSourceV01;

interface VideoSourceV01 {
  readonly id: Id;
  readonly type: "video";
  readonly path: string;
  readonly timing:
    | { readonly mode: "exact" }
    | { readonly mode: "normalize-hold" };
}

interface PngSequenceSourceV01 {
  readonly id: Id;
  readonly type: "png-sequence";
  readonly directory: string;
  readonly prefix: string;
  readonly digits: number;
  readonly suffix: ".png";
  readonly firstNumber: number;
  readonly frameCount: number;
}

interface OpaqueRenditionTargetV01 {
  readonly id: Id;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly bitrate: {
    readonly average: number;
    readonly peak: number;
  };
}

interface ProjectUnitBaseV01 {
  readonly id: Id;
  readonly source: Id;
  readonly range: FrameRange;
}

type ProjectUnitV01 =
  | (ProjectUnitBaseV01 & {
      readonly kind: "body";
      readonly playback: "loop" | "finite";
      readonly ports: readonly {
        readonly id: Id;
        readonly entryFrame: 0;
        readonly portalFrames: readonly number[];
      }[];
    })
  | (ProjectUnitBaseV01 & { readonly kind: "bridge" })
  | (ProjectUnitBaseV01 & {
      readonly kind: "reversible";
      readonly residency: {
        readonly endpoints: readonly [
          { readonly state: Id; readonly port: Id; readonly frames: number },
          { readonly state: Id; readonly port: Id; readonly frames: number }
        ];
      };
    })
  | (ProjectUnitBaseV01 & { readonly kind: "one-shot" });

interface ProjectStateV01 {
  readonly id: Id;
  readonly bodyUnit: Id;
  readonly initialUnit?: Id;
  readonly poster?: {
    readonly source: Id;
    readonly frame: number;
  };
}

type ProjectTriggerV01 =
  | { readonly type: "event"; readonly name: Id }
  | { readonly type: "completion" };

type ProjectStartV01 =
  | {
      readonly type: "portal";
      readonly sourcePort: Id;
      readonly targetPort: Id;
      readonly maxWaitFrames: number;
    }
  | {
      readonly type: "finish";
      readonly targetPort: Id;
      readonly maxWaitFrames: number;
    }
  | {
      readonly type: "cut";
      readonly targetPort: Id;
      readonly maxWaitFrames: 1;
    };

type ProjectTransitionV01 =
  | { readonly kind: "locked"; readonly unit: Id }
  | {
      readonly kind: "reversible";
      readonly unit: Id;
      readonly direction: "forward" | "reverse";
      readonly reverseOf?: Id;
    };

type ProjectEdgeV01 =
  | {
      readonly id: Id;
      readonly from: Id;
      readonly to: Id;
      readonly trigger?: ProjectTriggerV01;
      readonly start: Exclude<ProjectStartV01, { readonly type: "cut" }>;
      readonly transition?: ProjectTransitionV01;
      readonly continuity: "exact-authored" | "exact-reverse";
    }
  | {
      readonly id: Id;
      readonly from: Id;
      readonly to: Id;
      readonly trigger?: ProjectTriggerV01;
      readonly start: Extract<ProjectStartV01, { readonly type: "cut" }>;
      readonly continuity: "cut";
      readonly targetRunwayFrames: number;
    };

type ProjectBindingSourceV01 =
  | "activate"
  | "engagement.off"
  | "engagement.on"
  | "focus.in"
  | "focus.out"
  | "hidden"
  | "pointer.enter"
  | "pointer.leave"
  | "visible";

interface ProjectBindingV01 {
  readonly source: ProjectBindingSourceV01;
  readonly event: Id;
}
```

### 4.2 Project constraints

The project adopts M4's default hard maxima: 32 states, 64 edges, 96 units,
four renditions, 32 bindings, 900 total unit frames, 3,600 access-unit
records, 128 unit/static blobs, 32 MiB compiled bytes, and 64 MiB declared
runtime bytes. Caller options may only lower these maxima.

Additional M5 constraints are:

- the project JSON is at most 1 MiB with depth at most 64, at most 20,000
  nodes, and at most 4,096 UTF-8 bytes in one string; parsing enforces these
  before constructing a large value;
- there are 1–32 sources; source path/directory strings are 1–4,096 UTF-8
  bytes with no C0 control, and PNG prefixes are 1–128 UTF-8 bytes;
- canvas dimensions and every rendition dimension are multiples of 16;
- canvas dimensions are at most 512 each; rendition dimensions are positive,
  no greater than their canvas dimension, and preserve the canvas aspect ratio
  exactly;
- all source display dimensions preserve the canvas aspect ratio and are at
  most 4,096 by 4,096; the fixed compiler scale may downsample but never
  upsample;
- pixel aspect is square, source rotation is zero, and interlaced video is
  rejected;
- the exact frame rate is positive, reduced, has denominator at most 1,001,
  and is at most 60 frames per second;
- source videos are at most 30 seconds and 1,800 decoded source frames;
- a PNG sequence contains 1–1,800 files; `digits` is 1–9; `prefix` is a plain
  filename prefix with no slash, backslash, NUL, or `%`; and every generated
  file name exists exactly once; `firstNumber` is nonnegative and
  `firstNumber + frameCount - 1 < 10 ** digits`;
- rendition average bitrate is positive, average is at most peak, and peak is
  at most 8,000,000 bits per second;
- every range contains positive length and is contained in its normalized
  source frame count;
- an optional state poster frame is a nonnegative normalized frame index
  contained in the named source; when omitted it means the source frame at the
  start of that state's body range;
- ranges are always half-open source-frame ranges; compiled unit frame zero is
  the source frame at `startInclusive`;
- `frameCount` is always derived as `endExclusive - startInclusive`;
- a source may feed more than one unit, and overlapping ranges are valid;
- graph, unit-use, portal, reversible inverse, runway, completion, and binding
  relations are exactly M4's relations after derived fields are added; and
- every source and rendition is referenced. Unused media is an error rather
  than silent build input.

Source, rendition, unit, state, and edge arrays need not be sorted in the
editable project. The compiler sorts their immutable normalized forms by M4's
UTF-8/ASCII identifier order. Two projects that differ only in insignificant
JSON whitespace, object-key order, or identity-array order therefore produce
the same asset.

### 4.3 Fields the compiler owns

Authors cannot provide the following compiled fields:

- generator text;
- sample spans, sample ordinals, key flags, payload offsets, or payload sizes;
- unit frame counts;
- static-frame IDs, offsets, lengths, dimensions, bytes, or digests (a state
  may select poster source/frame content only);
- unit digests;
- readiness bootstrap units or immediate edges;
- fallback policy;
- alpha layout, codec strings, capability strings, or color rectangles; and
- compiled/runtime estimates.

The compiler derives these values and passes them through M4 validation. This
prevents a project from asserting that an uninspected payload is a key frame,
smuggling a digest, or inflating a declared resource budget.

## 5. Media Discovery and Timing

### 5.1 Local inputs only

All project paths are resolved relative to the directory containing the
project. The resolver rejects absolute paths in project JSON, empty segments,
`.` and `..` segments, NUL, URL syntax, device paths, named pipes, sockets, and
any symlink whose real path escapes the real project root. A direct-input CLI
argument establishes its containing directory as the root and is resolved to
one local regular file or one constrained PNG pattern.

M5 accepts the QuickTime/ISO-BMFF demuxer family reported by FFprobe for local
`.mov`, `.mp4`, and `.m4v` inputs. File extensions are an early diagnostic, not
the security decision; the probed demuxer must be on the allowlist. Exactly one
selected video stream is permitted. Audio, subtitles, attachments, chapters,
and metadata are ignored and never copied to output. External references,
playlists, concat inputs, image URLs, and network-backed protocols are
rejected.

### 5.2 Exact frame-rate mode

FFprobe supplies each decoded frame's best-effort presentation timestamp and
duration as exact rational values. The compiler subtracts the first timestamp
and requires frame `i` to begin at exactly
`i * denominator / numerator` seconds and to have exactly one frame duration.
Missing, repeated, decreasing, or off-grid timestamps are `VFR_UNSUPPORTED`
errors.
The diagnostic contains the first mismatching frame and a bounded table of the
expected and observed rational timestamps.

PNG sequences are inherently exact-mode sources at the project frame rate.

### 5.3 Explicit normalization mode

`normalize-hold` is opt-in and uses no interpolation. For target frame `n` at
exact time `n / fps`, it selects the latest source frame whose relative PTS is
less than or equal to that target time. A target tick before the first source
PTS uses the first frame. Target ticks stop before the probed presentation end
of the final source frame. Selection uses integer/rational cross-
multiplication, never floating-point seconds.

The build report lists every duplicated source frame, every source frame not
selected, and the exact output count. Normalization is performed before unit
ranges are interpreted, so every project range uses the normalized frame
numbering. An output duplicate at an authored seam is still visible to later
continuity analysis; M5 does not silently remove it.

### 5.4 Canonical RGBA spool

Before scaling, a bounded native-resolution alpha-audit filter examines every
referenced source frame and reports its minimum alpha. A minimum below 255
causes a targeted one-frame alpha-plane read, capped by the 4,096-square source
limit, solely to locate the first failing x/y coordinate. Thus downsampling
cannot erase evidence of transparency. Sources whose probed pixel format has
no alpha channel are defined as opaque and skip the audit.

FFmpeg then decodes or scales into top-to-bottom, tightly packed,
unpremultiplied RGBA8 at the logical canvas dimensions. Downscaling uses one
frozen filter expression, single-threaded filter execution, square sample
aspect, and explicit sRGB-to-BT.709-compatible conversion settings recorded in
the build report. Source dimensions must have the same aspect ratio, so the
compiler does not crop, letterbox, or stretch.

Only normalized frames referenced by at least one unit or state poster are
spooled. The compiler precomputes and decodes the unique selected native-frame
set once, then writes one fixed-size spool frame for every referenced
normalized project frame; normalize-hold duplicates therefore remain explicit
without repeated prefix decodes. It retains at most two canvas RGBA frames in
memory during decode. The spool is capped at 1 GiB from
`selectedProjectFrameCount * width * height * 4` before decoding. Short reads,
extra frames, or a probe/decode count mismatch are fatal.

Every canonical frame is scanned again before encoding. The first alpha byte
other than 255 fails with `OPAQUE_ONLY_M5` and bounded
source/frame/x/y context. M5 never composites transparency against an implicit
color.

## 6. Unit Lowering

Each project unit becomes one M4 unit. Its source range is extracted and
renumbered to `[0, frameCount)`. An intro is a `one-shot`, a closed or finite
state body is a `body`, a locked transition is a `bridge`, and a bidirectional
resident clip is a `reversible` unit. Reversal uses one forward-authored
encoded unit; the inverse graph edge does not cause a second reversed encode.

For every rendition/unit pair, the compiler streams the selected RGBA frames
to one fresh FFmpeg encoder process. Separate invocation is intentional: it
makes every unit begin a new coded sequence and prevents any prediction,
lookahead, or rate-control state from crossing a unit boundary.

Every compiled unit obeys these access-unit rules:

- there is exactly one access unit per project frame;
- access units use normalized four-byte Annex B start codes;
- access unit zero contains AUD, SPS, PPS, and exactly one IDR I slice;
- every later access unit contains AUD and exactly one non-IDR P slice;
- parameter sets occur only in frame zero;
- normalized SPS and PPS bytes are identical across every unit of one
  rendition, so a continuous decoder never changes configuration;
- SEI, filler, end-sequence, end-stream, data partition, redundant slice,
  multiple-slice, and unknown NAL unit types are absent;
- frame zero is the only M4 record marked key; and
- no encoded dependency can refer to a frame outside the current unit.

The compiler rejects rather than repairs an encoded stream that fails these
rules, with three narrowly defined canonicalizations before final inspection:

1. valid three- or four-byte Annex B prefixes become four-byte prefixes;
2. the encoder's explicitly expected SEI NAL is removed; and
3. an otherwise conforming SPS prefix `42 C0 20` may become `42 E0 20` by
   setting only `constraint_set2_flag`.

The raw-output normalizer first performs a bounded NAL scan that permits only
the final-profile NAL types plus the expected type-6 encoder SEI. It removes
that SEI, then runs a candidate inspection accepting only compatibility byte
`C0` or `E0`. No candidate-profile exception bypasses syntax/dependency checks.

The third rule exists because the tested Homebrew FFmpeg 8.1.2/libx264 r3222
Baseline Level 3.2 encoder emits compatibility byte `C0`, while M4 has already
frozen the rendition codec string `avc1.42E020`. It is allowed only after a
pre-normalization inspection proves the complete stream obeys the stricter M5
subset represented by `E0`: Baseline syntax, CAVLC, no B/SP/SI pictures, one
reference, no interlacing/FMO/redundant pictures, and all dependency rules in
Section 9. The compiler then changes that one SPS constraint flag, performs a
fresh strict inspection requiring exact `42 E0 20`, and only then splits and
hashes samples. Input already using exact `42 E0 20` is unchanged. Any other
profile/compatibility/level triplet is rejected.

No PPS, slice, VCL, timing, geometry, color, or other SPS byte is rewritten.
The build report records whether this constraint-bit normalization occurred
for each rendition/unit.

## 7. Frozen Opaque AVC Profile

M5 emits this one rendition profile:

```ts
{
  profile: "avc-annexb-opaque-v0",
  codec: "avc1.42E020",
  alphaLayout: {
    type: "opaque-v0",
    colorRect: [0, 0, codedWidth, codedHeight]
  },
  capabilities: ["webcodecs", "webgl2"]
}
```

The encoder consumes RGBA raw video and emits 8-bit 4:2:0 limited-range
BT.709 H.264 Annex B. The invocation fixes all output-affecting options:

- `libx264`, Constrained Baseline profile, level 3.2;
- `yuv420p`, progressive frames, square sample aspect;
- no B frames, one reference frame, CAVLC, one slice, closed GOP;
- one encoder thread, one lookahead thread, deterministic mode;
- scene-cut insertion disabled and a key interval greater than M4's maximum
  unit length, leaving only the initial IDR;
- AUD and repeated headers enabled for the initial access unit;
- no HRD, SEI, filler, timecode, container, audio, or copied metadata;
- explicit average bitrate, peak VBV rate, and fixed buffer-size rule;
- BT.709 primaries, transfer, matrix, and limited range; and
- raw Annex B output to a bounded pipe or private file.

The normative ordered encode vector is equivalent to the following token
array; bracketed values are already validated decimal strings, not shell
substitutions:

```text
-nostdin -hide_banner -loglevel error -xerror
-max_alloc 67108864 -protocol_whitelist pipe
-f rawvideo -pixel_format rgba -video_size [canvasWxcanvasH]
-framerate [fpsN/fpsD] -i pipe:0
-map 0:v:0 -an -sn -dn -map_metadata -1 -map_chapters -1
-vf scale=[codedW]:[codedH]:flags=lanczos+accurate_rnd+full_chroma_int:in_range=full:out_range=tv:in_color_matrix=bt709:out_color_matrix=bt709,setsar=1,format=yuv420p
-frames:v [frameCount] -fps_mode passthrough
-c:v libx264 -preset medium -tune zerolatency
-profile:v baseline -level:v 3.2 -pix_fmt yuv420p
-color_range tv -color_primaries bt709 -color_trc bt709 -colorspace bt709
-threads 1 -filter_threads 1
-g 901 -keyint_min 901 -sc_threshold 0 -bf 0 -refs 1
-b:v [average] -maxrate [peak] -bufsize [peak]
-x264-params aud=1:bframes=0:cabac=0:colormatrix=bt709:colorprim=bt709:force-cfr=1:keyint=901:min-keyint=901:open-gop=0:ref=1:range=tv:repeat-headers=1:scenecut=0:sliced-threads=0:slices=1:threads=1:lookahead-threads=1:sync-lookahead=0:transfer=bt709
-f h264 pipe:1
```

The exact vector is a checked-in constant and fixture. An implementation may
change option spelling only if a tool-capability adapter proves equivalence and
the different vector/tool digest becomes part of the determinism inputs. The
implementation invokes FFmpeg with `shell: false`; no project value is ever
concatenated into a command string. Encoder SEI removal and SPS constraint-bit
normalization remain compiler byte-processing steps after FFmpeg returns.

Level limits are checked twice: once from requested dimensions/rate/bitrate
before encoding, and again from parsed SPS fields. The compiler also computes
macroblocks per frame, macroblocks per second, decoded picture buffer demand,
and requested peak bitrate against level 3.2. A profile that would require
silent level escalation is rejected.

## 8. FFmpeg Trust, Security, and Provenance

### 8.1 User-installed tool policy

The package never includes, downloads, installs, updates, or redistributes
FFmpeg, FFprobe, `libx264`, or a codec binary. Tool resolution order is:

1. explicit `--ffmpeg` and `--ffprobe` absolute paths;
2. `RMA_FFMPEG` and `RMA_FFPROBE` absolute paths; then
3. `ffmpeg` and a sibling `ffprobe` resolved from the caller's `PATH`.

Both resolved paths are converted to real absolute regular files before use.
The compiler requires an FFmpeg build whose encoder list contains `libx264`
and whose reported version/configuration passes the M5 capability probe.
Using the compiler does not settle codec patent, content, or distribution
obligations; release documentation retains the legal review warning from the
master design.

### 8.2 Invocation sandbox

Every probe/decode/encode child process receives:

- `-nostdin`, an explicit error log level, and no interactive overwrite;
- a protocol whitelist containing only `file` and `pipe`;
- an operation-specific demuxer/muxer allowlist;
- `-max_alloc 67108864`, one processing thread, bounded probe/analyze values,
  bounded frame count, and bounded mux queues;
- FFmpeg's CPU-time limit where supported plus a parent-enforced wall clock;
- a byte-counting stdout/stderr reader that kills the process group before an
  output or diagnostic cap is crossed;
- a minimal inherited environment with `LC_ALL=C`, `LANG=C`, and no proxy
  variables; and
- a private mode-0700 working directory under an explicitly selected local
  temp root.

`-max_alloc` limits any one FFmpeg allocation; dimensions, frame counts,
single-thread operation, pipe capacities, and parent-side spool/output caps
bound aggregate compiler exposure. The implementation must not describe this
as a portable OS-level RSS hard limit. Where a platform runner can apply
`RLIMIT_AS`/job-object limits, it does so and records that fact; absence of
that optional outer limit is recorded as `aggregateMemoryLimit: "derived"`.

The default wall limits are 15 seconds for a probe and 120 seconds for each
decode or encode subprocess, lowerable by compiler options. Cancellation sends
the process group a graceful termination, waits at most one second, then kills
it. All pipes are drained or destroyed, temporary handles are closed, and the
working directory is recursively removed without following symlinks.

### 8.3 Build provenance

Every successful `compile` writes a deterministic asset plus a canonical
`<asset>.build.json` report. The report contains:

- compiler package/version and normalized command options;
- Node major version, OS/architecture, and whether an outer memory limiter was
  active;
- FFmpeg and FFprobe executable SHA-256, version lines, hashes of the complete
  version/capability outputs, build configuration, enabled `libx264`
  capability, the effective calibration-stream SHA-256, and the exact ordered
  argv templates with local paths redacted to project-relative IDs;
- project-file SHA-256 and each input file SHA-256 in normalized source/frame
  order;
- probed stream, exact timestamp, normalization, scale, and alpha-scan results;
- every unit/rendition encode result and inspector summary;
- every internal unit/static digest; and
- final byte length and host-facing whole-file SHA-256.

The report is provenance, not part of the `.rma` file and not an authenticity
trust root. Machine-specific report fields may differ between machines. Asset
byte determinism is defined by identical project semantics, input bytes,
compiler version, normalized compiler options, and the complete recorded
toolchain identity: resolved FFmpeg/FFprobe executable digests, hashed version
and capability outputs, configuration, and effective calibration-stream
digest. Calibration is required because a stable executable may load a
different codec library dynamically.

The on-wire `generator` is the fixed ASCII string
`rendered-motion-compiler/0.1`; it contains no machine path, timestamp, host
name, Git state, or tool output.

## 9. Annex B Inspection

The pure AVC inspector treats encoder output and loaded asset bytes as
untrusted. All byte/bit arithmetic is checked before access. It has lower-only
budgets for unit bytes, sample count, NAL count, NAL bytes, RBSP bytes, and
Exp-Golomb prefix length. It returns frozen metadata or `FormatError` with
`PROFILE_INVALID` plus a stable path/offset; built-in exceptions never escape.

### 9.1 Annex B and access-unit grammar

The parser recognizes valid three- and four-byte start codes, rejects missing
start codes, empty NALs, a nonzero `forbidden_zero_bit`, leading garbage,
ambiguous trailing garbage, and budget overflow. The compiler normalizer emits
one four-byte prefix before every retained NAL and no leading/trailing zero
padding.

AUD NALs define access-unit boundaries. Every access unit must have one AUD
first and exactly one VCL NAL last. The first unit-local access unit has one SPS
and one PPS between them. Later access units contain no parameter set. The
inspector never trusts an M4 key flag; it derives key status from the VCL type
and compares the result to the record.

### 9.2 SPS requirements

The SPS parser removes emulation-prevention bytes and validates, at minimum:

- `profile_idc = 66`, exact post-normalization compatibility byte `E0`, and
  `level_idc = 32` as represented by `avc1.42E020`;
- supported Baseline syntax with implicit 4:2:0 chroma and 8-bit samples;
- bounded `log2_max_frame_num`, supported picture-order mode, and no gaps;
- `max_num_ref_frames <= 1`;
- progressive `frame_mbs_only_flag = 1` and no MBAFF;
- macroblock coded geometry exactly equal to the rendition dimensions, with
  all crop offsets zero;
- square sample aspect;
- VUI timing exactly representing the manifest rational frame rate with fixed
  frame rate set;
- BT.709 primaries, transfer, matrix coefficients, and limited range; and
- level-3.2 macroblock, rate, DPB, and bitrate bounds.

Unsupported scaling matrices, interlacing, HRD, or syntax that the inspector
does not completely bound is rejected rather than skipped.

### 9.3 PPS and slice requirements

The PPS must reference the inspected SPS, use CAVLC, one slice group, no
weighted prediction, no redundant pictures, and the frozen deblocking/profile
settings emitted by the invocation.

The inspector parses enough of every slice header to prove:

- access-unit zero is an IDR I slice using the inspected PPS;
- all later frames are non-IDR P slices, never B/SP/SI;
- there is exactly one slice header and it begins at macroblock zero; entropy-
  coded macroblock validity remains the decoder's responsibility;
- `frame_num` starts at zero and advances by one modulo the SPS range;
- IDR identifiers and picture order obey the frozen profile;
- reference-list operations cannot select an unavailable or cross-unit
  picture; and
- decoded presentation order equals coded access-unit order.

It is not a general H.264 decoder. Any legal H.264 construct outside the
frozen profile is format `PROFILE_INVALID`; the compiler maps that failure to
`AVC_PROFILE_INVALID` without losing its path or byte offset.

### 9.4 Public inspector result

The public result contains codec/profile/level, dimensions, color/timing
metadata, parameter-set scalar summaries, normalized access-unit byte ranges,
derived key flags, frame numbers, slice kinds, and a unit-independence result.
The pure package does not pretend to own platform cryptography. It never
retains a caller byte view. Compiler code uses the ranges to copy canonical
sample payloads and owns any SHA-256; worker code uses the incremental state
machine before calling `VideoDecoder.decode()`.

## 10. Static PNGs and Digests

M5 generates a required static representation for every state. By default it
uses frame zero of that state's canonical body unit. A state's optional
`poster` selector may instead name one normalized frame in any declared local
source, allowing deliberate static art direction without exposing PNG bytes or
compiled descriptors. The generated PNG is at logical canvas size and contains
normalized opaque RGBA pixels from the same bounded source pipeline that feeds
the encoders before rendition scaling.

The compiler owns a deterministic minimal PNG encoder. It emits:

```text
PNG signature
IHDR: canvas width/height, 8-bit RGBA, compression/filter/interlace 0
sRGB: rendering intent 0
IDAT: zlib stream of filter-0 rows using deterministic stored DEFLATE blocks
IEND
```

There is exactly one of each chunk, CRCs and Adler-32 are calculated by
compiler-owned checked implementations, no metadata/time/text chunk is
present, and the file remains within M4's 2 MiB static limit. Stored DEFLATE is
chosen so PNG bytes do not vary with a platform zlib version. M6 still owns
the independent full runtime PNG parser/decompressor and decoded-surface
validation; M5 does not move that browser fallback gate earlier.

Each state first receives a derived ID `static.NN`, where `NN` is its zero-
padded ordinal in canonical state-ID order (`00` through `31`). Ordinals keep
the derived ID within M4's 64-byte ID limit even when a state itself uses the
full limit. If two generated PNGs are byte-identical, the compiler retains the
lowest-ordinal descriptor and points both states to it. The build report maps
state IDs to poster IDs. This uses M4's shared-static rule and avoids
duplicating large posters.

The compiler calculates SHA-256 with Node's platform crypto over:

- the exact concatenation of canonical access-unit payload bytes for each
  rendition/unit pair, excluding format padding;
- each complete generated PNG; and
- the final complete asset for the external build report.

Unit and static lowercase hex digests are inserted into
`CanonicalAssetInputV01`; M4 never receives placeholders. After writing, the
compiler independently recomputes all internal digests from the final byte
ranges and fails if one differs. M7 still owns streaming runtime verification
before bytes reach persistent caches or the decoder.

## 11. Visual-Continuity Analysis

The compiler analyzes source pixels before lossy AVC encoding. For every
looping body it examines the last-to-first boundary. For every non-cut edge it
examines each composed boundary: source portal/finish to transition frame zero
when a transition exists, transition final frame to target body frame zero,
or source directly to target when no transition exists. Reversible forward and
inverse endpoints are both reported from the one forward-authored clip. Cut
edges are recorded as deliberate cuts and are not presented as seamless.

Frame comparison uses linear-light premultiplied RGBA. For a boundary, let
`boundaryRms` be RGB RMS across that boundary and `neighborP95` be the 95th
percentile of up to four internal adjacent-frame differences on each side,
excluding the boundary. The alpha channel is calculated independently even
though M5 requires alpha 255. The deterministic heuristic passes when:

```text
boundaryRms <= 1.5 * max(neighborP95, 1 / 255)
alphaBoundaryRms <= 1.5 * max(alphaNeighborP95, 1 / 255)
```

The report includes both RMS values, both neighbor percentiles, the exact
source/unit frames and playback directions, whether the boundary frames are
byte-identical, whether that identity is a repeated endpoint amid surrounding
motion, and `pass | cut`. A non-cut heuristic failure is
`CONTINUITY_FAILED`: no asset is published. This intentionally makes seamless
motion the compiler's safe default instead of letting a likely visible stop
ship as a warning. A genuinely static loop remains valid; exact identity is
actionable only when neighboring motion exceeds the measurement floor.
Explicit `continuity: "cut"` remains the only way to declare an intentional
jump.

M5 does not remove duplicate endpoints, interpolate frames, run optical flow,
or generate a heatmap. M8 may visualize the existing scalar report and add
author-facing remediation, but it must not silently change the metric or asset
bytes.

## 12. Derived Compiled Manifest

The compiler lowers normalized source values as follows:

- project canvas and frame rate map directly to M4;
- each rendition gets the frozen codec/profile/capabilities/opaque layout and
  its requested bitrate;
- unit frame counts, ordered sample spans, sample counts, and digests are
  derived from inspected output;
- states receive derived, possibly shared static IDs;
- edges and bindings map without semantic rewriting;
- `readiness.policy` is `all-routes`;
- `immediateEdges` is the sorted exact set originating at `initialState`;
- `bootstrapUnits` is the sorted minimal set required by M4: the initial body,
  optional initial one-shot, and the transition/target bodies for immediate
  edges;
- fallback is fixed to per-state static for unsupported and reduced motion;
  and
- resource estimates are computed from actual output geometry and byte counts.

The resource formulas are deterministic and conservative for one selected
rendition:

```text
maxSurfaceDimension(d) = ceil(d / 16) * 16 + 16
decodedPixelBytes = max(
  maxSurfaceDimension(codedWidth)
  * maxSurfaceDimension(codedHeight)
  * 4
)

persistentFrames =
  sum(reversible unit frame counts)
  + sum(reversible residency endpoint runway frames)
  + sum(cut target runway frames)

persistentCacheBytes = persistentFrames * decodedPixelBytes

runtimeWorkingSetBytes =
  persistentCacheBytes
  + 12 * decodedPixelBytes
  + max(total encoded unit bytes for one rendition)
  + canvasWidth * canvasHeight * 4
```

`maxRuntimeBytes` is 64 MiB and `maxCompiledBytes` is 32 MiB. If checked
arithmetic or the working-set formula crosses its cap, compilation fails. The
runtime will independently recompute a more exact page-wide budget in M5.5/M7;
these manifest values remain advisory.

## 13. Deterministic Build Contract

For the determinism inputs defined in Section 8.3, two compiles must produce
byte-identical `.rma` output. The compiler enforces this through:

- immutable normalized source objects and canonical ID ordering;
- exact rational timestamp arithmetic;
- fixed frame selection and scaling arguments;
- separate single-thread deterministic encodes per rendition/unit;
- fixed H.264 options and removal of variable encoder SEI;
- the one proven-and-reinspected SPS `C0` to `E0` constraint-bit normalization;
- canonical four-byte Annex B start codes and one inspector-owned split;
- compiler-owned deterministic PNG, CRC, Adler-32, and SHA-256 calculation;
- no dates, random values, temp names, absolute paths, host details, or source
  metadata in asset bytes; and
- the M4 canonical writer as the only final serializer.

The golden test compiles twice from differently ordered but semantically equal
projects, compares every byte, deletes all outputs, compiles again in a fresh
temporary root, and compares the result and all internal digests. A changed
FFmpeg executable digest is a different determinism input and must be visible
in provenance rather than incorrectly promised byte-identical output.

## 14. CLI Contract

The provisional executable name is `rma`; like `.rma`, it remains private and
is not a public product name. All commands are noninteractive. `--json` writes
one canonical JSON result to stdout and newline-delimited canonical diagnostic
objects to stderr. Without `--json`, M5 provides concise text; richer guidance
is M8 work.

### 14.1 Compile a project

```text
rma compile <project.json> --out <asset.rma>
  [--report <asset.build.json>]
  [--ffmpeg <absolute-path>] [--ffprobe <absolute-path>]
  [--force] [--json]
```

The default report path is `<asset.rma>.build.json`. Existing asset or report
paths are refused unless `--force`; symlink outputs are always refused. The
compiler writes and fsyncs private same-filesystem stages, validates the
complete asset and canonical report, then installs the report and asset with
no-clobber hard-link commit points. A forced replacement first secures the
exact previously inspected inodes. Any failed pair commit removes only
transaction-owned inodes and restores proven backups; it never unlinks a
raced path. On failure, no transaction-owned partial pair remains.

### 14.2 Direct one-state compile

```text
rma compile <input.mov|input.mp4|input.m4v> \
  --loop <start:end> --out <asset.rma>
  [--fps <numerator/denominator>]
  [--canvas <width>x<height>]
  [--bitrate <average>:<peak>]
  [common compile options]

rma compile <directory/prefix%0Nd.png> \
  --frames <first-number:count> --fps <numerator/denominator> \
  --loop <start:end> --canvas <width>x<height> --out <asset.rma>
  [--bitrate <average>:<peak>] [common compile options]
```

The only accepted PNG placeholder is one `%0Nd` token with `N` in 1–9. Shell
globs are not accepted. Direct frame indices are half-open and refer to the
normalized source. Without `--fps`, video must be CFR and its reduced detected
rate becomes the project rate. Supplying `--fps` explicitly selects
`normalize-hold`. PNG sequences always require `--fps`.

The direct project has one state `default`, looping body `body.default`, port
`default` with portal frame `body.frameCount - 1`, and no edges or bindings.
If `start > 0`, `[0, start)` becomes `intro.default`; `[start, end)` becomes the
body; and frames at or after `end` are reported as unused. The static frame is
the first loop frame. The default rendition is `opaque.1x`; default bitrate is
2,000,000 average and 3,000,000 peak. If canvas cannot be inferred as a valid
non-upsampled, aspect-preserving multiple-of-16 size, `--canvas` is required.
Inference enumerates width/height pairs from 16 through 512 in steps of 16,
keeps pairs whose cross-multiplied aspect exactly equals the probed display
aspect and does not exceed the source, and selects the greatest pixel area
(then greatest width as the deterministic tie-break). PNG direct input always
requires `--canvas`.

### 14.3 Inspect and validate

```text
rma inspect <asset.rma> [--json]
rma validate <asset.rma> [--json]
```

`inspect` is read-only and prints header/manifest summaries, exact frame/time
tables, unit ranges, access-unit NAL/SPS/PPS/slice summaries, internal and
whole-file digest results, and the M5 claim boundary. It never decodes video.

`validate` performs M4 complete validation, recomputes every internal digest,
and runs the opaque AVC inspector over every AVC unit. It reports static PNG as
`generated-profile-envelope` or `m4-envelope-only`; it does not claim M6's
independent PNG decode validation. Success exits zero only if every required
M5 check passes.

### 14.4 Unpack

```text
rma unpack <asset.rma> --out <empty-directory> [--json]
```

Unpack validates before writing. It produces canonical `manifest.json`,
`index.json`, one normalized `.h264` file per rendition/unit, one `.au` file
per access unit, static `.png` files, and `unpack-report.json` with source byte
ranges and digests. Output names derive only from already validated IDs. The
target must not exist or must be empty; no overwrite flag exists in M5.

### 14.5 Baseline init and dev

```text
rma init <directory> [--json]
rma dev <project.json> --out <asset.rma> [common compile options]
```

M5 `init` writes a schema-valid minimal two-frame, one-state generated example
and a command-only README. It does not include the designed idle/hover starter,
licensed artwork, framework examples, or authoring UI promised for M8.

M5 `dev` performs one compile, watches only the resolved project and local
input files, and recompiles after a 100 ms deterministic debounce. It emits
build/diagnostic records but serves no HTTP site and has no playground. File
changes abort the active build, never run concurrent FFmpeg processes, and
publish only the newest successful asset. Watch-mode playground integration
and visual continuity tooling remain M8.

### 14.6 Exit status and diagnostics

| Status | Meaning |
| ---: | --- |
| 0 | command succeeded |
| 2 | CLI, project-schema, graph, range, or source-timing rejection |
| 3 | FFmpeg/FFprobe missing, incompatible, timed out, or security policy failure |
| 4 | frame decode, opaque scan, AVC encode, or AVC inspection failure |
| 5 | compiled format, digest, or post-write validation failure |
| 6 | local filesystem, temp-space, or atomic-publication failure |
| 130 | caller cancellation or interrupt |

Every diagnostic has a stable code, severity, bounded message, and optional
project-relative file, schema path, source ID, frame, and byte offset. It never
renders input strings as terminal control sequences or HTML. M8 may improve
wording, grouping, and suggested fixes without changing these machine codes.

The M5 compiler code set is closed:

```text
ASSET_INVALID          AVC_PROFILE_INVALID    CANCELLED
CLI_USAGE              CONTINUITY_FAILED      FFMPEG_FAILED
FFMPEG_NOT_FOUND       FFMPEG_UNSUPPORTED     FRAME_RANGE_INVALID
INPUT_INVALID          IO_FAILED              OPAQUE_ONLY_M5
OUTPUT_LIMIT           PATH_OUTSIDE_ROOT      PROCESS_TIMEOUT
SOURCE_LIMIT           VFR_UNSUPPORTED
```

`CONTINUITY_FAILED` is an error and makes `compile` nonzero without publishing
an asset. `CANCELLED` maps to status 130. The other codes map to the exit-status
category table above. Adding a code requires a minor compiler API review; M8
wording changes do not rename codes.

## 15. Dedicated Decoder Worker

### 15.1 Responsibility

The M5 worker owns exactly one `VideoDecoder` session, validates one sequential
opaque AVC stream, applies bounded backpressure, transfers decoded frames to
its client, and disposes deterministically. It does not fetch an asset, parse a
manifest, choose a rendition, route a graph edge, assign a portal, choose a
loop submission horizon, cache resident frames, render, or decide readiness.

The test harness supplies a known sequential path. M5.5 will become the first
consumer that derives that path from graph and readiness state.

### 15.2 Protocol types

All messages are closed objects with `protocolVersion: 1`. Request/response
operations use a positive safe-integer `requestId`; asynchronous frame events
are correlated by `frameId`, `generation`, and `ordinal`. Unknown messages or
fields are fatal protocol errors. The exact version-1 protocol shape is:

```ts
type MainToWorkerV01 =
  | {
      readonly protocolVersion: 1;
      readonly type: "configure";
      readonly requestId: number;
      readonly config: {
        readonly codec: "avc1.42E020";
        readonly codedWidth: number;
        readonly codedHeight: number;
        readonly hardwareAcceleration:
          | "no-preference"
          | "prefer-hardware"
          | "prefer-software";
        readonly optimizeForLatency: true;
        readonly description?: never;
      };
      readonly avcProfile: {
        readonly codedWidth: number;
        readonly codedHeight: number;
        readonly frameRate: RationalV01;
        readonly averageBitrate: number;
        readonly peakBitrate: number;
        readonly cpbBufferBits: number; // exact M5 rule: peakBitrate
        readonly requireBt709LimitedRange: true;
      };
      readonly expectedOutput: {
        readonly codedWidth: number;
        readonly codedHeight: number;
        readonly displayWidth: number;
        readonly displayHeight: number;
        readonly visibleRect: {
          readonly x: number;
          readonly y: number;
          readonly width: number;
          readonly height: number;
        };
        readonly colorSpace: ExpectedVideoColorSpaceV01 | null;
      };
      readonly limits: {
        readonly maxDecodeQueueSize: number;
        readonly maxPendingSamples: number;
        readonly maxOutstandingFrames: number;
        readonly maxDecodedBytes: number;
      };
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "activate-generation";
      readonly requestId: number;
      readonly generation: number;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "submit";
      readonly requestId: number;
      readonly generation: number;
      readonly samples: readonly {
        readonly ordinal: number;
        readonly unitId: Id;
        readonly unitInstance: number;
        readonly unitFrame: number;
        readonly unitFrameCount: number;
        readonly type: "key" | "delta";
        readonly timestamp: number;
        readonly duration: number;
        readonly data: ArrayBuffer;
      }[];
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "abort-generation";
      readonly requestId: number;
      readonly generation: number;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "release-frame";
      readonly frameId: number;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "snapshot" | "dispose";
      readonly requestId: number;
    };

type WorkerToMainV01 =
  | {
      readonly protocolVersion: 1;
      readonly type: "ack";
      readonly requestId: number;
      readonly operation:
        | "configure"
        | "activate-generation"
        | "submit"
        | "abort-generation";
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "frame";
      readonly frameId: number;
      readonly generation: number;
      readonly ordinal: number;
      readonly unitId: Id;
      readonly unitInstance: number;
      readonly unitFrame: number;
      readonly timestamp: number;
      readonly duration: number;
      readonly decodedBytes: number;
      readonly frame: VideoFrame;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "snapshot";
      readonly requestId: number;
      readonly metrics: DecoderWorkerMetricsV01;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "error";
      readonly requestId: number | null;
      readonly code: WorkerDecoderErrorCode;
      readonly message: string;
      readonly fatal: boolean;
    }
  | {
      readonly protocolVersion: 1;
      readonly type: "disposed";
      readonly requestId: number;
    };

interface ExpectedVideoColorSpaceV01 {
  readonly fullRange: boolean | null;
  readonly matrix: VideoMatrixCoefficients | null;
  readonly primaries: VideoColorPrimaries | null;
  readonly transfer: VideoTransferCharacteristics | null;
}

interface DecoderWorkerMetricsV01 {
  readonly configureCalls: number;
  readonly resetCalls: 0;
  readonly flushCalls: 0;
  readonly boundaryFlushCalls: 0;
  readonly acceptedSamples: number;
  readonly submittedChunks: number;
  readonly outputFrames: number;
  readonly deliveredFrames: number;
  readonly releasedFrames: number;
  readonly staleFrames: number;
  readonly closedFrames: number;
  readonly pendingSamples: number;
  readonly submittedFrames: number;
  readonly leasedFrames: number;
  readonly leasedDecodedBytes: number;
  readonly decodeQueueSize: number;
  readonly activeGeneration: number | null;
  readonly nextSubmissionOrdinal: number;
  readonly nextOutputOrdinal: number;
  readonly errors: number;
  readonly disposed: boolean;
}
```

Every sample `ArrayBuffer` and output `VideoFrame` uses a transfer list. Before
transferring a batch, the client calculates available credit as the configured
outstanding limit minus accepted pending samples, submitted decoder work, and
unreleased frame leases. A batch larger than pending, sample-byte, or
outstanding credit is rejected before transfer. The worker separately enforces
`maxPendingSamples`, `maxDecodeQueueSize`, `maxOutstandingFrames`, M4's 2 MiB
per-sample limit, and `maxDecodedBytes`; `decodeQueueSize` alone is never a
readiness signal.

The hard maxima are 12 decoder-queued chunks, 24 pending samples, 12 combined
submitted/output leases, and 64 MiB decoded leases. Default M5 harness limits
are 8, 12, 12, and the lower of 64 MiB or twelve decoded surfaces. Each field
is a positive safe integer and caller values may only lower its hard maximum.

Each delivered frame consumes one lease until the main-thread managed handle
first closes the transferred `VideoFrame` and then sends `release-frame`.
Double release, unknown frame ID, or release before ownership is a fatal
protocol error. This explicit handshake prevents a fast decoder and slow
renderer from bypassing the decoded-memory budget.

`generation` is only a monotonically increasing stale-output and lifecycle
ownership token. The worker does not decide when a generation changes or what
media path it represents. M5.5's scheduler will own those decisions. On
`activate-generation`, pending older work is retired; unavoidable outputs from
already submitted older chunks are validated and immediately closed. The
client closes every still-owned older-generation managed frame. On
`abort-generation`, the active generation stops accepting work and receives
the same retirement behavior. Neither operation calls configure, reset, flush,
or closes the decoder.

### 15.3 Session state and output validation

`configure` first calls `VideoDecoder.isConfigSupported()` inside the worker
using Annex B configuration with no AVC `description`. It creates one decoder
only after exact support is returned. The codec must be `avc1.42E020`, config
geometry, AVC profile, and expected output must agree; `cpbBufferBits` must
equal peak bitrate; and configured limits may only lower hard worker maxima.
Repeated configure, generation operations before configure, nonincreasing
generations, nonmonotonic request/sample ordinals or timestamps, and messages
after dispose are rejected.

Within a submit batch and across batches, `(generation, unitInstance)` defines
one contiguous unit occurrence. Its first sample must have `unitFrame = 0` and
type `key`; IDs/counts remain constant; local frames advance without gaps to
`unitFrameCount - 1`. Repeating a loop uses a new `unitInstance`. Before each
`EncodedVideoChunk`, the shared format AVC inspector verifies the access-unit
grammar, key status, SPS/PPS/profile on frame zero, sequential frame number,
and complete unit independence. The chunk type comes from the derived
inspection result, not solely from the message assertion. Timestamp and
duration are nonnegative/positive safe microsecond integers assigned by the
caller and timestamps must be strictly increasing over the decoder session.

Because B frames are prohibited, outputs must match the expected FIFO exactly.
Chromium may expose a decoder-owned coded allocation larger than the SPS
geometry (the reviewed browser returned `32x34` for exact `32x32` content).
Therefore coded allocation is not treated as display geometry. Each coded
dimension must contain the exact visible rectangle and must not exceed
`ceil(expected / 16) * 16 + 16`. Display dimensions and the visible rectangle
remain exact. Frame credit and compiler resource estimates charge the actual
coded allocation, while manifest `decodedPixelBytes` reserves the full bounded
allocation above so a supported decoder cannot exceed the declared budget.

For each `VideoFrame`, the worker checks:

- expected timestamp, duration, ordinal, generation, unit instance, and frame;
- bounded coded allocation, exact display dimensions, and the exact in-bounds
  visible rectangle;
- noncontradictory BT.709 limited-range color metadata;
- per-unit and cumulative output counts and checked decoded-byte estimates; and
- no delivery after fatal failure or disposal.

Unexpected output is closed immediately and fails the session. A valid frame
is transferred to the main thread and registered as a lease. The client owns
closing the transferred frame; the worker owns the lease bookkeeping until
release. If `postMessage` fails, the worker closes the frame and removes the
lease itself.

`snapshot` exposes immutable counters for configure/reset/flush/boundary-flush,
accepted/submitted/output/delivered/released/stale/closed frames, pending and
submitted work, active generation, outstanding leases/bytes, decoder queue,
ordinals, errors, and disposal. It is diagnostic evidence, not scheduling
input. Reset and every flush counter remain exactly zero in M5. `dispose` is
idempotent, closes the decoder without flushing, retires all bookkeeping,
causes the client to close its managed frames, and terminates the real worker
after the disposal acknowledgement or a bounded transport timeout. Client
waits use a two-second default watchdog and abort signal; timing out a wait
does not masquerade as decode readiness.

Stable codes include `PROTOCOL_ERROR`, `NOT_CONFIGURED`, `ALREADY_CONFIGURED`,
`GENERATION_MISMATCH`, `BACKPRESSURE_LIMIT`, `DECODER_CONFIGURE_FAILED`,
`DECODER_SUBMIT_FAILED`, `DECODER_OUTPUT_INVALID`,
`DECODED_BYTE_BUDGET_EXCEEDED`, `FRAME_RELEASE_INVALID`, `TRANSPORT_FAILED`,
and `DISPOSED`.

## 16. Failure and Cleanup Semantics

Compiler stages return immutable `CompilerError` values with stable codes.
Unknown thrown values are converted at the adapter boundary. Cancellation is
checked before and after every awaited filesystem, hash, probe, decode,
encode, inspection, write, and publication step.

On compiler failure:

- the active process group is terminated;
- stdin/stdout/stderr streams and file handles are closed;
- no incomplete asset is renamed into place;
- temporary raw frames, H.264, PNG, and report files are removed without
  following symlinks; and
- errors expose project-relative context, never secret environment values or
  unsanitized FFmpeg output.

On worker failure:

- the decoder is closed exactly once;
- pending protocol promises reject with the same stable fatal error;
- any worker-owned `VideoFrame` is closed;
- transferred frames already delivered remain the client's ownership; and
- later calls fail synchronously as disposed/fatal rather than retaining work.

## 17. Verification and Evidence Gate

M5 is complete only when all of the following pass.

### 17.1 Pure unit and hostile tests

- closed project schema, duplicate/dangerous JSON keys, canonical normalization,
  M4 maxima, source relations, ranges, and derived fields;
- exact rational CFR/VFR detection and every normalization tie/boundary;
- path traversal, symlink escape, devices/pipes, URL/protocol, demuxer, output
  symlink, temp cleanup, cancellation, timeout, and output-cap tests;
- exact FFmpeg/FFprobe argv and environment snapshots with hostile path and
  metadata strings, proving `shell: false` and no option injection;
- RGBA spool bounds, short/extra frames, opaque alpha coordinates, and scale
  preflight;
- Annex B start-code/RBSP/SPS/PPS/slice golden tests plus truncation at every
  byte/bit boundary;
- false key flags, missing/repeated parameter sets, B frames, multiple slices,
  cross-unit references, hostile SPS dimensions, oversized NALs, and seeded
  mutation fuzzing with no built-in exception leakage;
- deterministic PNG chunks, CRC/Adler values, stored-block boundaries, shared
  poster deduplication, and static-size caps;
- linear-light loop/edge continuity metrics, duplicate boundaries, short
  neighbor windows, cut classification, and traversal-order determinism;
- SHA-256 scope tests proving padding is excluded from unit digests and included
  bytes are exactly the final payloads; and
- worker protocol state-machine tests with a fake decoder, generation
  retirement, credit/release races, unexpected outputs, transfer failure,
  watchdog, and idempotent dispose.

### 17.2 Tool-backed compiler tests

With a recorded compatible user-installed FFmpeg/FFprobe pair:

- compile one PNG-sequence loop, one CFR video loop with intro, one explicitly
  normalized VFR source, and one multi-state graph containing locked,
  reversible, finish, portal, and cut metadata;
- inspect every resulting unit and validate every internal digest;
- require deterministic loop and composed-edge continuity reports from the
  pre-encode RGBA frames, rejecting every non-cut heuristic failure without
  rewriting source frames;
- compile each golden twice, reorder the editable project, move it to a new
  temporary root, and require byte-identical asset output;
- reject a translucent PNG, an inserted B-frame stream, an extra IDR, a changed
  SPS, an over-budget output, and a killed FFmpeg process;
- unpack and reconstruct every unit/static payload byte-for-byte; and
- record executable hashes/version/configuration with fixture SHA-256 values.

Tool-backed tests may skip in an ordinary contributor run only with an explicit
`ffmpeg: unavailable` result. The M5 evidence document and milestone commit
cannot pass on mocks alone; they require one recorded compatible real-tool run.

### 17.3 Browser worker tests

In a browser where exact `VideoDecoder.isConfigSupported()` succeeds:

- configure inside a real dedicated worker;
- decode a two-frame compiled loop for 1,001 iterations with monotonically
  increasing virtual timestamps and exact output ordering;
- prove zero boundary-time or terminal configure, reset, flush, seek, and
  end-of-stream operations;
- decode intro → body iterations → bridge → target body in one decoder;
- repeat a compiled reversible unit as an ordinary forward stream to prove its
  independent start; reversal presentation itself remains M5.5;
- validate dimensions, visible rectangle, timestamps, color metadata, output
  counts, credit bounds, `VideoFrame` transfer, and closure ownership; and
- exercise unsupported configuration, malformed sample, worker crash,
  watchdog, cancellation, and disposal.

If the repository's bundled Chromium lacks exact H.264 decode support, its
test records `avcWorker: "unsupported"`; it does not substitute VP8 and does
not claim M5 AVC conformance. The evidence gate additionally requires a run in
a supported browser and records browser, OS, architecture, codec support
result, and fixture digest.

### 17.4 Repository gate

Run:

```text
npm run typecheck
npm run test:unit
npm run build
npm run test:browser
npm audit --audit-level=high
npm pack --dry-run -w @rendered-motion/format
npm pack --dry-run -w @rendered-motion/compiler
git diff --check
```

Then perform a read-only contract and maintainability audit. The audit must
confirm one AVC parser, one project normalizer, one FFmpeg argv owner, one
poster encoder, one digest owner, and no scheduler logic in the worker.

Record `docs/evidence/2026-07-11-m5-opaque-avc-compiler-worker.md` with exact
test counts, tool/browser provenance, golden asset digests, H.264 support
result, cleanup/resource results, and the claim boundary.

## 18. Commit and Claim Boundary

The design and plan are one documentation commit after review. Runtime work is
one M5 implementation commit only after the complete evidence gate passes.
Generated `dist`, temporary media, local tool binaries, and machine-specific
ad-hoc reports are never committed. Only small reviewed source inputs,
compiled conformance fixtures, normalized provenance records, and their
documented hashes enter the repository.

M5 proves deterministic local opaque AVC compilation, compiler-generated
static representations and hashes, frozen-profile Annex B independence, and
dedicated-worker sequential decode on a supported browser. It does not claim:

- packed alpha or alpha compositing;
- independent full runtime PNG validation;
- runtime/network digest enforcement or publisher authenticity;
- graph-to-decoder scheduling, portal latency, readiness, static recovery, or
  active reversal behavior;
- polished authoring, continuity heatmaps, framework integrations, or a public
  product/extension name; or
- certification across untested browsers, devices, power states, or hardware
  decoders.

Those claims remain in M5.5 through M9.
