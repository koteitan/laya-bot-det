"""laya-bot-det pipeline CLI.

Each stage writes its output under data/ and the next stage reads it, so any
stage can be rerun on its own without repeating the network work before it.
"""

import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path

from . import __version__
from .collect import collect_notes, collect_profiles, group_by_author, load_cache
from .detect import BOT_THRESHOLD, judge
from .evaluate import evaluate
from .features import author_features
from .nip19 import decode_npub, encode_npub
from .notecache import NoteCache
from .relays import discover

log = logging.getLogger("laya-bot-det")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / "cache"
RELAYS_JSON = DATA / "relays.json"
NOTE_CACHE = CACHE / "notes"
PROFILES_JSON = CACHE / "profiles.json"
AUTHORS_JSON = DATA / "authors.json"
PICTURES = CACHE / "pictures"
MODEL_DIR = ROOT / "models" / "laya-multilingual-onnx"

DEFAULT_NPUB = "npub1f3w4x7dqvceeez8kuyq78md3lwhwfm0ra634llr0r3nykwjrs0hqvldhgk"


def _write(path: Path, obj) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    log.info("wrote %s (%.1f KB)", path.relative_to(ROOT), path.stat().st_size / 1024)


def _load_events(name: str | None) -> tuple[list[dict], dict]:
    """Events for the chosen snapshot, so every stage scores the same set."""
    try:
        events, meta = NoteCache(NOTE_CACHE).resolve(name)
    except FileNotFoundError as exc:
        sys.exit(str(exc))
    log.info("snapshot %s: %d notes", meta.get("snapshot"), len(events))
    return events, meta


def _read(path: Path, what: str):
    if not path.exists():
        sys.exit(f"{path.relative_to(ROOT)} is missing -- run the {what} stage first")
    return json.loads(path.read_text(encoding="utf-8"))


def cmd_model(args) -> None:
    from .laya import ensure_model

    ensure_model(MODEL_DIR)
    log.info("model ready at %s", MODEL_DIR.relative_to(ROOT))


def cmd_relays(args) -> None:
    pubkey = decode_npub(args.npub)
    log.info("npub %s -> %s", args.npub[:16] + "...", pubkey)
    result = asyncio.run(discover(pubkey))
    result["npub"] = args.npub
    result["pubkey"] = pubkey
    _write(RELAYS_JSON, result)
    print(f"{result['source']}: {len(result['read'])} read relays")
    for url in result["read"]:
        print("  ", url)


def cmd_collect(args) -> None:
    relays = _read(RELAYS_JSON, "relays")["read"]
    events = asyncio.run(collect_notes(relays, trials=args.trials, limit=args.limit))
    cache = NoteCache(NOTE_CACHE)
    fresh = cache.add(events)
    snapshot = cache.save_snapshot(events, {"relays": relays, "trials": args.trials,
                                            "limit": args.limit})
    authors = group_by_author(events)
    print(f"{len(events)} notes ({fresh} new to the cache) from {len(authors)} authors")
    print(f"snapshot {snapshot} -- replay it with: ./bot-det detect --snapshot {snapshot}")


def cmd_profiles(args) -> None:
    relays = _read(RELAYS_JSON, "relays")["read"]
    events, _ = _load_events(args.snapshot)
    authors = group_by_author(events)
    pubkeys = [pk for pk, evs in authors.items() if len(evs) >= args.min_posts]
    cache = asyncio.run(collect_profiles(relays, pubkeys, PROFILES_JSON, PICTURES,
                                         pictures=not args.no_pictures))
    found = sum(1 for pk in pubkeys if cache.get(pk, {}).get("found"))
    print(f"{len(cache)} profiles cached, {found}/{len(pubkeys)} of this run's authors have kind:0")


