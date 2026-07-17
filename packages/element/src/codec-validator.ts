/** Runtime-only profile facts needed to validate one independently decodable unit. */
export interface CodecValidationProfile {
  readonly codec: string;
  readonly bitDepth: 8 | 10;
  readonly codedWidth: number;
  readonly codedHeight: number;
  readonly visibleWidth: number;
  readonly visibleHeight: number;
  readonly frameRate: Readonly<{
    readonly numerator: number;
    readonly denominator: number;
  }>;
  readonly averageBitrate: number;
}

/** A verified container chunk and the metadata asserted by its index record. */
export interface CodecValidationChunk {
  readonly bytes: Uint8Array;
  readonly timestamp: number;
  readonly key: boolean;
  readonly displayedFrames: number;
}

export interface CodecValidator {
  /** Validates the next independently decodable unit in rendition order. */
  validate(chunks: readonly Readonly<CodecValidationChunk>[]): void;
  /** Completes rendition-global checks after every independently decodable unit. */
  complete(): void;
}

type Family = "h264" | "h265" | "vp9" | "av1";

type Nal = {
  start: number;
  end: number;
  type: number;
  reference: number;
  temporal: number;
};

type Obu = { start: number; end: number; type: number };

const H264_CODEC = /^avc1\.6400(?:0A|0B|0C|0D|14|15|16|1E|1F|20|28|29|2A|32|33|34|3C|3D|3E)$/;
const H265_CODEC = /^hvc1\.1\.(0|[1-9A-F][0-9A-F]*)\.[LH](0|[1-9][0-9]*)\.((?:[0-9A-F]{2}\.){0,5}(?!00)[0-9A-F]{2})$/;
const VP9_CODEC = /^vp09\.00\.(10|11|20|21|30|31|40|41|50|51|52|60|61|62)\.08(?:\.01\.01\.01\.01\.00)?$/;
const AV1_CODEC = /^av01\.0\.(?:0[0-9]|[12][0-9]|3[01])[MH]\.(08|10)(?:\.0\.11[0-3]\.01\.01\.01\.0)?$/;

function bad(): never {
  throw new Error("Invalid AVAL encoded payload");
}

function need(value: unknown): asserts value {
  if (!value) bad();
}

