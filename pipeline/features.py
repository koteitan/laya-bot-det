"""Deterministic posting-behaviour statistics.

These are kept out of the text handed to Laya on purpose. A planner that writes
"posts on a fixed 10-minute schedule" into the option text has already made the
decision, and the model would only be reading the answer back. Here the
statistics are computed, reported and scored separately, so the UI can show what
the arithmetic says and what the model says side by side, and they can disagree.
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


def heuristic_score(f: dict) -> dict:
    """A transparent 0..1 bot score from the statistics alone, with its reasons.

    Deliberately simple and auditable: it exists as a control for the model, not
    as a tuned classifier. Weights are asserted, not fitted -- with no labelled
    nostr data there is nothing here to fit them on.
    """
    reasons = []
    score = 0.0
    if f["posts"] >= 3:
        if f["template_share"] >= 0.6:
            score += 0.35
            reasons.append(f"{int(f['template_share'] * 100)}% of posts share one template")
        elif f["template_share"] >= 0.3:
            score += 0.15
            reasons.append(f"{int(f['template_share'] * 100)}% of posts share one template")
        if f["distinct_ratio"] <= 0.5:
            score += 0.2
            reasons.append(f"only {int(f['distinct_ratio'] * 100)}% of posts are distinct")
    if f["regularity"] is not None and f["regularity"] >= 0.8 and f["posts"] >= 4:
        score += 0.25
        reasons.append(f"posts on a near-fixed interval (regularity {f['regularity']:.2f})")
    if f["url_ratio"] >= 0.9 and f["posts"] >= 3:
        score += 0.1
        reasons.append("almost every post carries a link")
    if f["reply_ratio"] <= 0.05 and f["posts"] >= 5:
        score += 0.1
        reasons.append("never replies to anyone")
    elif f["reply_ratio"] >= 0.5:
        score -= 0.15
        reasons.append(f"replies to others in {int(f['reply_ratio'] * 100)}% of posts")
    if f["posts"] >= 4 and f["length_stdev"] <= 3 and f["mean_length"] > 0:
        score += 0.1
        reasons.append("post length barely varies")
    return {"score": round(min(max(score, 0.0), 1.0), 4), "reasons": reasons}