def cmd_detect(args) -> None:
    from .laya import Laya, ensure_model

    events, snap = _load_events(args.snapshot)
    authors = group_by_author(events)
    profiles = load_cache(PROFILES_JSON)
    targets = {pk: evs for pk, evs in authors.items() if len(evs) >= args.min_posts}
    skipped = len(authors) - len(targets)
    log.info("judging %d authors (%d skipped for having under %d posts)",
             len(targets), skipped, args.min_posts)

    laya = Laya(ensure_model(MODEL_DIR))
    rows = []
    started = time.time()
    order = sorted(targets, key=lambda pk: len(targets[pk]), reverse=True)
    for n, pk in enumerate(order, 1):
        evs = targets[pk]
        profile = profiles.get(pk) or {}
        feats = author_features(evs)
        try:
            verdict = judge(laya, evs, profile)
        except Exception as exc:
            log.warning("%s: %s", pk[:8], exc)
            verdict = {"error": str(exc)}
        # No model verdict means no verdict. The statistics used to stand in
        # here; they are description now, not a score.
        score = verdict.get("p_bot")
        rows.append({
            "pubkey": pk, "npub": encode_npub(pk),
            "score": score,
            "verdict": None if score is None else ("bot" if score >= BOT_THRESHOLD else "human"),
            "profile": {k: profile.get(k) for k in
                        ("bot", "name", "display_name", "about", "nip05",
                         "picture_url", "picture_local", "found")},
            "features": feats, "laya": verdict,
            "sample": [(e.get("content") or "")[:200] for e in evs[:5]],
        })
        if n % 20 == 0 or n == len(order):
            rate = n / max(1e-6, time.time() - started)
            log.info("judged %d/%d (%.1f/s)", n, len(order), rate)

    ok = [r for r in rows if "p_bot" in r["laya"]]
    bots = [r for r in rows if r["verdict"] == "bot"]
    rows.sort(key=lambda r: (r["score"] is None, -(r["score"] or 0)))
    _write(AUTHORS_JSON, {
        "version": __version__,
        "generated_at": int(time.time()),
        "snapshot": snap.get("snapshot"),
        "collected_at": snap.get("collected_at"),
        "threshold": BOT_THRESHOLD,
        "model": "mizchi/laya-multilingual-onnx",
        "notes": len(events), "authors_total": len(authors),
        "authors_judged": len(ok), "min_posts": args.min_posts,
        "authors": rows,
    })
    print(f"{len(ok)} judged, {len(bots)} over the {BOT_THRESHOLD} threshold "
          f"({len(bots) / max(1, len(ok)) * 100:.1f}%)")


def cmd_snapshots(args) -> None:
    rows = NoteCache(NOTE_CACHE).list_snapshots()
    total = len(NoteCache(NOTE_CACHE).ids())
    if not rows:
        print("no snapshots yet -- run ./bot-det collect")
        return
    print(f"\ncache: {total} kind:1 events\n")
    print(f"{'snapshot':18} {'collected':20} {'notes':>7} {'relays':>7} {'trials':>7}")
    print("-" * 64)
    for r in rows:
        when = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(r.get("collected_at", 0)))
        print(f"{r['id']:18} {when:20} {r.get('notes', 0):7} "
              f"{len(r.get('relays') or []):7} {r.get('trials', 0):7}")
    print(f"\nreplay one with: ./bot-det detect --snapshot {rows[-1]['id']}")
    print("score the whole cache with: ./bot-det detect --snapshot all")


def cmd_bench(args) -> None:
    """Time the same real authors on CPU and on CUDA."""
    import time

    from .detect import QUESTIONS, build_state
    from .laya import Laya, ensure_model

    events, _ = _load_events(args.snapshot)
    authors = group_by_author(events)
    profiles = load_cache(PROFILES_JSON)
    picks = sorted(authors.items(), key=lambda kv: -len(kv[1]))[: args.n]
    states = [build_state(evs, profiles.get(pk)) for pk, evs in picks]
    model = ensure_model(MODEL_DIR)

    combos = [("CPU", ["CPUExecutionProvider"])]
    import onnxruntime as ort
    if "CUDAExecutionProvider" in ort.get_available_providers():
        combos.append(("CUDA", ["CUDAExecutionProvider", "CPUExecutionProvider"]))

    print(f"\n{len(states)} authors, 5 questions each\n")
    for name, providers in combos:
        laya = Laya(model, providers=providers)
        active = laya.session.get_providers()[0]
        laya.predict(states[0], QUESTIONS)  # warm up kernels and allocators
        started = time.time()
        for state in states:
            result = laya.predict(state, QUESTIONS)
        elapsed = time.time() - started
        print(f"{name:5} {active:24} {elapsed / len(states) * 1000:7.0f} ms/author"
              f"   {len(states) / elapsed:6.2f} author/s")
    print(f"\nlast input: {result['usage']['input_tokens']} tokens")


