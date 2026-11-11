/*
 * QuickXorHash, OneDrive's content hash (OneDrive sync spec §2.2). The state is 160 bits;
 * byte n of the input is XORed in at bit (11 * n) mod 160, rotating; the 64-bit
 * little-endian input length is XORed into the last 8 bytes. The digest is base64.
 */

const WIDTH_BITS = 160;
const SHIFT = 11;
const WIDTH_BYTES = WIDTH_BITS / 8;

/**
 * Incremental QuickXorHash. Byte n lands at a bit position that depends only on n mod 160,
 * so the bytes are folded into 160 cells while streaming and placed once in `digest()`.
 */
export class QuickXorHash {
  private readonly cells = new Uint8Array(WIDTH_BITS);
  private index = 0;
  private length = 0n;

  update(chunk: Uint8Array): this {
    const cells = this.cells;
    let i = this.index;
    for (let j = 0; j < chunk.length; j++) {
      cells[i] = (cells[i] as number) ^ (chunk[j] as number);
      i = i === WIDTH_BITS - 1 ? 0 : i + 1;
    }
    this.index = i;
    this.length += BigInt(chunk.length);
    return this;
  }

  /** The base64 digest (28 characters). */
  digest(): string {
    const out = new Uint8Array(WIDTH_BYTES);
    for (let cell = 0; cell < WIDTH_BITS; cell++) {
      const value = this.cells[cell] as number;
      if (value === 0) continue;
      const bit = (cell * SHIFT) % WIDTH_BITS;
      const byte = bit >> 3;
      const offset = bit & 7;
      // A byte spans at most two state bytes; the second wraps to the start of the state.
      out[byte] = (out[byte] as number) ^ ((value << offset) & 0xff);
      if (offset > 0) {
        const next = (byte + 1) % WIDTH_BYTES;
        out[next] = (out[next] as number) ^ (value >> (8 - offset));
      }
    }
    let length = this.length;
    for (let i = 0; i < 8; i++) {
      const at = WIDTH_BYTES - 8 + i;
      out[at] = (out[at] as number) ^ Number(length & 0xffn);
      length >>= 8n;
    }
    return Buffer.from(out).toString('base64');
  }
}

/** QuickXorHash of a whole buffer. */
export function quickXor(data: Uint8Array): string {
  return new QuickXorHash().update(data).digest();
}