function positive(value: unknown): asserts value is number {
  need(typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

/**
 * Validates an independently decodable unit before its chunks cross the
 * WebCodecs boundary. The function returns no parsed model and retains no
 * caller-owned byte view.
 */
export function validateCodecPayload(
  profile: Readonly<CodecValidationProfile>,
  chunks: readonly Readonly<CodecValidationChunk>[]
): void {
  validateUnit(profile, chunks);
}

/** Creates the rendition-scoped validator used by lazy/range loading. */
export function createCodecValidator(
  profile: Readonly<CodecValidationProfile>
): CodecValidator {
  const family = validateProfile(profile);
  const owned = Object.freeze({
    codec: profile.codec,
    bitDepth: profile.bitDepth,
    codedWidth: profile.codedWidth,
    codedHeight: profile.codedHeight,
    visibleWidth: profile.visibleWidth,
    visibleHeight: profile.visibleHeight,
    frameRate: Object.freeze({
      numerator: profile.frameRate.numerator,
      denominator: profile.frameRate.denominator
    }),
    averageBitrate: profile.averageBitrate
  });
  let state: ValidationState | undefined;
  let completed = false;
  return Object.freeze({
    validate(chunks: readonly Readonly<CodecValidationChunk>[]): void {
      need(!completed);
      state = validateUnit(owned, chunks, family, state);
    },
    complete(): void {
      if (completed) return;
      need(state !== undefined);
      if (family === "vp9") completeVp9(owned, state.vp9);
      completed = true;
    }
  });
}

type ValidationState = {
  readonly fingerprint?: string;
  readonly av1?: Av1Sequence;
  readonly vp9?: number;
};

function validateUnit(
  profile: Readonly<CodecValidationProfile>,
  chunks: readonly Readonly<CodecValidationChunk>[],
  knownFamily?: Family,
  previous?: Readonly<ValidationState>
): ValidationState {
  const family = validateInputs(profile, chunks, knownFamily);
  switch (family) {
    case "h264": return { fingerprint: validateH264(profile, chunks, previous?.fingerprint) };
    case "h265": return { fingerprint: validateH265(profile, chunks, previous?.fingerprint) };
    case "vp9": return {
      vp9: Math.max(previous?.vp9 ?? 1, validateVp9(profile, chunks))
    };
    case "av1": return { av1: validateAv1(profile, chunks, previous?.av1) };
  }
}

function validateInputs(
  profile: Readonly<CodecValidationProfile>,
  chunks: readonly Readonly<CodecValidationChunk>[],
  knownFamily?: Family
): Family {
  const family = knownFamily ?? validateProfile(profile);
  validateChunks(chunks, family);
  return family;
}

function validateProfile(profile: Readonly<CodecValidationProfile>): Family {
  need(profile !== null && typeof profile === "object");
  positive(profile.codedWidth);
  positive(profile.codedHeight);
  positive(profile.visibleWidth);
  positive(profile.visibleHeight);
  need(profile.visibleWidth <= profile.codedWidth && profile.visibleHeight <= profile.codedHeight);
  positive(profile.frameRate?.numerator);
  positive(profile.frameRate?.denominator);
  positive(profile.averageBitrate);
  need(profile.bitDepth === 8 || profile.bitDepth === 10);
  need(profile.frameRate.denominator <= 1001 && profile.frameRate.numerator <= profile.frameRate.denominator * 60);
  need(profile.codedWidth % 2 === 0 && profile.codedHeight % 2 === 0);
  need(profile.visibleWidth % 2 === 0 && profile.visibleHeight % 2 === 0);
  if (H264_CODEC.test(profile.codec)) {
    need(profile.bitDepth === 8);
    return "h264";
  }
  const h265 = H265_CODEC.exec(profile.codec);
  if (h265 !== null) {
    const compatibility = Number.parseInt(h265[1]!, 16);
    const level = Number(h265[2]);
    const constraint = Number.parseInt(h265[3]!.slice(0, 2), 16);
    need(
      profile.bitDepth === 8 && compatibility <= 0xffff_ffff &&
      (compatibility & 2) !== 0 && level > 0 && level <= 255 &&
      (constraint & 0x80) !== 0 && (constraint & 0x40) === 0 &&
      (constraint & 0x10) !== 0
    );
    return "h265";
  }
  if (VP9_CODEC.test(profile.codec)) {
    need(profile.bitDepth === 8);
    return "vp9";
  }
  const av1 = AV1_CODEC.exec(profile.codec);
  if (av1 !== null) {
    need(profile.bitDepth === (av1[1] === "10" ? 10 : 8));
    return "av1";
  }
  return bad();
}

const H265_MAX_ACCESS_UNIT_BYTES = 64 * 1024 * 1024;

function validateChunks(
  chunks: readonly Readonly<CodecValidationChunk>[],
  family: Family
): void {
  need(Array.isArray(chunks) && chunks.length > 0 && chunks.length <= 1_000_000);
  for (const chunk of chunks) {
    need(chunk !== null && typeof chunk === "object" && chunk.bytes instanceof Uint8Array);
    need(chunk.bytes.byteLength > 0 && chunk.bytes.byteLength <= Number.MAX_SAFE_INTEGER);
    if (family === "h265") need(chunk.bytes.byteLength <= H265_MAX_ACCESS_UNIT_BYTES);
    need(Number.isSafeInteger(chunk.timestamp) && chunk.timestamp >= 0);
    need(typeof chunk.key === "boolean");
    need(Number.isSafeInteger(chunk.displayedFrames) && chunk.displayedFrames >= 0);
  }
}

/** Sequential MSB reader. EBSP mode removes already-validated prevention bytes. */
class Bits {
  readonly bytes: Uint8Array;
  readonly end: number;
  readonly escaped: boolean;
  readonly total: number;
  raw: number;
  offset = 0;
  mask = 0;
  byte = 0;
  zeros = 0;

  constructor(bytes: Uint8Array, start: number, end: number, escaped = false) {
    this.bytes = bytes;
    this.raw = start;
    this.end = end;
    this.escaped = escaped;
    this.total = (escaped ? validateEbsp(bytes, start, end) : end - start) * 8;
  }

  get remaining(): number { return this.total - this.offset; }

  bit(): boolean {
    need(this.offset < this.total);
    if (this.mask === 0) {
      let value = this.bytes[this.raw++];
      need(value !== undefined);
      if (this.escaped && this.zeros === 2 && value === 3) {
        value = this.bytes[this.raw++];
        need(value !== undefined);
        this.zeros = 0;
      }
      this.zeros = value === 0 ? this.zeros + 1 : 0;
      this.byte = value;
      this.mask = 0x80;
    }
    const value = (this.byte & this.mask) !== 0;
    this.mask >>= 1;
    this.offset += 1;
    return value;
  }

  bits(width: number): number {
    need(Number.isInteger(width) && width >= 0 && width <= 32 && this.remaining >= width);
    let value = 0;
    for (let index = 0; index < width; index += 1) value = value * 2 + Number(this.bit());
    return value;
  }

  ue(maximum = 0xffff_ffff): number {
    let zeros = 0;
    while (!this.bit()) {
      zeros += 1;
      need(zeros <= 31);
    }
    const value = 2 ** zeros - 1 + this.bits(zeros);
    need(Number.isSafeInteger(value) && value <= maximum);
    return value;
  }

  se(minimum = -0x7fff_ffff, maximum = 0x7fff_ffff): number {
    const code = this.ue();
    const magnitude = Math.ceil(code / 2);
    const value = code % 2 === 0 ? -magnitude : magnitude;
    need(value >= minimum && value <= maximum);
    return value;
  }

  more(): boolean {
    if (this.remaining === 0) return false;
    const state = [this.raw, this.offset, this.mask, this.byte, this.zeros];
    let data = !this.bit();
    while (!data && this.remaining > 0) data = this.bit();
    [this.raw, this.offset, this.mask, this.byte, this.zeros] = state as [number, number, number, number, number];
    return data;
  }

  trailing(): void {
    need(this.bit());
    while (this.remaining > 0) need(!this.bit());
  }
}

function validateEbsp(bytes: Uint8Array, start: number, end: number): number {
  need(start < end);
  let zeros = 0;
  let length = end - start;
  for (let index = start; index < end; index += 1) {
    const value = bytes[index]!;
    if (zeros === 2) {
      if (value === 3) {
        need(index + 1 < end && bytes[index + 1]! <= 3);
        zeros = 0;
        length -= 1;
        continue;
      }
      need(value > 2);
    }
    zeros = value === 0 ? zeros + 1 : 0;
  }
  return length;
}

function readNal(bytes: Uint8Array, offset: number, hevc: boolean, output: Nal): number {
  need(
    offset + 4 < bytes.length && bytes[offset] === 0 && bytes[offset + 1] === 0 &&
    bytes[offset + 2] === 0 && bytes[offset + 3] === 1
  );
  const payload = offset + 4;
  const headerBytes = hevc ? 2 : 1;
  need(payload + headerBytes < bytes.length);
  let end = bytes.length;
  for (let index = payload + headerBytes; index < bytes.length;) {
    if (bytes[index] !== 0) { index += 1; continue; }
    const run = index;
    while (index < bytes.length && bytes[index] === 0) index += 1;
    if (bytes[index] === 1 && index - run >= 2) {
      need(index - run === 3);
      end = run;
      break;
    }
  }
  need(end >= payload + headerBytes + 1 && bytes[end - 1] !== 0);
  const first = bytes[payload]!;
  need((first & 0x80) === 0);
  if (hevc) {
    const second = bytes[payload + 1]!;
    const layer = ((first & 1) << 5) | (second >> 3);
    const temporal = second & 7;
    need(layer === 0 && temporal !== 0);
    output.type = (first >> 1) & 0x3f;
    output.reference = 0;
    output.temporal = temporal - 1;
  } else {
    output.type = first & 0x1f;
    output.reference = (first >> 5) & 3;
    output.temporal = 0;
  }
  output.start = payload + headerBytes;
  output.end = end;
  validateEbsp(bytes, output.start, end);
  return end;
}

function comparePresentation(pocs: readonly number[], timestamps: readonly number[], maximumReorder: number, contiguous: boolean): void {
  const byPoc = pocs.map((_, index) => index).sort((left, right) => pocs[left]! - pocs[right]!);
  const byTime = timestamps.map((_, index) => index).sort(
    (left, right) => timestamps[left]! - timestamps[right]! || left - right
  );
  need(byPoc.length > 0 && byPoc.every((decode, index) => decode === byTime[index]));
  const first = pocs[byPoc[0]!]!;
  let reorder = 0;
  for (let index = 0; index < byPoc.length; index += 1) {
    const decode = byPoc[index]!;
    need(index === 0 || pocs[decode]! > pocs[byPoc[index - 1]!]!);
    if (contiguous) need(pocs[decode] === first + index);
    reorder = Math.max(reorder, decode - index);
  }
  need(reorder <= maximumReorder);
}

const VP9_LEVELS = [
  ["10", 829440, 36864, 200000, 512], ["11", 2764800, 73728, 800000, 768],
  ["20", 4608000, 122880, 1800000, 960], ["21", 9216000, 245760, 3600000, 1344],
  ["30", 20736000, 552960, 7200000, 2048], ["31", 36864000, 983040, 12000000, 2752],
  ["40", 83558400, 2228224, 18000000, 4160], ["41", 160432128, 2228224, 30000000, 4160],
  ["50", 311951360, 8912896, 60000000, 8384], ["51", 588251136, 8912896, 120000000, 8384],
  ["52", 1176502272, 8912896, 180000000, 8384], ["60", 1176502272, 35651584, 180000000, 16832],
  ["61", 2353004544, 35651584, 240000000, 16832], ["62", 4706009088, 35651584, 480000000, 16832]
] as const;

function validateVp9(
  profile: Readonly<CodecValidationProfile>,
  chunks: readonly Readonly<CodecValidationChunk>[]
): number {
  let coded = 0;
  let displayed = 0;
  for (let packetIndex = 0; packetIndex < chunks.length; packetIndex += 1) {
    const packet = chunks[packetIndex]!;
    const bytes = packet.bytes;
    const marker = bytes[bytes.length - 1]!;
    const superframe = (marker & 0xe0) === 0xc0;
    const count = superframe ? (marker & 7) + 1 : 1;
    const sizes: number[] = [];
    if (superframe) {
      const magnitude = ((marker >> 3) & 3) + 1;
      const indexBytes = 2 + count * magnitude;
      need(bytes.length > indexBytes);
      const indexStart = bytes.length - indexBytes;
      need(bytes[indexStart] === marker);
      let cursor = indexStart + 1;
      let total = 0;
      for (let frame = 0; frame < count; frame += 1) {
        let size = 0;
        let multiplier = 1;
        for (let index = 0; index < magnitude; index += 1) {
          size += bytes[cursor++]! * multiplier;
          multiplier *= 256;
        }
        need(size > 0 && Number.isSafeInteger(total + size));
        total += size;
        sizes.push(size);
      }
      need(total === indexStart);
    } else {
      sizes.push(bytes.length);
    }
    let offset = 0;
    let packetDisplayed = 0;
    let firstKey = false;
    for (let frame = 0; frame < sizes.length; frame += 1) {
      const flags = readVp9Frame(bytes, offset, offset + sizes[frame]!, profile);
      if (frame === 0) firstKey = (flags & 1) !== 0;
      packetDisplayed += (flags >> 1) & 1;
      offset += sizes[frame]!;
      coded += 1;
    }
    need(packetIndex !== 0 || firstKey);
    need(packet.key === firstKey && packet.displayedFrames === packetDisplayed);
    displayed += packetDisplayed;
  }
  need(displayed > 0);
  const picture = profile.codedWidth * profile.codedHeight;
  const rate = picture * profile.frameRate.numerator / profile.frameRate.denominator * coded / displayed;
  const level = VP9_LEVELS.find((row) => row[0] === profile.codec.slice(8, 10));
  need(
    level !== undefined && picture <= level[2] && rate <= level[1] &&
    profile.averageBitrate <= level[3] && profile.codedWidth <= level[4] &&
    profile.codedHeight <= level[4]
  );
  return coded / displayed;
}

function completeVp9(
  profile: Readonly<CodecValidationProfile>,
  maximumCodedFramesPerDisplayedFrame: number | undefined
): void {
  need(maximumCodedFramesPerDisplayedFrame !== undefined);
  const picture = profile.codedWidth * profile.codedHeight;
  const rate = picture * profile.frameRate.numerator / profile.frameRate.denominator *
    maximumCodedFramesPerDisplayedFrame;
  const level = VP9_LEVELS.find((row) =>
    picture <= row[2] && rate <= row[1] && profile.averageBitrate <= row[3] &&
    profile.codedWidth <= row[4] && profile.codedHeight <= row[4]
  );
  need(
    level !== undefined &&
    profile.codec === `vp09.00.${level[0]}.08.01.01.01.01.00`
  );
}

/** bit 0: key; bit 1: displayed. */
function readVp9Frame(
  bytes: Uint8Array,
  start: number,
  end: number,
  profile: Readonly<CodecValidationProfile>
): number {
  need(start < end);
  const reader = new Bits(bytes, start, end);
  need(reader.bits(2) === 2);
  const vp = Number(reader.bit()) | Number(reader.bit()) << 1;
  if (vp === 3) need(!reader.bit());
  need(vp === 0);
  if (reader.bit()) {
    reader.bits(3);
    return 2;
  }
  const key = !reader.bit();
  const shown = reader.bit();
  reader.bit();
  if (!key) return shown ? 2 : 0;
  need(reader.bits(24) === 0x49_83_42 && reader.bits(3) === 2 && !reader.bit());
  const width = reader.bits(16) + 1;
  const height = reader.bits(16) + 1;
  let renderWidth = width;
  let renderHeight = height;
  if (reader.bit()) {
    renderWidth = reader.bits(16) + 1;
    renderHeight = reader.bits(16) + 1;
  }
  need(
    width === profile.codedWidth && height === profile.codedHeight &&
    renderWidth === profile.visibleWidth && renderHeight === profile.visibleHeight
  );
  return 1 | (shown ? 2 : 0);
}

type Av1Sequence = {
  level: number;
  highTier: boolean;
  bitDepth: 8 | 10;
  width: number;
  height: number;
  chroma: number;
  reduced: boolean;
  frameIds: boolean;
  filmGrain: boolean;
};

function validateAv1(
  profile: Readonly<CodecValidationProfile>,
  chunks: readonly Readonly<CodecValidationChunk>[],
  previous?: Readonly<Av1Sequence>
): Av1Sequence {
  let sequence: Av1Sequence | undefined = previous === undefined ? undefined : { ...previous };
  const obu: Obu = { start: 0, end: 0, type: 0 };
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex]!;
    let cursor = 0;
    while (cursor < chunk.bytes.length) {
      cursor = readObu(chunk.bytes, cursor, obu);
      if (obu.type !== 1) continue;
      const parsed = readAv1Sequence(chunk.bytes, obu.start, obu.end);
      validateAv1Sequence(parsed, profile);
      if (sequence === undefined) sequence = parsed;
      else need(sameAv1Sequence(sequence, parsed));
    }
    need(sequence !== undefined);
    cursor = 0;
    let frames = 0;
    let displayed = 0;
    let key = false;
    let first = 0;
    while (cursor < chunk.bytes.length) {
      cursor = readObu(chunk.bytes, cursor, obu);
      if (obu.type !== 3 && obu.type !== 6) continue;
      const flags = readAv1Frame(chunk.bytes, obu.start, obu.end, sequence);
      if (frames++ === 0) first = flags;
      key ||= (flags & 1) !== 0;
      displayed += (flags >> 2) & 1;
    }
    need(frames > 0 && (chunkIndex !== 0 || (first & 2) !== 0));
    need(chunk.key === key && chunk.displayedFrames === displayed);
  }
  need(sequence !== undefined);
  return sequence;
}

