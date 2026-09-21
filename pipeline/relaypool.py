"""Minimal nostr REQ client: open a socket, send one filter, collect until EOSE.

Kept to `asyncio.wait_for` so the pipeline runs on Python 3.10, which has no
`asyncio.timeout`.
"""

import asyncio
import json
import logging
from typing import Any

from websockets.asyncio.client import connect

log = logging.getLogger(__name__)

# Every relay in nostr-research's NIP-11 table reports max_limit >= 200, so 100 is safe.
DEFAULT_LIMIT = 100
EOSE_TIMEOUT = 5.0
OPEN_TIMEOUT = 8.0
TOTAL_TIMEOUT = 40.0


async def _collect(url: str, filt: dict[str, Any], eose_timeout: float) -> list[dict]:
    events: list[dict] = []
    sub = "s"
    async with connect(url, open_timeout=OPEN_TIMEOUT, max_size=2**21) as ws:
        await ws.send(json.dumps(["REQ", sub, filt]))
        while True:
            raw = await asyncio.wait_for(ws.recv(), timeout=eose_timeout)
            msg = json.loads(raw)
            if not isinstance(msg, list) or not msg:
                continue
            if msg[0] == "EVENT" and len(msg) >= 3:
                events.append(msg[2])
            elif msg[0] in ("EOSE", "CLOSED"):
                break
        try:
            await ws.send(json.dumps(["CLOSE", sub]))
        except Exception:
            pass
    return events


async def req(url: str, filt: dict[str, Any], *, eose_timeout: float = EOSE_TIMEOUT) -> list[dict]:
    """Send one REQ to one relay and return its events.

    A relay being slow, down or rude is routine, so this never raises; it logs and
    returns what it got. Run with `-v` to see which relays failed and why.
    """
    try:
        return await asyncio.wait_for(_collect(url, filt, eose_timeout), timeout=TOTAL_TIMEOUT)
    except Exception as exc:
        log.debug("%s: %s: %s", url, type(exc).__name__, exc)
        return []


async def req_many(urls: list[str], filt: dict[str, Any], **kw) -> dict[str, list[dict]]:
    """Same filter against several relays at once. Returns {url: events}."""
    results = await asyncio.gather(*(req(u, filt, **kw) for u in urls))
    out = dict(zip(urls, results))
    dead = [u for u, evs in out.items() if not evs]
    if dead:
        log.debug("no events from %d/%d relays: %s", len(dead), len(urls), ", ".join(dead))
    return out


def dedup(events: list[dict]) -> list[dict]:
    """Keep one event per id, preserving first-seen order."""
    seen: set[str] = set()
    out = []
    for ev in events:
        eid = ev.get("id")
        if not eid or eid in seen:
            continue
        seen.add(eid)
        out.append(ev)
    return out
