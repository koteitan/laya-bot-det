/** Deterministic posting statistics, ported from `pipeline/features.py`.
 *
 *  These used to carry a score of their own, weighted half and half with the
 *  model's. That is gone: the judgement is Laya's alone now. What is left is
 *  description -- how many posts, how evenly spaced, how often a reply -- shown
 *  next to the verdict as context for it, never folded into it.
 *
 *  They are still kept out of the text handed to Laya, for the reason they
 *  always were: a description that already says "posts on a fixed schedule"
 *  would be handing the model the answer.
 */

export interface Features {
  posts: number;
  distinctRatio: number;
  templateShare: number;
  medianGapSec: number | null;
  regularity: number | null;
  meanLength: number;
  urlRatio: number;
  replyRatio: number;
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
  text
    .replace(new RegExp(URL_RE.source, "g"), " URL ")
    .replace(/\d+/g, "#")
    .split(/\s+/)
    .join(" ")
    .trim()
    .toLowerCase();

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
  return {
    posts: n,
    distinctRatio: n ? new Set(norms).size / n : 1,
    templateShare: n ? Math.max(...counts.values()) / n : 0,
    medianGapSec: medianGap,
    regularity,
    meanLength: n ? lengths.reduce((a, b) => a + b, 0) / n : 0,
    urlRatio: n ? contents.filter((c) => URL_RE.test(c)).length / n : 0,
    replyRatio: n
      ? notes.filter(
          (e) =>
            e.tags.some((t) => t[0] === "e" || t[0] === "p") || MENTION_RE.test(e.content || ""),
        ).length / n
      : 0,
  };
}