function readObu(bytes: Uint8Array, offset: number, output: Obu): number {
  const header = bytes[offset++];
  need(header !== undefined && (header & 0x80) === 0 && (header & 1) === 0 && (header & 2) !== 0);
  const type = (header >> 3) & 15;
  need((type >= 1 && type <= 7) || type === 15);
  if ((header & 4) !== 0) {
    const extension = bytes[offset++];
    need(extension !== undefined && (extension & 7) === 0 && extension >> 3 === 0);
  }
  let size = 0;
  let multiplier = 1;
  let length = 0;
  for (; length < 8; length += 1) {
    const value = bytes[offset + length];
    need(value !== undefined);
    size += (value & 0x7f) * multiplier;
    need(Number.isSafeInteger(size));
    if ((value & 0x80) === 0) break;
    multiplier *= 128;
    need(Number.isSafeInteger(multiplier));
  }
  need(length < 8);
  const encoded = length + 1;
  need(encoded === 1 || size >= 2 ** ((encoded - 1) * 7));
  const start = offset + encoded;
  const end = start + size;
  need(end <= bytes.length);
  if (type === 2) need(size === 0);
  output.type = type;
  output.start = start;
  output.end = end;
  return end;
}

function readAv1Sequence(bytes: Uint8Array, start: number, end: number): Av1Sequence {
  need(start < end);
  const reader = new Bits(bytes, start, end);
  need(reader.bits(3) === 0);
  const still = reader.bit();
  const reduced = reader.bit();
  need(!reduced || still);
  let level: number;
  let highTier = false;
  if (reduced) level = reader.bits(5);
  else {
    need(!reader.bit());
    const initialDelay = reader.bit();
    need(reader.bits(5) === 0 && reader.bits(12) === 0);
    level = reader.bits(5);
    if (level > 7) highTier = reader.bit();
    if (initialDelay && reader.bit()) reader.bits(4);
  }
  const widthBits = reader.bits(4) + 1;
  const heightBits = reader.bits(4) + 1;
  const width = reader.bits(widthBits) + 1;
  const height = reader.bits(heightBits) + 1;
  let frameIds = false;
  if (!reduced) {
    frameIds = reader.bit();
    if (frameIds) { reader.bits(4); reader.bits(3); }
  }
  reader.bit(); reader.bit(); reader.bit();
  if (!reduced) {
    reader.bit(); reader.bit(); reader.bit(); reader.bit();
    const orderHint = reader.bit();
    if (orderHint) { reader.bit(); reader.bit(); }
    const chooseTools = reader.bit();
    const tools = chooseTools ? 2 : Number(reader.bit());
    if (tools > 0 && !reader.bit()) reader.bit();
    if (orderHint) reader.bits(3);
  }
  reader.bit(); reader.bit(); reader.bit();
  const bitDepth = reader.bit() ? 10 : 8;
  need(!reader.bit() && reader.bit());
  need(reader.bits(8) === 1 && reader.bits(8) === 1 && reader.bits(8) === 1);
  need(!reader.bit());
  const chroma = reader.bits(2);
  reader.bit();
  const filmGrain = reader.bit();
  reader.trailing();
  return { level, highTier, bitDepth, width, height, chroma, reduced, frameIds, filmGrain };
}