def cmd_eval(args) -> None:
    from .laya import Laya, ensure_model

    events, _ = _load_events(args.snapshot)
    authors = group_by_author(events)
    profiles = load_cache(PROFILES_JSON)
    laya = Laya(ensure_model(MODEL_DIR))
    report = evaluate(laya, authors, profiles, min_posts=args.min_posts)
    _write(DATA / "eval.json", report)

    print(f"\nlabelled accounts: {report['n_bot']} bot:true, {report['n_human']} bot:false\n")
    head = f"{'scorer':16} {'AUC':>6} {'bot avg':>8} {'human avg':>10} " \
           f"{'recall@%.2f' % BOT_THRESHOLD:>12} {'FPR':>6} {'best t':>7} {'bal acc':>8}"
    print(head)
    print("-" * len(head))
    for name, s in report["scorers"].items():
        print(f"{name:16} {s['auc']:6.3f} {s['bot_mean']:8.3f} {s['human_mean']:10.3f} "
              f"{s['recall_at_default']:12.2f} {s['fpr_at_default']:6.2f} "
              f"{s['best_threshold']:7.3f} {s['balanced_accuracy']:8.3f}")


def cmd_all(args) -> None:
    cmd_relays(args)
    cmd_collect(args)
    cmd_profiles(args)
    cmd_detect(args)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="bot-det", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", action="version", version=f"laya-bot-det {__version__}")
    ap.add_argument("-v", "--verbose", action="store_true", help="log why relays failed")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def add(name, fn, help_):
        p = sub.add_parser(name, help=help_)
        p.set_defaults(fn=fn)
        return p

    add("model", cmd_model, "download the Laya ONNX bundle (650 MB, once)")
    add("snapshots", cmd_snapshots, "list cached kind:1 snapshots")

    p = add("relays", cmd_relays, "(1) read the relay list from your kind:10002")
    p.add_argument("--npub", default=DEFAULT_NPUB)

    p = add("collect", cmd_collect, "(2) sample kind:1 from those relays")
    p.add_argument("--trials", type=int, default=10)
    p.add_argument("--limit", type=int, default=100)

    p = add("profiles", cmd_profiles, "(4) fill the kind:0 and picture cache")
    p.add_argument("--min-posts", type=int, default=2)
    p.add_argument("--snapshot", default=None, metavar="ID",
                   help="a snapshot id, 'latest' (default) or 'all'")
    p.add_argument("--no-pictures", action="store_true")

    p = add("detect", cmd_detect, "(3) judge each author with Laya")
    p.add_argument("--min-posts", type=int, default=2)
    p.add_argument("--snapshot", default=None, metavar="ID",
                   help="re-score a past collection: a snapshot id, 'latest' or 'all'")

    p = add("bench", cmd_bench, "time CPU vs CUDA on real authors")
    p.add_argument("-n", type=int, default=20, help="how many authors to time")
    p.add_argument("--snapshot", default=None, metavar="ID")

    p = add("eval", cmd_eval, "score the detector against kind:0 bot:true labels")
    p.add_argument("--min-posts", type=int, default=2)
    p.add_argument("--snapshot", default=None, metavar="ID",
                   help="a snapshot id, 'latest' (default) or 'all'")

    p = add("all", cmd_all, "run every stage in order")
    p.add_argument("--npub", default=DEFAULT_NPUB)
    p.add_argument("--snapshot", default=None, metavar="ID")
    p.add_argument("--trials", type=int, default=10)
    p.add_argument("--limit", type=int, default=100)
    p.add_argument("--min-posts", type=int, default=2)
    p.add_argument("--no-pictures", action="store_true")

    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(message)s")
    logging.getLogger("websockets").setLevel(logging.WARNING)
    args.fn(args)


if __name__ == "__main__":
    main()
