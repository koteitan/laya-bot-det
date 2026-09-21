"""NIP-19 bech32, written out here rather than pulled from a library.

Encode and decode stay symmetric: `encode_npub(decode_npub(s)) == s`.
"""

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
GEN = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]


def _polymod(values):
    chk = 1
    for v in values:
        top = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i in range(5):
            chk ^= GEN[i] if ((top >> i) & 1) else 0
    return chk


def _hrp_expand(hrp):
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _verify_checksum(hrp, data):
    return _polymod(_hrp_expand(hrp) + data) == 1


def _create_checksum(hrp, data):
    values = _hrp_expand(hrp) + data + [0, 0, 0, 0, 0, 0]
    polymod = _polymod(values) ^ 1
    return [(polymod >> 5 * (5 - i)) & 31 for i in range(6)]


def _convertbits(data, frombits, tobits, pad=True):
    acc = 0
    bits = 0
    ret = []
    maxv = (1 << tobits) - 1
    max_acc = (1 << (frombits + tobits - 1)) - 1
    for value in data:
        if value < 0 or (value >> frombits):
            raise ValueError("invalid value in convertbits")
        acc = ((acc << frombits) | value) & max_acc
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if pad:
        if bits:
            ret.append((acc << (tobits - bits)) & maxv)
    elif bits >= frombits or ((acc << (tobits - bits)) & maxv):
        raise ValueError("invalid padding in convertbits")
    return ret


def bech32_decode(bech):
    if bech != bech.lower() and bech != bech.upper():
        raise ValueError("mixed case bech32 string")
    bech = bech.lower()
    pos = bech.rfind("1")
    if pos < 1 or pos + 7 > len(bech):
        raise ValueError("no separator or bad position")
    hrp = bech[:pos]
    try:
        data = [CHARSET.index(c) for c in bech[pos + 1 :]]
    except ValueError as exc:
        raise ValueError("invalid bech32 character") from exc
    if not _verify_checksum(hrp, data):
        raise ValueError("bad bech32 checksum")
    return hrp, data[:-6]


def bech32_encode(hrp, data):
    combined = data + _create_checksum(hrp, data)
    return hrp + "1" + "".join(CHARSET[d] for d in combined)


def decode_npub(npub: str) -> str:
    """npub1... -> 64-char hex pubkey."""
    hrp, data = bech32_decode(npub)
    if hrp != "npub":
        raise ValueError(f"expected npub, got {hrp}")
    raw = bytes(_convertbits(data, 5, 8, False))
    if len(raw) != 32:
        raise ValueError(f"expected 32 bytes, got {len(raw)}")
    return raw.hex()


def encode_npub(hex_pubkey: str) -> str:
    """64-char hex pubkey -> npub1..."""
    raw = bytes.fromhex(hex_pubkey)
    if len(raw) != 32:
        raise ValueError(f"expected 32 bytes, got {len(raw)}")
    return bech32_encode("npub", _convertbits(list(raw), 8, 5, True))
