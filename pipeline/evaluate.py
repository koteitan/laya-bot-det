"""Score the detector against NIP-24 self-declared labels.

kind:0 may carry `"bot": true`. Accounts that set it are the only ground truth
available here, and it is a one-sided label: a bot that declares itself is
labelled, a bot that does not is indistinguishable from a human in this set.
So recall on `bot: true` is measurable, while the false-positive rate is only
measurable against the handful of accounts that explicitly set `"bot": false`.
"""

import logging

from .detect import BOT_THRESHOLD, judge


log = logging.getLogger(__name__)


def roc_auc(pos: list[float], neg: list[float]) -> float | None:
    """Probability that a random positive outranks a random negative; ties count half."""
    if not pos or not neg:
        return None
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def best_threshold(pos: list[float], neg: list[float]) -> tuple[float, float]:
    """The cut that maximises balanced accuracy, and that accuracy."""
    if not pos or not neg:
        return BOT_THRESHOLD, 0.0
    best = (BOT_THRESHOLD, 0.0)
    for t in sorted({round(v, 3) for v in pos + neg} | {0.0, 1.0}):
        tpr = sum(1 for p in pos if p >= t) / len(pos)
        tnr = sum(1 for n in neg if n < t) / len(neg)
        bal = (tpr + tnr) / 2
        if bal > best[1]:
            best = (t, bal)
    return best


def evaluate(laya, authors: dict[str, list[dict]], profiles: dict, min_posts: int = 2) -> dict:
    labelled = [
        (pk, evs, profiles[pk])
        for pk, evs in authors.items()
        if len(evs) >= min_posts
        and pk in profiles
        and isinstance(profiles[pk].get("bot"), bool)
    ]
    log.info("%d accounts carry a NIP-24 bot flag and have >= %d posts", len(labelled), min_posts)

    rows = []
    for n, (pk, evs, profile) in enumerate(labelled, 1):
        try:
            verdict = judge(laya, evs, profile)
        except Exception as exc:
            log.warning("%s: %s", pk[:8], exc)
            continue
        if "p_bot" not in verdict:
            continue
        rows.append({
            "pubkey": pk,
            "label": bool(profile["bot"]),
            "name": profile.get("name") or "",
            "posts": len(evs),
            "p_bot": verdict["p_bot"],
            "category": verdict["category"],
            "templated": verdict["templated"],
        })
        if n % 10 == 0 or n == len(labelled):
            log.info("evaluated %d/%d", n, len(labelled))

    pos = [r for r in rows if r["label"]]
    neg = [r for r in rows if not r["label"]]
    report = {"n_bot": len(pos), "n_human": len(neg), "rows": rows, "scorers": {}}
    for key in ("p_bot",):
        p = [r[key] for r in pos if r.get(key) is not None]
        q = [r[key] for r in neg if r.get(key) is not None]
        if not p or not q:
            continue
        t, bal = best_threshold(p, q)
        report["scorers"][key] = {
            "auc": roc_auc(p, q),
            "bot_mean": sum(p) / len(p),
            "human_mean": sum(q) / len(q),
            "recall_at_default": sum(1 for v in p if v >= BOT_THRESHOLD) / len(p),
            "fpr_at_default": sum(1 for v in q if v >= BOT_THRESHOLD) / len(q),
            "best_threshold": t,
            "balanced_accuracy": bal,
        }
    return report
