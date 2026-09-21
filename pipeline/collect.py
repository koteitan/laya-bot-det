"""Event collection: kind:1 sampling, and a kind:0 profile cache."""

import asyncio
import json
import logging
import mimetypes
import os
import time
import urllib.request
from pathlib import Path

from .relaypool import dedup, req_many

log = logging.getLogger(__name__)

PICTURE_MAX_BYTES = 2 * 1024 * 1024
PICTURE_TIMEOUT = 10


async def collect_notes(relays: list[str], *, trials: int = 10, limit: int = 100) -> list[dict]:
    """`trials` rounds of `limit` kind:1 events per relay, walking backwards in time.

    Each round asks every relay for the newest notes older than the previous round's
    oldest, so the rounds sample different windows instead of refetching one page.
    Relays disagree about what they hold, so the per-relay cursor is tracked separately.
    """
    until: dict[str, int | None] = {r: None for r in relays}
    collected: list[dict] = []

    for trial in range(1, trials + 1):
        filters = {}
        for r in relays:
            f = {"kinds": [1], "limit": limit}
            if until[r] is not None:
                f["until"] = until[r]
            filters[r] = f
        results = await asyncio.gather(*(req_many([r], filters[r]) for r in relays))
        got = 0
        for r, res in zip(relays, results):
            evs = res.get(r, [])
            got += len(evs)
            collected.extend(evs)
            if evs:
                oldest = min(e.get("created_at", 0) for e in evs)
                # step one second past the oldest so the next page cannot repeat it
                until[r] = oldest - 1
        uniq = len(dedup(collected))
        log.info("trial %2d/%d: +%d events, %d unique so far", trial, trials, got, uniq)
        if got == 0:
            log.info("no relay returned anything; stopping early")
            break

    events = dedup(collected)
    log.info("collected %d unique kind:1 events", len(events))
    return events


def group_by_author(events: list[dict]) -> dict[str, list[dict]]:
    """{pubkey: [events, newest first]}."""
    authors: dict[str, list[dict]] = {}
    for ev in events:
        pk = ev.get("pubkey")
        if pk:
            authors.setdefault(pk, []).append(ev)
    for evs in authors.values():
        evs.sort(key=lambda e: e.get("created_at", 0), reverse=True)
    return authors


def load_cache(path: Path) -> dict:
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {}


def save_cache(path: Path, cache: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")


def _download_picture(url: str, pubkey: str, outdir: Path) -> str | None:
    """Fetch a profile picture into `outdir`.

    Returns the path **relative to `data/`**, which is where `authors.json` lives;
    the web page rejoins the two (see `DATA_DIR` in main.js). Returns None when
    the URL is not an image, is too large, or cannot be fetched.
    """
    if not url or not url.startswith(("http://", "https://")):
        return None
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "laya-bot-det/0.1"})
        with urllib.request.urlopen(req, timeout=PICTURE_TIMEOUT) as resp:
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip()
            if not ctype.startswith("image/"):
                log.debug("%s: not an image (%s)", pubkey[:8], ctype)
                return None
            data = resp.read(PICTURE_MAX_BYTES + 1)
        if len(data) > PICTURE_MAX_BYTES:
            log.debug("%s: picture over %d bytes, skipped", pubkey[:8], PICTURE_MAX_BYTES)
            return None
        ext = mimetypes.guess_extension(ctype) or ".img"
        if ext == ".jpe":
            ext = ".jpg"
        outdir.mkdir(parents=True, exist_ok=True)
        path = outdir / f"{pubkey}{ext}"
        path.write_bytes(data)
        return f"cache/pictures/{path.name}"
    except Exception as exc:
        log.debug("%s: picture fetch failed: %s", pubkey[:8], exc)
        return None


async def collect_profiles(
    relays: list[str],
    pubkeys: list[str],
    cache_path: Path,
    picture_dir: Path,
    *,
    batch: int = 100,
    pictures: bool = True,
) -> dict:
    """Fill in kind:0 for any pubkey the cache does not already hold.

    The cache is the source of truth: a pubkey already in it is never refetched, so
    reruns only pay for authors that are new since last time.
    """
    cache = load_cache(cache_path)
    missing = [pk for pk in pubkeys if pk not in cache]
    log.info("profiles: %d cached, %d to fetch", len(pubkeys) - len(missing), len(missing))

    for i in range(0, len(missing), batch):
        chunk = missing[i : i + batch]
        got = await req_many(relays, {"kinds": [0], "authors": chunk, "limit": len(chunk)})
        newest: dict[str, dict] = {}
        for evs in got.values():
            for ev in evs:
                pk = ev.get("pubkey")
                if pk and ev.get("created_at", 0) > newest.get(pk, {}).get("created_at", -1):
                    newest[pk] = ev
        for pk in chunk:
            ev = newest.get(pk)
            meta = {}
            if ev:
                try:
                    meta = json.loads(ev.get("content") or "{}")
                    if not isinstance(meta, dict):
                        meta = {}
                except Exception:
                    meta = {}
            # NIP-24 `bot`: the account's own declaration that it is automated.
            # Self-reported, so absent on most bots, but it is ground truth where present.
            bot_flag = meta.get("bot")
            cache[pk] = {
                "bot": bot_flag if isinstance(bot_flag, bool) else None,
                "name": meta.get("name") or "",
                "display_name": meta.get("display_name") or meta.get("displayName") or "",
                "about": meta.get("about") or "",
                "nip05": meta.get("nip05") or "",
                "picture_url": meta.get("picture") or "",
                "picture_local": None,
                "created_at": ev.get("created_at") if ev else None,
                "found": bool(ev),
                "fetched_at": int(time.time()),
            }
        log.info("profiles: fetched %d/%d", min(i + batch, len(missing)), len(missing))
        save_cache(cache_path, cache)

    if pictures:
        todo = [pk for pk in pubkeys
                if cache.get(pk, {}).get("picture_url") and not cache[pk].get("picture_local")]
        log.info("pictures: %d to download", len(todo))
        for n, pk in enumerate(todo, 1):
            local = await asyncio.to_thread(
                _download_picture, cache[pk]["picture_url"], pk, picture_dir
            )
            cache[pk]["picture_local"] = local
            if n % 25 == 0 or n == len(todo):
                log.info("pictures: %d/%d", n, len(todo))
                save_cache(cache_path, cache)
        save_cache(cache_path, cache)

    return cache
