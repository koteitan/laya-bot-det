"""What Laya is actually asked about each author, and why it is asked that way.

Every choice below was settled by measurement against the only ground truth
nostr offers here: `"bot": true` in an account's own kind:0 (NIP-24). In one
4,352-note sample that gave 31 self-declared bots and 8 self-declared humans.
AUC against those labels:

    question type   noul "these are bot posts"            0.52  (the noul head
                                                                 answers "true"
                                                                 to nearly
                                                                 anything here)
                    choice {human, bot}                   0.67
    state           12 posts                              0.669
                    5 posts                               0.645
                    kind:0 profile only                   0.790
                    profile + posts                       0.819  <- used
    criteria text   one-sentence descriptions             0.383  (below chance)
                    two short labels                      0.819  <- used
    label wording   "a human" / "an automated bot"        best of those tried
    option order    changes the answer per account, so both orders are asked
                    and averaged

Elaborate criteria made the model *worse than chance* here; short labels won.

The deterministic statistics in `features.py` used to carry half the weight of
the verdict, and scored 0.839 alone against the model's 0.819, with the blend
reaching 0.907. They no longer score anything: the judgement is the model's,
and the statistics are description shown beside it. That costs accuracy on the
labelled set, and was chosen anyway -- one scorer that can be reasoned about
beats two that have to be reconciled.

Sample-size warning: 39 labelled accounts, 8 of them negative, and the blend
weight and thresholds were chosen on that same set with nothing held out. The
ranking is worth more than the absolute numbers.

The probabilities are also uncalibrated. This checkpoint ships
`temperature = [1, 1, 1]` and an empty `temperature_by_options`, so the
calibration step upstream advertises is the identity function here.
"""

import re

# max_prefixes in the checkpoint config is 6, so no choice question exceeds six options.
POST_LIMIT = 12
POST_CHARS = 140
PROFILE_CHARS = 200

# Fitted for the model's score alone, on 46 labelled accounts (30 bot, 16 human).
#
# 0.63 was fitted for the blend of model and statistics and does not survive
# their removal: the model's own score sits high for almost everything, so known
# humans average 0.751 against bots' 0.834, and cutting at 0.63 calls 62% of the
# humans bots. Only the very top of the range separates them:
#
#   threshold   recall   false positives   precision
#   0.63        0.77     0.62              0.70
#   0.95        0.60     0.31              0.78
#   0.99        0.50     0.12              0.88
#   0.995       0.50     0.06              0.94
#
# 0.99 is the trade taken: half the declared bots, and a human flagged about one
# time in eight. Missing half of them is the price of not accusing people. The
# page exposes this as a slider, because where that line belongs is a policy
# choice and not a measurement.
BOT_THRESHOLD = 0.99

WS_RE = re.compile(r"\s+")


def _clean(text: str, limit: int) -> str:
    text = WS_RE.sub(" ", text or "").strip()
    return text[:limit] + "…" if len(text) > limit else text


def build_post_lines(events: list[dict]) -> str:
    """Newest distinct posts as a bulleted list.

    max_len is 1024 tokens and the question head takes up to 256, leaving roughly
    760 for the state; 12 posts capped at 140 characters fits with room to spare
    in both Japanese (~2 chars/token) and English (~4).
    """
    seen: set[str] = set()
    lines = []
    for ev in events:
        content = _clean(ev.get("content") or "", POST_CHARS)
        if not content or content in seen:
            continue
        seen.add(content)
        lines.append(f"- {content}")
        if len(lines) >= POST_LIMIT:
            break
    return "\n".join(lines)


def build_profile_lines(profile: dict | None) -> str:
    if not profile:
        return ""
    parts = []
    for key in ("display_name", "name", "nip05", "about"):
        value = _clean(profile.get(key) or "", PROFILE_CHARS)
        if value:
            parts.append(f"{key}: {value}")
    return "\n".join(parts)


def build_state(events: list[dict], profile: dict | None) -> str:
    """The profile block, then the posts. Scored 0.819 against 0.669 for posts alone."""
    profile_block = build_profile_lines(profile)
    posts_block = build_post_lines(events)
    if not posts_block and not profile_block:
        return ""
    if not profile_block:
        return "posts:\n" + posts_block
    if not posts_block:
        return profile_block
    return f"{profile_block}\nposts:\n{posts_block}"


HUMAN = "a human"
BOT = "an automated bot"
WHOSE = "Whose nostr account is this?"

QUESTIONS = {
    # The same question in both option orders; the average is the score we use,
    # because the order measurably changes the answer for individual accounts.
    "bot_hb": {"type": "choice", "instructions": WHOSE,
               "criteria": {"human": HUMAN, "bot": BOT}},
    "bot_bh": {"type": "choice", "instructions": WHOSE,
               "criteria": {"bot": BOT, "human": HUMAN}},
    # "spam" was one of these and is not any more. A choice question always
    # returns one of its options, so an account fitting none of them still gets
    # the nearest label -- and this one landed on accounts scoring 0.003, as
    # human as the model gets. Calling a person a spammer on a guess is a harm
    # the other labels do not carry; being wrong about "news" versus "data" is not.
    "category": {"type": "choice", "instructions": "What kind of account is this?",
                 "criteria": {
                     "person": "a person talking about their own life",
                     "news": "an automated feed of news headlines or article links",
                     "data": "automated numeric updates such as prices, weather or alerts",
                     "bridge": "a mirror relaying posts from another platform",
                     "art": "an account that only posts images or media",
                 }},
    "templated": {"type": "noul",
                  "instructions": "Every post follows the same fixed template, with only "
                                  "numbers, names or links changed.",
                  "criteria": {"true": "The posts share one rigid format.",
                               "false": "The posts vary freely in structure and wording."}},
    "conversational": {"type": "noul",
                       "instructions": "The author talks to other people in these posts.",
                       "criteria": {"true": "Replies, mentions, questions to others.",
                                    "false": "Broadcasts only, never addressed to anyone."}},
}


def judge(laya, events: list[dict], profile: dict | None = None) -> dict:
    """All five questions in one batched forward pass."""
    state = build_state(events, profile)
    if not state:
        return {"error": "no usable text"}
    result = laya.predict(state, QUESTIONS)
    ans = result["answers"]
    hb = ans["bot_hb"]["probabilities"]["bot"]
    bh = ans["bot_bh"]["probabilities"]["bot"]
    return {
        "p_bot": round((hb + bh) / 2, 4),
        "order_spread": round(abs(hb - bh), 4),
        "category": ans["category"]["choice"],
        "category_probabilities": ans["category"]["probabilities"],
        "templated": ans["templated"]["noul"],
        "conversational": ans["conversational"]["noul"],
        "input_tokens": result["usage"]["input_tokens"],
    }