function validateAv1Sequence(
  sequence: Readonly<Av1Sequence>,
  profile: Readonly<CodecValidationProfile>
): void {
  need(
    sequence.width === profile.codedWidth && sequence.height === profile.codedHeight &&
    sequence.bitDepth === profile.bitDepth
  );
  const extended = `av01.0.${String(sequence.level).padStart(2, "0")}${sequence.highTier ? "H" : "M"}.${
    String(sequence.bitDepth).padStart(2, "0")
  }.0.11${String(sequence.chroma)}.01.01.01.0`;
  need(profile.codec === extended);
}

function sameAv1Sequence(left: Readonly<Av1Sequence>, right: Readonly<Av1Sequence>): boolean {
  return left.level === right.level && left.highTier === right.highTier &&
    left.bitDepth === right.bitDepth && left.width === right.width &&
    left.height === right.height && left.chroma === right.chroma &&
    left.reduced === right.reduced && left.frameIds === right.frameIds &&
    left.filmGrain === right.filmGrain;
}

/** bit 0: key; bit 1: random access; bit 2: displayed. */
function readAv1Frame(bytes: Uint8Array, start: number, end: number, sequence: Readonly<Av1Sequence>): number {
  need(start < end);
  if (sequence.reduced) return 7;
  const reader = new Bits(bytes, start, end);
  if (reader.bit()) {
    reader.bits(3);
    return 4;
  }
  const type = reader.bits(2);
  const shown = reader.bit();
  if (!shown) reader.bit();
  return (type === 0 ? 1 : 0) | (type === 0 && shown ? 2 : 0) | (shown ? 4 : 0);
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const;

function rotate(value: number, width: number): number {
  return value >>> width | value << (32 - width);
}

/** Small synchronous SHA-256 used only for rendition parameter-set identity. */
function sha256(bytes: Uint8Array, start: number, end: number): string {
  need(start >= 0 && end > start && end <= bytes.length);
  const length = end - start;
  const padded = Math.ceil((length + 9) / 64) * 64;
  const words = new Uint32Array(64);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const bitLength = length * 8;
  for (let block = 0; block < padded; block += 64) {
    for (let word = 0; word < 16; word += 1) {
      let value = 0;
      for (let byte = 0; byte < 4; byte += 1) {
        const index = block + word * 4 + byte;
        let part = 0;
        if (index < length) part = bytes[start + index]!;
        else if (index === length) part = 0x80;
        else if (index >= padded - 4) part = bitLength >>> ((padded - 1 - index) * 8);
        value = value << 8 | part & 0xff;
      }
      words[word] = value >>> 0;
    }
    for (let word = 16; word < 64; word += 1) {
      const x = words[word - 15]!;
      const y = words[word - 2]!;
      const small0 = rotate(x, 7) ^ rotate(x, 18) ^ x >>> 3;
      const small1 = rotate(y, 17) ^ rotate(y, 19) ^ y >>> 10;
      words[word] = (words[word - 16]! + small0 + words[word - 7]! + small1) >>> 0;
    }
    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;
    for (let round = 0; round < 64; round += 1) {
      const big1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = e & f ^ ~e & g;
      const first = (h + big1 + choose + SHA256_K[round]! + words[round]!) >>> 0;
      const big0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = a & b ^ a & c ^ b & c;
      const second = (big0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }
  return [...hash].map((value) => value.toString(16).padStart(8, "0")).join("");
}

type H264 = {
  sps: number;
  level: number;
  frameBits: number;
  pocType: number;
  pocBits: number;
  deltaAlwaysZero: boolean;
  offsetNonReference: number;
  offsetTopBottom: number;
  cycle: number[];
  maxReferences: number;
  macroblocks: number;
  maxReorder: number;
  pps: number;
  entropy: boolean;
  refs0: number;
  refs1: number;
  weighted: boolean;
  weightedBi: number;
  initialQp: number;
  deblocking: boolean;
  previousReferenceFrame: number;
  previousReferenceOffset: number;
  previousPocMsb: number;
  previousPocLsb: number;
};

type H264Picture = {
  type: number;
  frame: number;
  reference: number;
  pocLsb: number;
  deltaBottom: number;
  delta0: number;
  delta1: number;
};

const H264_LEVELS = [
  [10, 1485, 99, 396], [11, 3000, 396, 900], [12, 6000, 396, 2376],
  [13, 11880, 396, 2376], [20, 11880, 396, 2376], [21, 19800, 792, 4752],
  [22, 20250, 1620, 8100], [30, 40500, 1620, 8100], [31, 108000, 3600, 18000],
  [32, 216000, 5120, 20480], [40, 245760, 8192, 32768], [41, 245760, 8192, 32768],
  [42, 522240, 8704, 34816], [50, 589824, 22080, 110400], [51, 983040, 36864, 184320],
  [52, 2073600, 36864, 184320], [60, 4177920, 139264, 696320],
  [61, 8355840, 139264, 696320], [62, 16711680, 139264, 696320]
] as const;

// H.264 and HEVC validators share the bounded readers above.
function validateH264(
  profile: Readonly<CodecValidationProfile>,
  chunks: readonly Readonly<CodecValidationChunk>[],
  previousFingerprint?: string
): string {
  const state: H264 = {
    sps: 0, level: 0, frameBits: 0, pocType: 0, pocBits: 0,
    deltaAlwaysZero: false, offsetNonReference: 0, offsetTopBottom: 0,
    cycle: [], maxReferences: 0, macroblocks: 0, maxReorder: 0,
    pps: 0, entropy: false, refs0: 0, refs1: 0, weighted: false,
    weightedBi: 0, initialQp: 0, deblocking: false,
    previousReferenceFrame: 0, previousReferenceOffset: 0,
    previousPocMsb: 0, previousPocLsb: 0
  };
  const picture: H264Picture = {
    type: 0, frame: 0, reference: 0, pocLsb: 0,
    deltaBottom: 0, delta0: 0, delta1: 0
  };
  const nal: Nal = { start: 0, end: 0, type: 0, reference: 0, temporal: 0 };
  const pocs: number[] = [];
  const times: number[] = [];
  const seenPocs = new Set<number>();
  let spsFingerprint = "";
  let ppsFingerprint = "";
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    let offset = 0;
    offset = readNal(chunk.bytes, offset, false, nal);
    need(Number(nal.type) === 9 && nal.reference === 0);
    const aud = readH264Aud(chunk.bytes, nal.start, nal.end);
    if (index === 0) {
      offset = readNal(chunk.bytes, offset, false, nal);
      need(Number(nal.type) === 7 && nal.reference !== 0);
      spsFingerprint = sha256(chunk.bytes, nal.start - 1, nal.end);
      readH264Sps(chunk.bytes, nal.start, nal.end, state, profile);
      offset = readNal(chunk.bytes, offset, false, nal);
      need(Number(nal.type) === 8 && nal.reference !== 0);
      ppsFingerprint = sha256(chunk.bytes, nal.start - 1, nal.end);
      readH264Pps(chunk.bytes, nal.start, nal.end, state);
      offset = readNal(chunk.bytes, offset, false, nal);
      need(Number(nal.type) === 5 && nal.reference !== 0 && offset === chunk.bytes.length && chunk.key);
    } else {
      offset = readNal(chunk.bytes, offset, false, nal);
      need(Number(nal.type) === 1 && offset === chunk.bytes.length && !chunk.key);
    }
    readH264Slice(chunk.bytes, nal.start, nal.end, nal.type === 5, nal.reference, state, picture);
    need(
      picture.type === (index === 0 ? 2 : picture.type) &&
      (index === 0 ? picture.type === 2 : picture.type === 0 || picture.type === 1) &&
      aud === (picture.type === 2 ? 0 : picture.type === 0 ? 1 : 2) &&
      chunk.displayedFrames === 1
    );
    const poc = h264Poc(picture, nal.type === 5, state);
    need(!seenPocs.has(poc));
    seenPocs.add(poc);
    pocs.push(poc);
    times.push(chunk.timestamp);
  }
  need(pocs[0] === 0);
  comparePresentation(pocs, times, state.maxReorder, false);
  const first = pocs.map((_, index) => index).sort((a, b) => pocs[a]! - pocs[b]!)[0];
  need(first === 0);
  const fingerprint = `${spsFingerprint}${ppsFingerprint}`;
  need(previousFingerprint === undefined || previousFingerprint === fingerprint);
  return fingerprint;
}

function readH264Aud(bytes: Uint8Array, start: number, end: number): number {
  const reader = new Bits(bytes, start, end, true);
  const type = reader.bits(3);
  need(type <= 2);
  reader.trailing();
  return type;
}

function readH264Sps(
  bytes: Uint8Array,
  start: number,
  end: number,
  state: H264,
  profile: Readonly<CodecValidationProfile>
): void {
  const reader = new Bits(bytes, start, end, true);
  need(reader.bits(8) === 100 && reader.bits(8) === 0);
  const level = reader.bits(8);
  const limits = H264_LEVELS.find((row) => row[0] === level);
  need(limits !== undefined && Number.parseInt(profile.codec.slice(-2), 16) === level);
  state.level = level;
  state.sps = reader.ue(31);
  need(reader.ue(3) === 1 && reader.ue(6) === 0 && reader.ue(6) === 0 && !reader.bit());
  if (reader.bit()) h264Scaling(reader, 8);
  state.frameBits = reader.ue(12) + 4;
  state.pocType = reader.ue(2);
  state.cycle = [];
  if (state.pocType === 0) state.pocBits = reader.ue(12) + 4;
  else if (state.pocType === 1) {
    state.deltaAlwaysZero = reader.bit();
    state.offsetNonReference = reader.se();
    state.offsetTopBottom = reader.se();
    const count = reader.ue(255);
    for (let index = 0; index < count; index += 1) state.cycle.push(reader.se());
  }
  state.maxReferences = reader.ue(16);
  need(state.maxReferences > 0 && !reader.bit());
  const widthMbs = reader.ue(8191) + 1;
  const heightMbs = reader.ue(8191) + 1;
  need(reader.bit());
  reader.bit();
  const codedWidth = widthMbs * 16;
  const codedHeight = heightMbs * 16;
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  if (reader.bit()) {
    left = reader.ue() * 2;
    right = reader.ue() * 2;
    top = reader.ue() * 2;
    bottom = reader.ue() * 2;
  }
  need(left + right < codedWidth && top + bottom < codedHeight && reader.bit());
  const vui = readH264Vui(reader, state.maxReferences);
  reader.trailing();
  state.macroblocks = widthMbs * heightMbs;
  state.maxReorder = vui.reorder;
  need(
    codedWidth === profile.codedWidth && codedHeight === profile.codedHeight &&
    left === 0 && top === 0 && codedWidth - right === profile.visibleWidth &&
    codedHeight - bottom === profile.visibleHeight && vui.square && vui.fixed &&
    !vui.hrd && !vui.fullRange && vui.primaries === 1 && vui.transfer === 1 &&
    vui.matrix === 1 &&
    vui.timeScale * profile.frameRate.denominator ===
      2 * vui.tick * profile.frameRate.numerator
  );
  const maxDimension = Math.floor(Math.sqrt(limits[2] * 8));
  need(
    widthMbs <= maxDimension && heightMbs <= maxDimension &&
    state.macroblocks <= limits[2] &&
    state.macroblocks * profile.frameRate.numerator <= limits[1] * profile.frameRate.denominator &&
    vui.buffering <= Math.min(16, Math.floor(limits[3] / state.macroblocks))
  );
}

function readH264Vui(reader: Bits, maxReferences: number): {
  square: boolean; tick: number; timeScale: number; fixed: boolean;
  reorder: number; buffering: number; hrd: boolean; fullRange: boolean;
  primaries: number; transfer: number; matrix: number;
} {
  let square = true;
  if (reader.bit()) {
    const aspect = reader.bits(8);
    if (aspect === 255) {
      const width = reader.bits(16);
      const height = reader.bits(16);
      need(width > 0 && height > 0);
      square = width === height;
    } else {
      need(aspect >= 1 && aspect <= 16);
      square = aspect === 1;
    }
  }
  if (reader.bit()) reader.bit();
  let fullRange = false;
  let primaries = -1;
  let transfer = -1;
  let matrix = -1;
  if (reader.bit()) {
    reader.bits(3);
    fullRange = reader.bit();
    if (reader.bit()) {
      primaries = reader.bits(8);
      transfer = reader.bits(8);
      matrix = reader.bits(8);
    }
  }
  if (reader.bit()) { reader.ue(5); reader.ue(5); }
  need(reader.bit());
  const tick = reader.bits(32);
  const timeScale = reader.bits(32);
  need(tick > 0 && timeScale > 0);
  const fixed = reader.bit();
  const nalHrd = reader.bit();
  if (nalHrd) readH264Hrd(reader);
  const vclHrd = reader.bit();
  if (vclHrd) readH264Hrd(reader);
  if (nalHrd || vclHrd) reader.bit();
  reader.bit();
  need(reader.bit());
  reader.bit();
  reader.ue(16); reader.ue(16); reader.ue(32); reader.ue(32);
  const reorder = reader.ue(16);
  const buffering = reader.ue(16);
  need(buffering >= maxReferences && reorder <= buffering);
  return {
    square, tick, timeScale, fixed, reorder, buffering,
    hrd: nalHrd || vclHrd, fullRange, primaries, transfer, matrix
  };
}

function readH264Hrd(reader: Bits): void {
  const count = reader.ue(31) + 1;
  const bitScale = reader.bits(4);
  const cpbScale = reader.bits(4);
  for (let index = 0; index < count; index += 1) {
    const bitrate = (reader.ue() + 1) * 2 ** (6 + bitScale);
    const cpb = (reader.ue() + 1) * 2 ** (4 + cpbScale);
    need(Number.isSafeInteger(bitrate) && Number.isSafeInteger(cpb));
    reader.bit();
  }
  reader.bits(5); reader.bits(5); reader.bits(5); reader.bits(5);
}

function h264Scaling(reader: Bits, count: number): void {
  for (let list = 0; list < count; list += 1) {
    if (!reader.bit()) continue;
    let last = 8;
    let next = 8;
    const size = list < 6 ? 16 : 64;
    for (let index = 0; index < size; index += 1) {
      if (next !== 0) next = (last + reader.se(-128, 127) + 256) % 256;
      last = next === 0 ? last : next;
    }
  }
}

function readH264Pps(bytes: Uint8Array, start: number, end: number, state: H264): void {
  const reader = new Bits(bytes, start, end, true);
  state.pps = reader.ue(255);
  need(reader.ue(31) === state.sps);
  state.entropy = reader.bit();
  need(!reader.bit() && reader.ue(8) === 0);
  state.refs0 = reader.ue(31);
  state.refs1 = reader.ue(31);
  state.weighted = reader.bit();
  state.weightedBi = reader.bits(2);
  need(state.weightedBi <= 2);
  state.initialQp = reader.se(-26, 25);
  need(reader.se(-26, 25) === 0);
  reader.se(-12, 12);
  state.deblocking = reader.bit();
  need(state.deblocking && !reader.bit() && !reader.bit() && reader.more() && reader.bit());
  if (reader.bit()) h264Scaling(reader, 8);
  reader.se(-12, 12);
  reader.trailing();
}

function readH264Slice(
  bytes: Uint8Array,
  start: number,
  end: number,
  idr: boolean,
  reference: number,
  state: H264,
  picture: H264Picture
): void {
  const reader = new Bits(bytes, start, end, true);
  need(reader.ue(state.macroblocks - 1) === 0);
  const type = reader.ue(9) % 5;
  need(type <= 2 && (!idr || type === 2) && reader.ue(255) === state.pps);
  const frame = reader.bits(state.frameBits);
  if (idr) reader.ue(65535);
  let pocLsb = 0;
  let deltaBottom = 0;
  let delta0 = 0;
  let delta1 = 0;
  if (state.pocType === 0) pocLsb = reader.bits(state.pocBits);
  else if (state.pocType === 1 && !state.deltaAlwaysZero) delta0 = reader.se();
  let refs0 = state.refs0;
  let refs1 = state.refs1;
  if (type === 1) reader.bit();
  if (type <= 1) {
    if (reader.bit()) {
      refs0 = reader.ue(31);
      if (type === 1) refs1 = reader.ue(31);
    }
    h264ReferenceLists(reader, type === 1);
  }
  if ((state.weighted && type === 0) || (state.weightedBi === 1 && type === 1)) {
    h264Weights(reader, refs0, type === 1 ? refs1 : -1);
  }
  if (idr) {
    reader.bit();
    need(!reader.bit());
  } else if (reference !== 0) {
    if (reader.bit()) {
      let ended = false;
      for (let index = 0; index < 64; index += 1) {
        const operation = reader.ue(6);
        if (operation === 0) { ended = true; break; }
        need(operation === 1);
        reader.ue(65535);
      }
      need(ended);
    }
  }
  if (state.entropy && type !== 2) reader.ue(2);
  const qp = reader.se(-87, 77);
  need(26 + state.initialQp + qp >= 0 && 26 + state.initialQp + qp <= 51);
  if (state.deblocking) {
    const disabled = reader.ue(2);
    if (disabled !== 1) { reader.se(-6, 6); reader.se(-6, 6); }
  }
  need(reader.remaining > 0);
  picture.type = type;
  picture.frame = frame;
  picture.reference = reference;
  picture.pocLsb = pocLsb;
  picture.deltaBottom = deltaBottom;
  picture.delta0 = delta0;
  picture.delta1 = delta1;
}

function h264ReferenceLists(reader: Bits, bi: boolean): void {
  h264ReferenceList(reader);
  if (bi) h264ReferenceList(reader);
}

function h264ReferenceList(reader: Bits): void {
  if (!reader.bit()) return;
  let ended = false;
  for (let index = 0; index < 64; index += 1) {
    const operation = reader.ue(3);
    if (operation === 3) { ended = true; break; }
    need(operation <= 1);
    reader.ue(65535);
  }
  need(ended);
}

function h264Weights(reader: Bits, refs0: number, refs1: number): void {
  reader.ue(7); reader.ue(7);
  h264WeightList(reader, refs0 + 1);
  if (refs1 >= 0) h264WeightList(reader, refs1 + 1);
}

function h264WeightList(reader: Bits, count: number): void {
  for (let index = 0; index < count; index += 1) {
    if (reader.bit()) { reader.se(-128, 127); reader.se(-128, 127); }
    if (reader.bit()) {
      for (let component = 0; component < 2; component += 1) {
        reader.se(-128, 127); reader.se(-128, 127);
      }
    }
  }
}

function h264Poc(picture: Readonly<H264Picture>, idr: boolean, state: H264): number {
  const maximumFrame = 2 ** state.frameBits;
  let frameOffset = 0;
  if (idr) {
    need(picture.frame === 0);
    state.previousReferenceFrame = 0;
    state.previousReferenceOffset = 0;
    state.previousPocMsb = 0;
    state.previousPocLsb = 0;
  } else {
    need(picture.frame === (state.previousReferenceFrame + 1) % maximumFrame);
    frameOffset = state.previousReferenceOffset +
      (picture.frame < state.previousReferenceFrame ? maximumFrame : 0);
  }
  let poc: number;
  if (state.pocType === 2) {
    const absolute = frameOffset + picture.frame;
    poc = idr ? 0 : picture.reference === 0 ? 2 * absolute - 1 : 2 * absolute;
  } else if (state.pocType === 1) {
    if (idr) poc = picture.delta0;
    else {
      let absolute = frameOffset + picture.frame;
      if (picture.reference === 0 && absolute > 0) absolute -= 1;
      let expected = 0;
      if (absolute > 0 && state.cycle.length > 0) {
        const delta = state.cycle.reduce((sum, value) => sum + value, 0);
        expected = Math.floor((absolute - 1) / state.cycle.length) * delta;
        const inCycle = (absolute - 1) % state.cycle.length;
        for (let index = 0; index <= inCycle; index += 1) expected += state.cycle[index]!;
      }
      if (picture.reference === 0) expected += state.offsetNonReference;
      const top = expected + picture.delta0;
      poc = Math.min(top, top + state.offsetTopBottom + picture.delta1);
    }
  } else {
    const maximum = 2 ** state.pocBits;
    let msb = 0;
    if (!idr) {
      if (picture.pocLsb < state.previousPocLsb && state.previousPocLsb - picture.pocLsb >= maximum / 2) {
        msb = state.previousPocMsb + maximum;
      } else if (picture.pocLsb > state.previousPocLsb && picture.pocLsb - state.previousPocLsb > maximum / 2) {
        msb = state.previousPocMsb - maximum;
      } else msb = state.previousPocMsb;
    }
    poc = Math.min(msb + picture.pocLsb, msb + picture.pocLsb + picture.deltaBottom);
    if (picture.reference !== 0) {
      state.previousPocMsb = msb;
      state.previousPocLsb = picture.pocLsb;
    }
  }
  need(Number.isSafeInteger(poc) && (!idr || poc === 0));
  if (picture.reference !== 0) {
    state.previousReferenceFrame = picture.frame;
    state.previousReferenceOffset = frameOffset;
  }
  return poc;
}

type H265Ptl = {
  space: number;
  tier: boolean;
  profile: number;
  compatibility: number;
  constraints: number[];
  level: number;
};

type H265 = {
  vps: number;
  vpsPtl: H265Ptl | undefined;
  sps: number;
  pocBits: number;
  maxReorder: number;
  ctbBits: number;
  rps: number[][];
  longTerm: boolean;
  temporalMvp: boolean;
  pps: number;
  outputFlag: boolean;
  extraHeaderBits: number;
};

type H265Slice = { type: number; lsb: number; references: readonly number[] };

function validateH265(
  profile: Readonly<CodecValidationProfile>,
  chunks: readonly Readonly<CodecValidationChunk>[],
  previousFingerprint?: string
): string {
  const state: H265 = {
    vps: 0, vpsPtl: undefined, sps: 0, pocBits: 0, maxReorder: 0,
    ctbBits: 0, rps: [], longTerm: false, temporalMvp: false,
    pps: 0, outputFlag: false, extraHeaderBits: 0
  };
  const nal: Nal = { start: 0, end: 0, type: 0, reference: 0, temporal: 0 };
  const pocs: number[] = [];
  const times: number[] = [];
  const decoded = new Set<number>();
  let initialized = false;
  let previousLsb = 0;
  let previousMsb = 0;
  const slice: H265Slice = { type: 0, lsb: 0, references: [] };
  let vpsFingerprint = "";
  let spsFingerprint = "";
  let ppsFingerprint = "";
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    let offset = 0;
    offset = readNal(chunk.bytes, offset, true, nal);
    need(Number(nal.type) === 35 && nal.temporal === 0);
    const aud = readH265Aud(chunk.bytes, nal.start, nal.end);
    if (index === 0) {
      offset = readNal(chunk.bytes, offset, true, nal);
      need(Number(nal.type) === 32 && nal.temporal === 0 && nal.end - nal.start <= 1024 * 1024);
      vpsFingerprint = sha256(chunk.bytes, nal.start - 2, nal.end);
      readH265Vps(chunk.bytes, nal.start, nal.end, state);
      offset = readNal(chunk.bytes, offset, true, nal);
      need(Number(nal.type) === 33 && nal.temporal === 0 && nal.end - nal.start <= 1024 * 1024);
      spsFingerprint = sha256(chunk.bytes, nal.start - 2, nal.end);
      readH265Sps(chunk.bytes, nal.start, nal.end, state, profile);
      offset = readNal(chunk.bytes, offset, true, nal);
      need(Number(nal.type) === 34 && nal.temporal === 0 && nal.end - nal.start <= 1024 * 1024);
      ppsFingerprint = sha256(chunk.bytes, nal.start - 2, nal.end);
      readH265Pps(chunk.bytes, nal.start, nal.end, state);
      offset = readNal(chunk.bytes, offset, true, nal);
      need(Number(nal.type) >= 16 && Number(nal.type) <= 21 && offset === chunk.bytes.length && chunk.key);
    } else {
      offset = readNal(chunk.bytes, offset, true, nal);
      need(Number(nal.type) >= 0 && Number(nal.type) <= 9 && offset === chunk.bytes.length && !chunk.key);
    }
    readH265Slice(chunk.bytes, nal.start, nal.end, nal.type, state, slice);
    need(
      (slice.type === 2 || slice.type === 1 && aud >= 1 || slice.type === 0 && aud === 2) &&
      chunk.displayedFrames === 1
    );
    const idr = Number(nal.type) === 19 || Number(nal.type) === 20;
    const maximum = 2 ** state.pocBits;
    let msb = 0;
    let poc = 0;
    if (idr) {
      initialized = true;
      previousLsb = 0;
      previousMsb = 0;
    } else {
      if (initialized && !(nal.type >= 16 && nal.type <= 21)) {
        if (slice.lsb < previousLsb && previousLsb - slice.lsb >= maximum / 2) msb = previousMsb + maximum;
        else if (slice.lsb > previousLsb && slice.lsb - previousLsb > maximum / 2) msb = previousMsb - maximum;
        else msb = previousMsb;
      }
      poc = msb + slice.lsb;
    }
    for (const delta of slice.references) need(decoded.has(poc + delta));
    need(!decoded.has(poc));
    decoded.add(poc);
    if (nal.temporal === 0 && !(nal.type >= 6 && nal.type <= 9)) {
      initialized = true;
      previousLsb = slice.lsb;
      previousMsb = msb;
    }
    pocs.push(poc);
    times.push(chunk.timestamp);
  }
  comparePresentation(pocs, times, state.maxReorder, true);
  const fingerprint = `${vpsFingerprint}${spsFingerprint}${ppsFingerprint}`;
  need(previousFingerprint === undefined || previousFingerprint === fingerprint);
  return fingerprint;
}

function readH265Aud(bytes: Uint8Array, start: number, end: number): number {
  const reader = new Bits(bytes, start, end, true);
  const type = reader.bits(3);
  need(type <= 2);
  reader.trailing();
  return type;
}

function readH265Ptl(reader: Bits): H265Ptl {
  const space = reader.bits(2);
  const tier = reader.bit();
  const profile = reader.bits(5);
  let compatibility = 0;
  for (let index = 0; index < 32; index += 1) if (reader.bit()) compatibility += 2 ** index;
  const constraints: number[] = [];
  for (let index = 0; index < 6; index += 1) constraints.push(reader.bits(8));
  const level = reader.bits(8);
  need(level > 0);
  return { space, tier, profile, compatibility, constraints, level };
}

function sameH265Ptl(left: Readonly<H265Ptl>, right: Readonly<H265Ptl>): boolean {
  return left.space === right.space && left.tier === right.tier &&
    left.profile === right.profile && left.compatibility === right.compatibility &&
    left.level === right.level && left.constraints.every((value, index) => value === right.constraints[index]);
}

function readH265Vps(bytes: Uint8Array, start: number, end: number, state: H265): void {
  const reader = new Bits(bytes, start, end, true);
  state.vps = reader.bits(4);
  need(reader.bit() && reader.bit() && reader.bits(6) === 0 && reader.bits(3) === 0 && reader.bit());
  need(reader.bits(16) === 0xffff);
  state.vpsPtl = readH265Ptl(reader);
  reader.bit();
  const buffering = reader.ue(15);
  need(reader.ue(15) <= buffering);
  reader.ue();
  need(reader.bits(6) === 0 && reader.ue(1023) === 0);
  if (reader.bit()) {
    need(reader.bits(32) > 0 && reader.bits(32) > 0);
    if (reader.bit()) reader.ue();
    need(reader.ue(1024) === 0);
  }
  need(!reader.bit());
  reader.trailing();
}

function readH265Sps(
  bytes: Uint8Array,
  start: number,
  end: number,
  state: H265,
  profile: Readonly<CodecValidationProfile>
): void {
  const reader = new Bits(bytes, start, end, true);
  need(reader.bits(4) === state.vps && reader.bits(3) === 0 && reader.bit());
  const ptl = readH265Ptl(reader);
  need(state.vpsPtl !== undefined && sameH265Ptl(state.vpsPtl, ptl));
  state.sps = reader.ue(15);
  need(reader.ue(3) === 1);
  const width = reader.ue(1_048_576);
  const height = reader.ue(1_048_576);
  need(width > 0 && height > 0);
  let left = 0;
  let right = 0;
  let top = 0;
  let bottom = 0;
  if (reader.bit()) {
    left = reader.ue() * 2;
    right = reader.ue() * 2;
    top = reader.ue() * 2;
    bottom = reader.ue() * 2;
  }
  need(left + right < width && top + bottom < height && reader.ue(8) === 0 && reader.ue(8) === 0);
  state.pocBits = reader.ue(12) + 4;
  reader.bit();
  const buffering = reader.ue(15) + 1;
  state.maxReorder = reader.ue(15);
  need(state.maxReorder < buffering);
  reader.ue();
  const minBlock = reader.ue(3) + 3;
  state.ctbBits = minBlock + reader.ue(6);
  need(state.ctbBits <= 6);
  reader.ue(3); reader.ue(3); reader.ue(6); reader.ue(6);
  if (reader.bit() && reader.bit()) h265Scaling(reader);
  reader.bit(); reader.bit();
  if (reader.bit()) {
    reader.bits(4); reader.bits(4); reader.ue(3); reader.ue(3); reader.bit();
  }
  const count = reader.ue(64);
  state.rps = [];
  for (let index = 0; index < count; index += 1) {
    state.rps.push(readH265Rps(reader, index, count, state.rps));
  }
  state.longTerm = reader.bit();
  if (state.longTerm) {
    const longCount = reader.ue(32);
    for (let index = 0; index < longCount; index += 1) { reader.bits(state.pocBits); reader.bit(); }
  }
  state.temporalMvp = reader.bit();
  reader.bit();
  const vui = reader.bit() ? readH265Vui(reader) : {
    square: true, defaultWindow: false, timing: false, tick: 0, scale: 0,
    fullRange: false, primaries: -1, transfer: -1, matrix: -1
  };
  if (reader.bit()) need(reader.bits(8) === 0);
  reader.trailing();
  const firstConstraint = ptl.constraints[0] ?? 0;
  need(
    ptl.space === 0 && ptl.profile === 1 && (ptl.compatibility & 2) !== 0 &&
    (firstConstraint & 0x80) !== 0 && (firstConstraint & 0x40) === 0 &&
    (firstConstraint & 0x10) !== 0 && width === profile.codedWidth &&
    height === profile.codedHeight && left === 0 && top === 0 &&
    width - right === profile.visibleWidth && height - bottom === profile.visibleHeight &&
    vui.square && !vui.defaultWindow && vui.timing &&
    vui.scale * profile.frameRate.denominator === vui.tick * profile.frameRate.numerator &&
    !vui.fullRange && vui.primaries === 1 && vui.transfer === 1 && vui.matrix === 1 &&
    !state.longTerm && h265Codec(ptl) === profile.codec
  );
}

function h265Codec(ptl: Readonly<H265Ptl>): string {
  const constraints = [...ptl.constraints];
  while (constraints.at(-1) === 0) constraints.pop();
  const suffix = constraints.map((value) => value.toString(16).toUpperCase().padStart(2, "0")).join(".");
  return `hvc1.${String(ptl.profile)}.${ptl.compatibility.toString(16).toUpperCase()}.${
    ptl.tier ? "H" : "L"
  }${String(ptl.level)}${suffix.length === 0 ? "" : `.${suffix}`}`;
}

function readH265Vui(reader: Bits): {
  square: boolean; defaultWindow: boolean; timing: boolean; tick: number; scale: number;
  fullRange: boolean; primaries: number; transfer: number; matrix: number;
} {
  let square = true;
  if (reader.bit()) {
    const aspect = reader.bits(8);
    if (aspect === 255) {
      const width = reader.bits(16);
      const height = reader.bits(16);
      need(width > 0 && height > 0);
      square = width === height;
    } else square = aspect === 1;
  }
  if (reader.bit()) reader.bit();
  let fullRange = false;
  let primaries = -1;
  let transfer = -1;
  let matrix = -1;
  if (reader.bit()) {
    reader.bits(3);
    fullRange = reader.bit();
    if (reader.bit()) {
      primaries = reader.bits(8);
      transfer = reader.bits(8);
      matrix = reader.bits(8);
    }
  }
  if (reader.bit()) { reader.ue(5); reader.ue(5); }
  reader.bit();
  need(!reader.bit());
  reader.bit();
  const defaultWindow = reader.bit();
  if (defaultWindow) { reader.ue(); reader.ue(); reader.ue(); reader.ue(); }
  let timing = false;
  let tick = 0;
  let scale = 0;
  if (reader.bit()) {
    timing = true;
    tick = reader.bits(32);
    scale = reader.bits(32);
    need(tick > 0 && scale > 0);
    if (reader.bit()) reader.ue();
    need(!reader.bit());
  }
  if (reader.bit()) {
    reader.bit(); reader.bit(); reader.bit(); reader.ue(4095);
    reader.ue(16); reader.ue(16); reader.ue(16); reader.ue(16);
  }
  return { square, defaultWindow, timing, tick, scale, fullRange, primaries, transfer, matrix };
}

function h265Scaling(reader: Bits): void {
  for (let size = 0; size < 4; size += 1) {
    for (let matrix = 0; matrix < 6; matrix += size === 3 ? 3 : 1) {
      if (!reader.bit()) reader.ue(matrix);
      else {
        const count = Math.min(64, 1 << (4 + size * 2));
        if (size > 1) reader.se(-7, 247);
        for (let index = 0; index < count; index += 1) reader.se(-128, 127);
      }
    }
  }
}

function readH265Rps(reader: Bits, index: number, total: number, previous: readonly number[][]): number[] {
  const pictures: number[] = [];
  if (index !== 0 && reader.bit()) {
    const deltaIndex = index === total ? reader.ue(index - 1) : 0;
    const reference = previous[index - deltaIndex - 1];
    need(reference !== undefined);
    const negative = reader.bit();
    const magnitude = reader.ue(32767) + 1;
    const delta = negative ? -magnitude : magnitude;
    const candidates = [...reference, 0].map((value) => value + delta);
    for (const candidate of candidates) {
      const used = reader.bit();
      if (used || reader.bit()) {
        need(candidate !== 0);
        pictures.push(candidate);
      }
    }
  } else {
    const negatives = reader.ue(64);
    const positives = reader.ue(64);
    need(negatives + positives <= 64);
    let delta = 0;
    for (let item = 0; item < negatives; item += 1) {
      delta -= reader.ue(32767) + 1;
      pictures.push(delta);
      reader.bit();
    }
    delta = 0;
    for (let item = 0; item < positives; item += 1) {
      delta += reader.ue(32767) + 1;
      pictures.push(delta);
      reader.bit();
    }
  }
  pictures.sort((left, right) => left < 0 && right >= 0 ? -1 : left >= 0 && right < 0 ? 1 :
    left < 0 ? right - left : left - right);
  need(pictures.every((value, item) => item === 0 || value !== pictures[item - 1]));
  return pictures;
}

function readH265Pps(bytes: Uint8Array, start: number, end: number, state: H265): void {
  const reader = new Bits(bytes, start, end, true);
  state.pps = reader.ue(63);
  need(reader.ue(15) === state.sps);
  reader.bit();
  state.outputFlag = reader.bit();
  state.extraHeaderBits = reader.bits(3);
  reader.bit(); reader.bit(); reader.ue(14); reader.ue(14); reader.se(-26, 25);
  reader.bit(); reader.bit();
  if (reader.bit()) reader.ue(6);
  reader.se(-12, 12); reader.se(-12, 12);
  reader.bit(); reader.bit(); reader.bit(); reader.bit();
  const tiles = reader.bit();
  reader.bit();
  if (tiles) {
    const columns = reader.ue(19);
    const rows = reader.ue(21);
    if (!reader.bit()) {
      for (let index = 0; index < columns; index += 1) reader.ue();
      for (let index = 0; index < rows; index += 1) reader.ue();
    }
    reader.bit();
  }
  reader.bit();
  if (reader.bit()) {
    reader.bit();
    if (!reader.bit()) { reader.se(-6, 6); reader.se(-6, 6); }
  }
  if (reader.bit()) h265Scaling(reader);
  reader.bit(); reader.ue(4); reader.bit();
  if (reader.bit()) need(reader.bits(8) === 0);
  reader.trailing();
}

function readH265Slice(
  bytes: Uint8Array,
  start: number,
  end: number,
  nalType: number,
  state: Readonly<H265>,
  output: H265Slice
): void {
  const reader = new Bits(bytes, start, end, true);
  need(reader.bit());
  const random = nalType >= 16 && nalType <= 21;
  if (random) reader.bit();
  need(reader.ue(63) === state.pps);
  for (let index = 0; index < state.extraHeaderBits; index += 1) reader.bit();
  const type = reader.ue(2);
  need(!random || type === 2);
  if (state.outputFlag) reader.bit();
  let lsb = 0;
  let references: readonly number[] = [];
  if (nalType !== 19 && nalType !== 20) {
    lsb = reader.bits(state.pocBits);
    if (reader.bit()) {
      need(state.rps.length > 0);
      const width = state.rps.length <= 1 ? 0 : Math.ceil(Math.log2(state.rps.length));
      const selected = state.rps[width === 0 ? 0 : reader.bits(width)];
      need(selected !== undefined);
      references = selected;
    } else references = readH265Rps(reader, state.rps.length, state.rps.length, state.rps);
    need(!state.longTerm);
    if (state.temporalMvp) reader.bit();
  }
  need(reader.remaining >= 8);
  output.type = type;
  output.lsb = lsb;
  output.references = references;
}
