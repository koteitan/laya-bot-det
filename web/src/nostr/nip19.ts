/** NIP-19 bech32, written out here rather than pulled from a library.
 *  Encode and decode stay symmetric: `encodeNpub(decodeNpub(s)) === s`. */

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}

const hrpExpand = (hrp: string): number[] => [
  ...[...hrp].map((c) => c.charCodeAt(0) >> 5),
  0,
  ...[...hrp].map((c) => c.charCodeAt(0) & 31),
];

function createChecksum(hrp: string, data: number[]): number[] {
  const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  return [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    if (value < 0 || value >> from) throw new Error("invalid value in convertBits");
    acc = ((acc << from) | value) & ((1 << (from + to - 1)) - 1);
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    throw new Error("invalid padding in convertBits");
  }
  return out;
}

/** npub1... -> 64-char hex pubkey. */
export function decodeNpub(npub: string): string {
  const s = npub.toLowerCase();
  if (npub !== s && npub !== npub.toUpperCase()) throw new Error("mixed case bech32 string");
  const pos = s.lastIndexOf("1");
  if (pos < 1 || pos + 7 > s.length) throw new Error("no separator or bad position");
  const hrp = s.slice(0, pos);
  if (hrp !== "npub") throw new Error(`expected npub, got ${hrp}`);
  const data = [...s.slice(pos + 1)].map((c) => {
    const i = CHARSET.indexOf(c);
    if (i < 0) throw new Error("invalid bech32 character");
    return i;
  });
  if (polymod([...hrpExpand(hrp), ...data]) !== 1) throw new Error("bad bech32 checksum");
  const bytes = convertBits(data.slice(0, -6), 5, 8, false);
  if (bytes.length !== 32) throw new Error(`expected 32 bytes, got ${bytes.length}`);
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 64-char hex pubkey -> npub1... */
export function encodeNpub(hex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("expected 64 hex characters");
  const bytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
  const data = convertBits(bytes, 8, 5, true);
  return "npub1" + [...data, ...createChecksum("npub", data)].map((d) => CHARSET[d]).join("");
}
