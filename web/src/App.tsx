import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Subscription } from "rxjs";
import {
  discoverRelays,
  fetchProfiles,
  seedNotes,
  streamNotes,
  type RelayList,
} from "./nostr/client.ts";
import {
  cachedProfileCount,
  clearCache,
  getProfile,
  hasProfile,
  putProfile,
} from "./nostr/cache.ts";
import { decodeNpub, encodeNpub } from "./nostr/nip19.ts";
import { features, heuristicScore, type Note } from "./detect/features.ts";
import { buildState, combinedScore, QUESTIONS } from "./detect/questions.ts";
import { hasWebGPU, load, MODEL_BYTES } from "./laya/load.ts";
import type { LayaAgent } from "./laya/vendor/agent.ts";
import { AuthorCard, type Author, type LayaVerdict } from "./ui/AuthorCard.tsx";
import { Menu } from "./ui/Menu.tsx";
import { loadSettings, saveSettings, type Settings } from "./settings.ts";

const DEFAULT_NPUB = "npub1f3w4x7dqvceeez8kuyq78md3lwhwfm0ra634llr0r3nykwjrs0hqvldhgk";
const MIN_POSTS = 2;
/** Enough for the 12 the model sees and for the interval statistics; a live
 *  stream would otherwise grow without bound. */
const MAX_NOTES_PER_AUTHOR = 30;
const REBUILD_MS = 1000;

