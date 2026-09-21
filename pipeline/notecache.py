"""An append-only kind:1 cache, plus named snapshots of what each run collected.

Two separate things live here, and the split is the point:

- `notes.jsonl` accumulates every kind:1 event ever collected, deduplicated by
  event id. It only grows.
- `snapshots/<id>.json` records which event ids one `collect` run saw, with the
  relays and settings that produced them.

So a run can be replayed exactly -- `detect --snapshot 20260921-105612` scores
the same events again, however much the cache has grown since -- while
`--snapshot all` scores everything ever collected.
"""

import json
import logging
import time
from pathlib import Path

log = logging.getLogger(__name__)


class NoteCache:
    def __init__(self, cache_dir: Path):
        self.dir = Path(cache_dir)
        self.path = self.dir / "notes.jsonl"
        self.snapshots = self.dir / "snapshots"

    def _iter_raw(self):
        if not self.path.exists():
            return
        with self.path.open(encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError:
                    log.debug("skipping a corrupt cache line")

    def ids(self) -> set[str]:
        return {e["id"] for e in self._iter_raw() if e.get("id")}

    def load(self, keep: set[str] | None = None) -> list[dict]:
        """Every cached event, or only those whose id is in `keep`."""
        out = []
        for ev in self._iter_raw():
            eid = ev.get("id")
            if eid and (keep is None or eid in keep):
                out.append(ev)
        return out

    def add(self, events: list[dict]) -> int:
        """Append events the cache does not already hold. Returns how many were new."""
        known = self.ids()
        fresh = []
        for ev in events:
            eid = ev.get("id")
            if eid and eid not in known:
                known.add(eid)
                fresh.append(ev)
        if fresh:
            self.dir.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as fh:
                for ev in fresh:
                    fh.write(json.dumps(ev, ensure_ascii=False) + "\n")
        log.info("cache: +%d new, %d total", len(fresh), len(known))
        return len(fresh)

    def save_snapshot(self, events: list[dict], meta: dict) -> str:
        snapshot_id = time.strftime("%Y%m%d-%H%M%S", time.localtime())
        self.snapshots.mkdir(parents=True, exist_ok=True)
        payload = dict(meta)
        payload["id"] = snapshot_id
        payload["collected_at"] = int(time.time())
        payload["notes"] = len(events)
        payload["event_ids"] = [e["id"] for e in events if e.get("id")]
        (self.snapshots / f"{snapshot_id}.json").write_text(
            json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        log.info("snapshot %s: %d notes", snapshot_id, len(events))
        return snapshot_id

    def list_snapshots(self) -> list[dict]:
        if not self.snapshots.exists():
            return []
        out = []
        for path in sorted(self.snapshots.glob("*.json")):
            try:
                meta = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                continue
            meta.pop("event_ids", None)
            out.append(meta)
        return out

    def resolve(self, name: str | None) -> tuple[list[dict], dict]:
        """Events for a snapshot id, `latest`, or `all` (the whole cache).

        Returns the events and a description of where they came from.
        """
        if name == "all":
            events = self.load()
            return events, {"snapshot": "all", "notes": len(events)}

        snaps = sorted(self.snapshots.glob("*.json")) if self.snapshots.exists() else []
        if not snaps:
            raise FileNotFoundError("no snapshots yet -- run the collect stage first")
        if name in (None, "latest"):
            path = snaps[-1]
        else:
            path = self.snapshots / f"{name}.json"
            if not path.exists():
                have = ", ".join(p.stem for p in snaps[-5:])
                raise FileNotFoundError(f"no snapshot {name!r}; latest are: {have}")
        meta = json.loads(path.read_text(encoding="utf-8"))
        wanted = set(meta.get("event_ids") or [])
        events = self.load(keep=wanted)
        if len(events) < len(wanted):
            log.warning("snapshot %s lists %d events but the cache holds %d",
                        meta["id"], len(wanted), len(events))
        meta.pop("event_ids", None)
        meta["snapshot"] = meta["id"]
        return events, meta
