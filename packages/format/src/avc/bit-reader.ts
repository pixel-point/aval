import { avcInvalid } from "./failure.js";

/** Bounded MSB-first RBSP reader. */
export class RbspBitReader {
  readonly #bytes: Uint8Array;
  readonly #path: string;
  readonly #absoluteOffset: number;
  #bitOffset = 0;

  public constructor(bytes: Uint8Array, path: string, absoluteOffset: number) {
    this.#bytes = bytes;
    this.#path = path;
    this.#absoluteOffset = absoluteOffset;
  }

  public get bitOffset(): number {
    return this.#bitOffset;
  }

  public get bitsRemaining(): number {
    return this.#bytes.length * 8 - this.#bitOffset;
  }

  public readBit(label: string): boolean {
    if (this.#bitOffset >= this.#bytes.length * 8) {
      this.#fail(`truncated ${label}`);
    }
    const byte = this.#bytes[Math.floor(this.#bitOffset / 8)];
    if (byte === undefined) {
      this.#fail(`truncated ${label}`);
    }
    const value = (byte >> (7 - (this.#bitOffset % 8))) & 1;
    this.#bitOffset += 1;
    return value === 1;
  }

  public readBits(width: number, label: string): number {
    if (!Number.isInteger(width) || width < 0 || width > 32) {
      this.#fail(`invalid bit width while reading ${label}`);
    }
    if (this.bitsRemaining < width) {
      this.#fail(`truncated ${label}`);
    }
    let result = 0;
    for (let index = 0; index < width; index += 1) {
      result = result * 2 + (this.readBit(label) ? 1 : 0);
    }
    return result;
  }

  public readUnsignedExpGolomb(label: string, maximum = 0xffff_ffff): number {
    let leadingZeroBits = 0;
    while (!this.readBit(label)) {
      leadingZeroBits += 1;
      if (leadingZeroBits > 31) {
        this.#fail(`${label} Exp-Golomb value is too large`);
      }
    }

    const suffix = this.readBits(leadingZeroBits, label);
    const value = 2 ** leadingZeroBits - 1 + suffix;
    if (!Number.isSafeInteger(value) || value > maximum) {
      this.#fail(`${label} exceeds ${String(maximum)}`);
    }
    return value;
  }

  public readSignedExpGolomb(
    label: string,
    minimum = -0x7fff_ffff,
    maximum = 0x7fff_ffff
  ): number {
    const codeNumber = this.readUnsignedExpGolomb(label);
    const magnitude = Math.ceil(codeNumber / 2);
    const value = codeNumber % 2 === 0 ? -magnitude : magnitude;
    if (value < minimum || value > maximum) {
      this.#fail(`${label} lies outside the supported range`);
    }
    return value;
  }

  /** True when syntax data remains before the mandatory RBSP stop bit. */
  public moreRbspData(): boolean {
    if (this.bitsRemaining === 0) {
      return false;
    }
    const first = this.#peekBit(this.#bitOffset);
    if (!first) {
      return true;
    }
    for (
      let bit = this.#bitOffset + 1;
      bit < this.#bytes.length * 8;
      bit += 1
    ) {
      if (this.#peekBit(bit)) {
        return true;
      }
    }
    return false;
  }

  public readTrailingBits(): void {
    if (!this.readBit("rbsp_stop_one_bit")) {
      this.#fail("rbsp_stop_one_bit must be one");
    }
    while (this.bitsRemaining > 0) {
      if (this.readBit("rbsp_alignment_zero_bit")) {
        this.#fail("RBSP alignment bits must be zero");
      }
    }
  }

  #peekBit(bitOffset: number): boolean {
    const byte = this.#bytes[Math.floor(bitOffset / 8)];
    return byte !== undefined && ((byte >> (7 - (bitOffset % 8))) & 1) === 1;
  }

  #fail(message: string): never {
    avcInvalid(
      this.#path,
      message,
      this.#absoluteOffset + Math.floor(this.#bitOffset / 8)
    );
  }
}
