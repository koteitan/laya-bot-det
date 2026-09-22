"""Deterministic posting-behaviour statistics.

These used to carry a score of their own, weighted half and half with the
model's. That is gone: the judgement is the model's alone. What is left is
description -- how many posts, how evenly spaced, how often a reply -- reported
beside the verdict as context for it, never folded into it.

They are still kept out of the text handed to Laya, for the reason they always
were: a description that already says "posts on a fixed 10-minute schedule" has
made the decision, and the model would only be reading the answer back.
"""

import re
import statistics
from collections import Counter

URL_RE = re.compile(r"https?://\S+")
MENTION_RE = re.compile(r"(^|\s)@\w+")


def _norm(text: str) -> str:
    """Content with URLs and digits blanked, so templated posts collapse together."""
    text = URL_RE.sub(" URL ", text)
    text = re.sub(r"\d+", "#", text)
    return " ".join(text.split()).lower()


def author_features(events: list[dict]) -> dict:
    contents = [e.get("content") or "" for e in events]
    times = sorted(e.get("created_at", 0) for e in events)
    n = len(events)

    norms = [_norm(c) for c in contents]
    distinct_ratio = len(set(norms)) / n if n else 1.0
    top_template = Counter(norms).most_common(1)
    template_share = (top_template[0][1] / n) if (n and top_template) else 0.0

    gaps = [b - a for a, b in zip(times, times[1:]) if b - a >= 0]
    median_gap = statistics.median(gaps) if gaps else None
    # Regular schedules make every gap the same, so the spread of the gaps is the signal.
    if len(gaps) >= 3 and median_gap and median_gap > 0:
        mad = statistics.median([abs(g - median_gap) for g in gaps])
        regularity = max(0.0, 1.0 - (mad / median_gap))
    else:
        regularity = None

    lengths = [len(c) for c in contents]
    url_ratio = sum(1 for c in contents if URL_RE.search(c)) / n if n else 0.0
    reply_ratio = sum(
        1 for e in events
        if any(t and t[0] in ("e", "p") for t in e.get("tags", []))
        or MENTION_RE.search(e.get("content") or "")
    ) / n if n else 0.0

    return {
        "posts": n,
        "distinct_ratio": round(distinct_ratio, 4),
        "template_share": round(template_share, 4),
        "median_gap_sec": median_gap,
        "regularity": round(regularity, 4) if regularity is not None else None,
        "mean_length": round(statistics.mean(lengths), 1) if lengths else 0.0,
        "length_stdev": round(statistics.pstdev(lengths), 1) if len(lengths) > 1 else 0.0,
        "url_ratio": round(url_ratio, 4),
        "reply_ratio": round(reply_ratio, 4),
        "first_seen": times[0] if times else None,
        "last_seen": times[-1] if times else None,
    }
