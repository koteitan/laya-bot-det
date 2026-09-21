"""Relay sets and the kind:10002 discovery chain."""

import asyncio
import logging

from .relaypool import req_many

log = logging.getLogger(__name__)

BOOTSTRAP = [
    "wss://directory.yabu.me",
    "wss://purplepag.es",
    "wss://relay.nostr.band",
    "wss://indexer.coracle.social",
]

FALLBACK_JA = [
    "wss://yabu.me",
    "wss://nostr.compile-error.net",
    "wss://r.kojira.io",
    "wss://relay-jp.nostr.wirednet.jp",
    "wss://nrelay-jp.c-stellar.net",
    "wss://nostream.ocha.one",
    "wss://snowflare.cc",
]


def _parse_10002(event: dict) -> tuple[list[str], list[str]]:
    """NIP-65: ['r', url] with an optional 'read'/'write' marker. No marker means both."""
    read, write = [], []
    for tag in event.get("tags", []):
        if len(tag) < 2 or tag[0] != "r":
            continue
        url = tag[1].strip()
        if not url.startswith("ws"):
            continue
        marker = tag[2].strip().lower() if len(tag) > 2 and tag[2] else ""
        if marker == "read":
            read.append(url)
        elif marker == "write":
            write.append(url)
        else:
            read.append(url)
            write.append(url)
    return read, write


async def discover(pubkey_hex: str) -> dict:
    """kind:10002 from the bootstrap relays. Falls back to kind:3, then the static set.

    Only kind:10002 counts when it exists; kind:3 is a fallback, never a supplement.
    """
    got = await req_many(BOOTSTRAP, {"kinds": [10002], "authors": [pubkey_hex], "limit": 5})
    events = [ev for evs in got.values() for ev in evs]
    if events:
        newest = max(events, key=lambda e: e.get("created_at", 0))
        read, write = _parse_10002(newest)
        if read or write:
            log.info("kind:10002 found: %d read / %d write", len(read), len(write))
            return {"source": "kind:10002", "created_at": newest.get("created_at"),
                    "read": read, "write": write}

    log.info("no kind:10002; trying kind:3")
    got = await req_many(BOOTSTRAP, {"kinds": [3], "authors": [pubkey_hex], "limit": 5})
    events = [ev for evs in got.values() for ev in evs]
    if events:
        newest = max(events, key=lambda e: e.get("created_at", 0))
        try:
            import json
            legacy = json.loads(newest.get("content") or "{}")
            read = [u for u, p in legacy.items() if p.get("read", True)]
            write = [u for u, p in legacy.items() if p.get("write", True)]
            if read or write:
                log.info("kind:3 legacy relay map: %d read", len(read))
                return {"source": "kind:3", "created_at": newest.get("created_at"),
                        "read": read, "write": write}
        except Exception as exc:
            log.debug("kind:3 content not parseable: %s", exc)

    log.info("falling back to the static ja relay set")
    return {"source": "fallback", "created_at": None,
            "read": list(FALLBACK_JA), "write": list(FALLBACK_JA)}


if __name__ == "__main__":
    import sys
    from .nip19 import decode_npub
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    print(asyncio.run(discover(decode_npub(sys.argv[1]))))
