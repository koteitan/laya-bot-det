import { useEffect, useState } from "react";
import { cachePicture, type Profile } from "../nostr/cache.ts";
import type { Features, Heuristic } from "../detect/features.ts";

export interface LayaVerdict {
  pBot: number;
  orderSpread: number;
  category: string;
  templated: number;
  conversational: number;
}

export interface Author {
  pubkey: string;
  npub: string;
  profile: Profile | undefined;
  features: Features;
  heuristic: Heuristic;
  laya: LayaVerdict | null;
  score: number;
  lastSeen: number;
}

function Avatar({ profile }: { profile: Profile | undefined }) {
  const [src, setSrc] = useState<string>("");
  const [failed, setFailed] = useState(false);
  const url = profile?.picture ?? "";
  useEffect(() => {
    let live = true;
    setFailed(false);
    if (!url) {
      setSrc("");
      return;
    }
    void cachePicture(url).then((resolved) => {
      if (live) setSrc(resolved);
    });
    return () => {
      live = false;
    };
  }, [url]);
  // A broken image becomes an empty circle through state, not by swapping the
  // node out from under React -- replaceWith leaves the tree React thinks it
  // rendered and the one in the document disagreeing, and the next update throws.
  if (!src || failed) return <div className="avatar" />;
  return (
    <img className="avatar" src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
  );
}

const n2 = (v: number | null | undefined): string => (v == null ? "—" : v.toFixed(2));

export function AuthorCard({ a, threshold }: { a: Author; threshold: number }) {
  const verdict = a.score >= threshold ? "bot" : "human";
  const name = a.profile?.display_name || a.profile?.name || a.npub.slice(0, 16) + "…";
  const f = a.features;
  return (
    <article className={`card ${verdict}`}>
      <div className="top">
        <Avatar profile={a.profile} />
        <div className="who">
          {/* The verdict sits on the name's line. Pushed to the far right it
              was separated from the avatar and name by the full card width. */}
          <div className="headline">
            <span className="name">{name}</span>
            <span className="tag">{verdict.toUpperCase()}</span>
            <span className="score">{a.score.toFixed(2)}</span>
          </div>
          <div className="npub">
            <a href={`https://nostx.io/${a.npub}`} target="_blank" rel="noreferrer">
              {a.npub}
            </a>
          </div>
          {a.profile?.about ? <div className="about">{a.profile.about}</div> : null}
        </div>
      </div>
      <div className="scores">
        合成 <b>{n2(a.score)}</b> ・ Laya <b>{n2(a.laya?.pBot)}</b> ・ 統計{" "}
        <b>{n2(a.heuristic.score)}</b>
      </div>
      <div className="meta">
        {typeof a.profile?.bot === "boolean" ? (
          <span className={`badge label-${a.profile.bot ? "bot" : "human"}`}>
            NIP-24: bot={String(a.profile.bot)}
          </span>
        ) : null}
        {a.laya ? <span className="badge">{a.laya.category}</span> : null}
        <span>投稿 {f.posts}</span>
        {a.laya ? <span>定型 {n2(a.laya.templated)}</span> : null}
        {a.laya ? <span>会話 {n2(a.laya.conversational)}</span> : null}
        {f.regularity !== null ? <span>間隔の規則性 {n2(f.regularity)}</span> : null}
        {a.laya && a.laya.orderSpread > 0.15 ? (
          <span title="選択肢の順番で答えが変わった量">順序差 {n2(a.laya.orderSpread)}</span>
        ) : null}
      </div>
      {a.heuristic.reasons.length ? (
        <ul className="reasons">
          {a.heuristic.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      ) : null}
    </article>
  );
}
