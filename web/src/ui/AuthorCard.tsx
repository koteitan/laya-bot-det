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
  samples: string[];
  lastSeen: number;
}

function Avatar({ profile }: { profile: Profile | undefined }) {
  const [src, setSrc] = useState<string>("");
  const url = profile?.picture ?? "";
  useEffect(() => {
    let live = true;
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
  if (!src) return <div className="avatar" />;
  return (
    <img className="avatar" src={src} alt="" loading="lazy" onError={(e) => {
      // The cached copy or the origin is gone; drop back to an empty circle.
      e.currentTarget.replaceWith(Object.assign(document.createElement("div"), { className: "avatar" }));
    }} />
  );
}

function Bar({ label, value, blue }: { label: string; value: number | null; blue?: boolean }) {
  return (
    <>
      <span>{label}</span>
      <span className={blue ? "bar blue" : "bar"}>
        <span style={{ width: `${Math.min(Math.max(value ?? 0, 0), 1) * 100}%` }} />
      </span>
      <span className="num">{value === null ? "—" : value.toFixed(2)}</span>
    </>
  );
}

export function AuthorCard({ a, threshold, showPosts }: {
  a: Author;
  threshold: number;
  showPosts: boolean;
}) {
  const verdict = a.score >= threshold ? "bot" : "human";
  const name = a.profile?.display_name || a.profile?.name || a.npub.slice(0, 16) + "…";
  const f = a.features;
  return (
    <article className={`card ${verdict}`}>
      <div className="top">
        <Avatar profile={a.profile} />
        <div className="who">
          <div className="name">{name}</div>
          <div className="npub">{a.npub}</div>
          {a.profile?.about ? <div className="about">{a.profile.about}</div> : null}
        </div>
        <div className="verdict">
          <div className="tag">{verdict.toUpperCase()}</div>
          <div className="score">{a.score.toFixed(2)}</div>
        </div>
      </div>
      <div className="bars">
        <Bar label="合成" value={a.score} />
        <Bar label="Laya" value={a.laya?.pBot ?? null} blue />
        <Bar label="統計" value={a.heuristic.score} />
      </div>
      <div className="meta">
        {typeof a.profile?.bot === "boolean" ? (
          <span className={`badge label-${a.profile.bot ? "bot" : "human"}`}>
            NIP-24: bot={String(a.profile.bot)}
          </span>
        ) : null}
        {a.laya ? <span className="badge">{a.laya.category}</span> : null}
        <span>投稿 {f.posts}</span>
        {a.laya ? <span>定型 {a.laya.templated.toFixed(2)}</span> : null}
        {a.laya ? <span>会話 {a.laya.conversational.toFixed(2)}</span> : null}
        {f.regularity !== null ? <span>間隔の規則性 {f.regularity.toFixed(2)}</span> : null}
        {a.laya && a.laya.orderSpread > 0.15 ? (
          <span title="選択肢の順番で答えが変わった量">順序差 {a.laya.orderSpread.toFixed(2)}</span>
        ) : null}
      </div>
      {a.heuristic.reasons.length ? (
        <ul className="reasons">
          {a.heuristic.reasons.map((r) => <li key={r}>{r}</li>)}
        </ul>
      ) : null}
      {showPosts ? (
        <div className="posts">
          {a.samples.slice(0, 3).map((s, i) => <div key={i}>· {s.slice(0, 120)}</div>)}
        </div>
      ) : null}
    </article>
  );
}