type LayaState =
  | { kind: "idle" }
  | { kind: "loading"; received: number; total: number }
  | { kind: "ready"; provider: string; judged: number }
  | { kind: "error"; message: string };

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [menuOpen, setMenuOpen] = useState(false);
  const [relays, setRelays] = useState<RelayList | null>(null);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [laya, setLaya] = useState<LayaState>({ kind: "idle" });
  const [noteCount, setNoteCount] = useState(0);

  const notesRef = useRef(new Map<string, Note[]>());
  const judgedRef = useRef(new Map<string, { at: number; verdict: LayaVerdict }>());
  const agentRef = useRef<LayaAgent | null>(null);
  const askedProfiles = useRef(new Set<string>());

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("light", !settings.dark);
  }, [settings.dark]);

  // 1. Relay list from kind:10002 (backward), then the note stream from it.
  useEffect(() => {
    let pubkey: string;
    try {
      pubkey = decodeNpub(DEFAULT_NPUB);
    } catch {
      return;
    }
    const sub = discoverRelays(pubkey).subscribe({
      next: (list) => setRelays(list),
      error: () => setRelays({ source: "fallback", read: [] }),
    });
    return () => sub.unsubscribe();
  }, []);

  useEffect(() => {
    if (!relays?.read.length) return;

    const take = (event: Note) => {
      const list = notesRef.current.get(event.pubkey) ?? [];
      if (list.some((e) => e.id === event.id)) return;
      list.push(event);
      list.sort((a, b) => b.created_at - a.created_at);
      notesRef.current.set(event.pubkey, list.slice(0, MAX_NOTES_PER_AUTHOR));
    };

    const subs: Subscription[] = [streamNotes(relays.read).subscribe({ next: take })];
    // Forward alone shows nothing until new notes arrive; this seeds the view.
    if (settings.seed) subs.push(seedNotes(relays.read).subscribe({ next: take }));
    return () => subs.forEach((s) => s.unsubscribe());
  }, [relays, settings.seed]);

  // 2. Rebuild the rendered list on a timer rather than per event.
  useEffect(() => {
    const id = setInterval(() => {
      const rows: Author[] = [];
      let total = 0;
      for (const [pubkey, notes] of notesRef.current) {
        total += notes.length;
        if (notes.length < MIN_POSTS) continue;
        const f = features(notes);
        const h = heuristicScore(f);
        const judged = judgedRef.current.get(pubkey);
        rows.push({
          pubkey,
          npub: encodeNpub(pubkey),
          profile: getProfile(pubkey),
          features: f,
          heuristic: h,
          laya: judged?.verdict ?? null,
          score: combinedScore(judged?.verdict.pBot ?? null, h.score),
          samples: notes.map((n) => n.content),
          lastSeen: notes[0]?.created_at ?? 0,
        });
      }
      setNoteCount(total);
      setAuthors(rows);
    }, REBUILD_MS);
    return () => clearInterval(id);
  }, []);

  // 3. kind:0 for authors we have not cached yet.
  useEffect(() => {
    if (!relays?.read.length) return;
    const id = setInterval(() => {
      const missing: string[] = [];
      for (const [pubkey, notes] of notesRef.current) {
        if (notes.length < MIN_POSTS) continue;
        if (hasProfile(pubkey) || askedProfiles.current.has(pubkey)) continue;
        askedProfiles.current.add(pubkey);
        missing.push(pubkey);
      }
      if (!missing.length) return;
      const sub = fetchProfiles(relays.read, missing).subscribe({
        next: (event) => putProfile(event.pubkey, event),
        error: () => undefined,
      });
      setTimeout(() => sub.unsubscribe(), 20_000);
    }, 4000);
    return () => clearInterval(id);
  }, [relays]);

  // 4. Judge with Laya, one author at a time, once the model is ready.
  useEffect(() => {
    if (laya.kind !== "ready") return;
    let stop = false;
    void (async () => {
      while (!stop) {
        const agent = agentRef.current;
        if (!agent) return;
        let target: string | null = null;
        for (const [pubkey, notes] of notesRef.current) {
          if (notes.length < MIN_POSTS) continue;
          const done = judgedRef.current.get(pubkey);
          // Rejudge only when meaningfully more material has arrived.
          if (done && notes.length < done.at * 2) continue;
          target = pubkey;
          break;
        }
        if (!target) {
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        const notes = notesRef.current.get(target)!;
        try {
          const result = await agent.predict(buildState(notes, getProfile(target)), QUESTIONS);
          const a = result.answers;
          const hb = a.bot_hb?.type === "choice" ? a.bot_hb.probabilities.bot ?? 0 : 0;
          const bh = a.bot_bh?.type === "choice" ? a.bot_bh.probabilities.bot ?? 0 : 0;
          judgedRef.current.set(target, {
            at: notes.length,
            verdict: {
              pBot: (hb + bh) / 2,
              orderSpread: Math.abs(hb - bh),
              category: a.category?.type === "choice" ? a.category.choice : "?",
              templated: a.templated?.type === "noul" ? a.templated.noul : 0,
              conversational: a.conversational?.type === "noul" ? a.conversational.noul : 0,
            },
          });
          setLaya((s) => (s.kind === "ready" ? { ...s, judged: judgedRef.current.size } : s));
        } catch {
          // One bad author must not stop the queue; mark it done and move on.
          judgedRef.current.set(target, {
            at: notes.length,
            verdict: { pBot: 0, orderSpread: 0, category: "?", templated: 0, conversational: 0 },
          });
        }
      }
    })();
    return () => {
      stop = true;
    };
  }, [laya.kind]);

  const startLaya = useCallback(() => {
    setLaya({ kind: "loading", received: 0, total: MODEL_BYTES });
    void load((p) => {
      setLaya((s) =>
        s.kind === "loading" ? { kind: "loading", received: p.received, total: p.total ?? MODEL_BYTES } : s,
      );
    })
      .then(({ agent, provider }) => {
        agentRef.current = agent;
        setLaya({ kind: "ready", provider, judged: 0 });
      })
      .catch((e: unknown) => {
        setLaya({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      });
  }, []);

  const shown = useMemo(() => {
    const t = settings.threshold;
    let rows = authors;
    if (settings.filter === "bot") rows = rows.filter((a) => a.score >= t);
    else if (settings.filter === "human") rows = rows.filter((a) => a.score < t);
    else if (settings.filter === "labelled")
      rows = rows.filter((a) => typeof a.profile?.bot === "boolean");
    else if (settings.filter === "disagree")
      rows = rows.filter((a) => a.laya && Math.abs(a.laya.pBot - a.heuristic.score) >= 0.4);
    const key: Record<Settings["sort"], (a: Author) => number> = {
      score: (a) => a.score,
      laya: (a) => a.laya?.pBot ?? -1,
      heuristic: (a) => a.heuristic.score,
      posts: (a) => a.features.posts,
      recent: (a) => a.lastSeen,
    };
    return [...rows].sort((x, y) => key[settings.sort](y) - key[settings.sort](x));
  }, [authors, settings.threshold, settings.filter, settings.sort]);

  const bots = authors.filter((a) => a.score >= settings.threshold).length;

  return (
    <>
      <header>
        <h1>laya-bot-det</h1>
        <p className="summary">
          {relays === null
            ? "リレーを探しています…"
            : `${relays.source} / ${relays.read.length} リレー ・ ${noteCount} notes ・ ` +
              `${authors.length} authors ・ bot ${bots} (しきい値 ${settings.threshold.toFixed(2)})`}
        </p>
        <LayaStatus state={laya} onStart={startLaya} />
        <Menu
          open={menuOpen}
          onToggle={() => setMenuOpen((v) => !v)}
          settings={settings}
          onChange={update}
          onClearCache={() => {
            clearCache();
            askedProfiles.current.clear();
          }}
          cachedProfiles={cachedProfileCount()}
        />
      </header>
      <main>
        {shown.map((a) => (
          <AuthorCard key={a.pubkey} a={a} threshold={settings.threshold} showPosts={settings.showPosts} />
        ))}
        {!shown.length ? (
          <p className="empty">
            投稿が {MIN_POSTS} 件以上たまった author から表示されます。
          </p>
        ) : null}
      </main>
      <footer>
        <p>
          判定は Laya (mmBERT-base 322M, WebGPU) と決定的な投稿統計の合成。
          スコアは較正されていないので、順位には意味があるが絶対値にはない。
          {" "}
          <a href="https://github.com/koteitan/laya-bot-det">ソース</a>
        </p>
      </footer>
    </>
  );
}

function LayaStatus({ state, onStart }: { state: LayaState; onStart: () => void }) {
  if (state.kind === "idle") {
    return (
      <p className="laya-status">
        いまは<b>統計のみ</b>で判定中。Laya を足すには {Math.round(MODEL_BYTES / 1e6)} MB の
        ダウンロードが要ります（初回だけ。以降はブラウザのキャッシュ）。{" "}
        <button onClick={onStart}>Laya を読み込む</button>
        {!hasWebGPU() ? " ※ WebGPU が無いので WASM で動きます（かなり遅い）" : null}
      </p>
    );
  }
  if (state.kind === "loading") {
    const pct = state.total ? Math.min(100, (state.received / state.total) * 100) : 0;
    return (
      <p className="laya-status">
        Laya を読み込み中 {pct.toFixed(0)}% ({Math.round(state.received / 1e6)} /{" "}
        {Math.round(state.total / 1e6)} MB)
      </p>
    );
  }
  if (state.kind === "error") {
    return <p className="laya-status error">Laya の読み込みに失敗: {state.message}</p>;
  }
  return (
    <p className="laya-status">
      Laya 稼働中 ({state.provider}) ・ {state.judged} authors 判定済み
    </p>
  );
}
