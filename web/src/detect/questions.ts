/** What Laya is asked about each author, ported from `pipeline/detect.py`.
 *
 *  The design was settled by measurement against the only ground truth nostr
 *  offers: `"bot": true` in an account's own kind:0 (NIP-24). On a sample of
 *  4,352 notes that gave 31 self-declared bots and 8 self-declared humans, AUC:
 *
 *    noul "these are bot posts"     0.52   choice {human, bot}          0.67
 *    state = 12 posts               0.669  state = profile only         0.790
 *    state = profile + posts        0.819  <- used
 *    criteria as sentences          0.383  two short labels             0.819
 *    deterministic statistics alone 0.839  0.5 * laya + 0.5 * stats     0.907
 *
 *  Elaborate criteria made the model worse than chance; short labels won. The
 *  statistics beat the model on their own, so the page shows all three numbers.
 *
 *  The scores are not calibrated: this checkpoint ships `temperature = [1,1,1]`
 *  and an empty `temperature_by_options`, making the calibration step the
 *  identity. Ranking is meaningful, absolute values are not.
 */

import type { Question, State } from "../laya/vendor/types.ts";
import type { Note } from "./features.ts";
import type { Profile } from "../nostr/cache.ts";

const POST_LIMIT = 12;
const POST_CHARS = 140;
const PROFILE_CHARS = 200;

/** Fitted on those 39 labelled accounts; no held-out set behind them. */
export const LAYA_WEIGHT = 0.5;
export const BOT_THRESHOLD = 0.63;

const clean = (text: string, limit: number): string => {
  const s = (text || "").split(/\s+/).join(" ").trim();
  return s.length > limit ? s.slice(0, limit) + "…" : s;
};

/** max_len is 1024 tokens and the question head takes up to 256, leaving about
 *  760 for the state; 12 posts of 140 characters fits in Japanese and English. */
export function buildState(notes: Note[], profile: Profile | undefined): State {
  const parts: string[] = [];
  if (profile) {
    const fields: [string, string][] = [
      ["display_name", profile.display_name],
      ["name", profile.name],
      ["nip05", profile.nip05],
      ["about", profile.about],
    ];
    for (const [key, value] of fields) {
      const v = clean(value, PROFILE_CHARS);
      if (v) parts.push(`${key}: ${v}`);
    }
  }
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const note of notes) {
    const content = clean(note.content, POST_CHARS);
    if (!content || seen.has(content)) continue;
    seen.add(content);
    lines.push(`- ${content}`);
    if (lines.length >= POST_LIMIT) break;
  }
  if (lines.length) parts.push("posts:\n" + lines.join("\n"));
  return parts.join("\n");
}

const HUMAN = "a human";
const BOT = "an automated bot";
const WHOSE = "Whose nostr account is this?";

// max_prefixes in the checkpoint config is 6, so no choice question exceeds six options.
export const QUESTIONS: Record<string, Question> = {
  // The same question in both option orders; the order measurably changes the
  // answer for individual accounts, so both are asked and averaged.
  bot_hb: { type: "choice", instructions: WHOSE, criteria: { human: HUMAN, bot: BOT } },
  bot_bh: { type: "choice", instructions: WHOSE, criteria: { bot: BOT, human: HUMAN } },
  category: {
    type: "choice",
    instructions: "What kind of account is this?",
    criteria: {
      person: "a person talking about their own life",
      news: "an automated feed of news headlines or article links",
      data: "automated numeric updates such as prices, weather or alerts",
      bridge: "a mirror relaying posts from another platform",
      spam: "repetitive advertising or scam messages",
      art: "an account that only posts images or media",
    },
  },
  templated: {
    type: "noul",
    instructions:
      "Every post follows the same fixed template, with only numbers, names or links changed.",
    criteria: {
      true: "The posts share one rigid format.",
      false: "The posts vary freely in structure and wording.",
    },
  },
  conversational: {
    type: "noul",
    instructions: "The author talks to other people in these posts.",
    criteria: {
      true: "Replies, mentions, questions to others.",
      false: "Broadcasts only, never addressed to anyone.",
    },
  },
};

/** 0.5 * model + 0.5 * statistics. Alone they score 0.819 and 0.839; together 0.907. */
export const combinedScore = (pBot: number | null, heuristic: number): number =>
  pBot === null ? heuristic : LAYA_WEIGHT * pBot + (1 - LAYA_WEIGHT) * heuristic;
