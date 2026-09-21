/** Deterministic posting statistics, ported from `pipeline/features.py`.
 *
 *  These are kept out of the text handed to Laya on purpose: a description that
 *  already says "posts on a fixed schedule" would be handing the model the
 *  answer. Computed, scored and displayed separately so the two can disagree.
 */

export interface Features {
  posts: number;
  distinctRatio: number;
  templateShare: number;
  medianGapSec: number | null;
  regularity: number | null;
  meanLength: number;
  lengthStdev: number;
  urlRatio: number;
  replyRatio: number;
}

export interface Heuristic {
  score: number;
  reasons: string[];
}

export interface Note {
  id: string;
  pubkey: string;
  content: string;
  created_at: number;
  tags: string[][];
}

const URL_RE = /https?:\/\/\S+/;
const MENTION_RE = /(^|\s)@\w+/;

/** Content with URLs and digits blanked, so templated posts collapse together. */
const normalise = (text: string): string =>
  text.replace(new RegExp(URL_RE.source, "g"), " URL ").replace(/\d+/g, "#")
    .split(/\s+/).join(" ").trim().toLowerCase();

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function features(notes: Note[]): Features {
  const n = notes.length;
  const contents = notes.map((e) => e.content || "");
  const times = notes.map((e) => e.created_at).sort((a, b) => a - b);

  const norms = contents.map(normalise);
  const counts = new Map<string, number>();
  for (const s of norms) counts.set(s, (counts.get(s) ?? 0) + 1);
  const templateShare = n ? Math.max(...counts.values()) / n : 0;

  const gaps: number[] = [];
  for (let i = 1; i < times.length; i++) gaps.push(times[i]! - times[i - 1]!);
  const medianGap = gaps.length ? median(gaps) : null;
  // A schedule makes every gap the same, so the spread of the gaps is the signal.
  let regularity: number | null = null;
  if (gaps.length >= 3 && medianGap && medianGap > 0) {
    const mad = median(gaps.map((g) => Math.abs(g - medianGap)));
    regularity = Math.max(0, 1 - mad / medianGap);
  }

  const lengths = contents.map((c) => c.length);
  const mean = n ? lengths.reduce((a, b) => a + b, 0) / n : 0;
  const variance = n > 1 ? lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0;

  return {
    posts: n,
    distinctRatio: n ? new Set(norms).size / n : 1,
    templateShare,
    medianGapSec: medianGap,
    regularity,
    meanLength: mean,
    lengthStdev: Math.sqrt(variance),
    urlRatio: n ? contents.filter((c) => URL_RE.test(c)).length / n : 0,
    replyRatio: n
      ? notes.filter(
          (e) =>
            e.tags.some((t) => t[0] === "e" || t[0] === "p") || MENTION_RE.test(e.content || ""),
        ).length / n
      : 0,
  };
}

/** A transparent 0..1 bot score from the statistics alone, with its reasons.
 *  Weights are asserted, not fitted; with no labelled nostr data there is
 *  nothing here to fit them on. It exists as a control for the model. */
export function heuristicScore(f: Features): Heuristic {
  const reasons: string[] = [];
  let score = 0;
  const pct = (x: number) => Math.round(x * 100);

  if (f.posts >= 3) {
    if (f.templateShare >= 0.6) {
      score += 0.35;
      reasons.push(`投稿の ${pct(f.templateShare)}% が同じテンプレート`);
    } else if (f.templateShare >= 0.3) {
      score += 0.15;
      reasons.push(`投稿の ${pct(f.templateShare)}% が同じテンプレート`);
    }
    if (f.distinctRatio <= 0.5) {
      score += 0.2;
      reasons.push(`異なる投稿は ${pct(f.distinctRatio)}% だけ`);
    }
  }
  if (f.regularity !== null && f.regularity >= 0.8 && f.posts >= 4) {
    score += 0.25;
    reasons.push(`ほぼ等間隔で投稿 (規則性 ${f.regularity.toFixed(2)})`);
  }
  if (f.urlRatio >= 0.9 && f.posts >= 3) {
    score += 0.1;
    reasons.push("ほぼ全ての投稿にリンク");
  }
  if (f.replyRatio <= 0.05 && f.posts >= 5) {
    score += 0.1;
    reasons.push("誰にも返信していない");
  } else if (f.replyRatio >= 0.5) {
    score -= 0.15;
    reasons.push(`投稿の ${pct(f.replyRatio)}% が返信`);
  }
  if (f.posts >= 4 && f.lengthStdev <= 3 && f.meanLength > 0) {
    score += 0.1;
    reasons.push("投稿の長さがほぼ変わらない");
  }
  return { score: Math.min(Math.max(score, 0), 1), reasons };
}
