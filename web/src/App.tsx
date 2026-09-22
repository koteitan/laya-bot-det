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
import { memoryWarning } from "./laya/capability.ts";
import { clearTrace, crashed, format, mark, trace } from "./laya/trace.ts";
import { ortVersion, selfTest, type SelfTestResult } from "./laya/selftest.ts";
import {
  cachedProgress,
  clearModelCache,
  hasWebGPU,
  load,
  MODEL_BYTES,
  MODEL_URL,
  TOKENIZER_BYTES,
  usingCustomModel,
  type Phase,
} from "./laya/load.ts";
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
  | { kind: "idle"; cached: number; total: number }
  | { kind: "loading"; phase: Phase; received: number; total: number }
  | { kind: "ready"; provider: string; judged: number; totalMs: number }
  | { kind: "error"; phase: Phase; received: number; message: string };

export function App() {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [menuOpen, setMenuOpen] = useState(false);
  const [relays, setRelays] = useState<RelayList | null>(null);
  const [authors, setAuthors] = useState<Author[]>([]);
  const [laya, setLaya] = useState<LayaState>({ kind: "idle", cached: 0, total: MODEL_BYTES + TOKENIZER_BYTES });
  const [noteCount, setNoteCount] = useState(0);
  // How many authors have enough posts to be judged at all, so the progress
  // reads as a fraction of the work rather than a bare count.
  const [eligible, setEligible] = useState(0);
  // A run that never reached "done" left its marks behind; show them, since the
  // crash took the console with it.
  const [showTrace, setShowTrace] = useState(() => crashed());
  const [traceMarks, setTraceMarks] = useState(() => trace());
  // `?diag` exercises onnxruntime on a 106-byte model through this same bundle.
  const [diag, setDiag] = useState<SelfTestResult[] | "running" | null>(null);
  const showDiag = new URLSearchParams(location.search).has("diag");

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
          lastSeen: notes[0]?.created_at ?? 0,
        });
      }
      setNoteCount(total);
      setEligible(rows.length);
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
        const startedAt = performance.now();
        try {
          if (judgedRef.current.size === 0) mark("predict:first:before");
          const result = await agent.predict(buildState(notes, getProfile(target)), QUESTIONS);
          if (judgedRef.current.size === 0) mark("predict:first:after");
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
          // Sum the predictions themselves rather than wall time, which would
          // include the idle waits between having anything to judge.
          const took = performance.now() - startedAt;
          setLaya((s) =>
            s.kind === "ready"
              ? { ...s, judged: judgedRef.current.size, totalMs: s.totalMs + took }
              : s,
          );
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

  // Deliberately not run on mount. Reading it means opening a Cache bucket that
  // can hold 681 MB, and on a device whose tab was killed mid-write that is the
  // one thing most likely to take the page down with it. Nothing here needs the
  // figure until someone reaches for the button.
  // Reading the cache on mount is avoided elsewhere, but a custom bundle's size
  // has to come from the host, and quoting the default's 681 MB for a 359 MB
  // bundle misleads exactly the person who went out of their way to name it.
  useEffect(() => {
    if (!usingCustomModel()) return;
    void cachedProgress().then(({ received, total }) =>
      setLaya((s) => (s.kind === "idle" ? { kind: "idle", cached: received, total } : s)),
    );
  }, []);

  const checkCache = useCallback(() => {
    void cachedProgress().then(({ received, total }) =>
      setLaya((s) => (s.kind === "idle" ? { kind: "idle", cached: received, total } : s)),
    );
  }, []);

  const startLaya = useCallback(() => {
    setLaya({ kind: "loading", phase: "config", received: 0, total: TOKENIZER_BYTES });
    void load((phase, received, total) => {
      setLaya((s) => (s.kind === "loading" ? { kind: "loading", phase, received, total } : s));
    })
      .then(({ agent, provider }) => {
        agentRef.current = agent;
        mark("done", provider);
        setLaya({ kind: "ready", provider, judged: 0, totalMs: 0 });
      })
      .catch((e: unknown) => {
        const f = e as { phase?: Phase; received?: number; message?: string };
        setLaya({
          kind: "error",
          phase: f.phase ?? "config",
          received: f.received ?? 0,
          message: f.message ?? String(e),
        });
        // The marks explaining this failure were written moments ago; show them
        // without waiting for a reload.
        setTraceMarks(trace());
        setShowTrace(true);
      });
  }, []);

  const clearLaya = useCallback(() => {
    void clearModelCache().then(() => setLaya({ kind: "idle", cached: 0, total: MODEL_BYTES + TOKENIZER_BYTES }));
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
        <h1>
          laya-bot-det{" "}
          <a
            className="version"
            href={`https://github.com/koteitan/laya-bot-det/commit/${__APP_COMMIT__}`}
            title="このページがビルドされたコミット"
          >
            v{__APP_VERSION__}+{__APP_COMMIT__}
          </a>
        </h1>
        <p className="summary">
          {relays === null
            ? "リレーを探しています…"
            : `${relays.source} / ${relays.read.length} リレー ・ ${noteCount} notes ・ ` +
              `${authors.length} authors ・ bot ${bots} (しきい値 ${settings.threshold.toFixed(2)})`}
        </p>
        <LayaStatus state={laya} onStart={startLaya} onClear={clearLaya} eligible={eligible} />
        <Menu
          open={menuOpen}
          onToggle={() => {
            if (!menuOpen) checkCache();
            setMenuOpen((v) => !v);
          }}
          settings={settings}
          onChange={update}
          onClearCache={() => {
            clearCache();
            askedProfiles.current.clear();
          }}
          cachedProfiles={cachedProfileCount()}
        />
      </header>
      {showDiag ? (
        <pre className="trace diag">
          {`onnxruntime-web ${ortVersion()} を 106 バイトのモデルで試します\n\n`}
          {diag === "running"
            ? "実行中…"
            : diag
              ? diag.map((r) => `${r.provider}: ${r.ok ? "OK" : "失敗"} (${r.ms}ms)\n  ${r.detail}`).join("\n")
              : "未実行"}
          {"\n\n"}
          <button
            onClick={() => {
              setDiag("running");
              void (async () => {
                const out: SelfTestResult[] = [];
                for (const p of ["wasm", "webgpu"] as const) out.push(await selfTest(p));
                setDiag(out);
              })();
            }}
          >
            診断する
          </button>
        </pre>
      ) : null}
      {showTrace ? (
        <pre className="trace">
          {`読み込みの記録 (${traceMarks.length} 行) — どこまで進んだかの控えです。` +
            `失敗したときは、この中身をそのままコピーして報告してください。\n\n`}
          {format(traceMarks)}
          {"\n\n"}
          {/* Read on demand. Marks written after this component mounted are not
              picked up by a render that happens to be caused by something else,
              and the marks worth reading are exactly the ones written last. */}
          <button onClick={() => setTraceMarks(trace())}>最新にする</button>{" "}
          <button onClick={() => { clearTrace(); setTraceMarks([]); setShowTrace(false); }}>
            消す
          </button>
        </pre>
      ) : null}
      <main>
        {shown.map((a) => (
          <AuthorCard key={a.pubkey} a={a} threshold={settings.threshold} />
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

const MB = (n: number) => Math.round(n / 1e6);
const PHASE_LABEL: Record<Phase, string> = {
  config: `設定とトークナイザ (${MB(TOKENIZER_BYTES)} MB)`,
  model: `モデル (${MB(MODEL_BYTES)} MB)`,
  session: "モデルを GPU に載せています",
};

function LayaStatus({
  state,
  onStart,
  onClear,
  eligible,
}: {
  state: LayaState;
  onStart: () => void;
  onClear: () => void;
  eligible: number;
}) {
  const warning = memoryWarning();
  const forced = new URLSearchParams(location.search).has("force");
  if (state.kind === "idle") {
    // Loading the model on WebKit kills the tab, and does so unpredictably --
    // 201 MB sometimes works, sometimes does not. A button that occasionally
    // takes the browser with it is not worth offering, so it is withheld here
    // rather than dressed up as a choice. `?force=1` still gets it, which is
    // how this will be re-measured when onnxruntime or WebKit change.
    const withheld = warning?.fatal === true && !forced && !usingCustomModel();
    return (
      <p className="laya-status">
        {/* The warning is a measurement of the default bundle. Pointing at
            another one is precisely how you find out whether it still holds,
            so do not repeat it back at someone already doing that. */}
        {warning && !usingCustomModel() ? (
          <span className={warning.fatal ? "warn fatal" : "warn"}>{warning.text}</span>
        ) : null}
        {usingCustomModel() ? <span className="warn">モデル: {MODEL_URL}</span> : null}
        いまは<b>統計のみ</b>で判定中。
        {withheld ? (
          <>
            この端末では Laya を提供しません。デスクトップの Chrome か Edge で開くと使えます。{" "}
            <a href="?force=1">それでも試す</a>
          </>
        ) : (
          <>
            {state.cached >= state.total
              ? "Laya はキャッシュ済みなので、ダウンロードなしで使えます。"
              : state.cached > 0
                ? `Laya は ${MB(state.cached)} / ${MB(state.total)} MB までキャッシュ済み。続きから再開します。`
                : `Laya を足すには ${MB(state.total)} MB のダウンロードが要ります（初回だけ）。`}{" "}
            <button onClick={onStart}>
              {warning?.fatal ? "それでも Laya を読み込む" : "Laya を読み込む"}
            </button>
            {state.cached > 0 ? <button onClick={onClear}>キャッシュを消す</button> : null}
            {!hasWebGPU() ? " ※ WebGPU が無いので WASM で動きます（かなり遅い）" : null}
          </>
        )}
      </p>
    );
  }

  if (state.kind === "loading") {
    const pct = state.total ? Math.min(100, (state.received / state.total) * 100) : 0;
    return (
      <p className="laya-status">
        {PHASE_LABEL[state.phase]}
        {state.phase === "session"
          ? "…"
          : state.phase === "config" && state.received === 0
            ? " を読み込み中…"
            : ` を読み込み中 ${pct.toFixed(0)}% (${MB(state.received)} / ${MB(state.total)} MB)`}
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <p className="laya-status error">
        Laya の読み込みに失敗: {state.message} — {PHASE_LABEL[state.phase]} の途中、
        {MB(state.received)} MB 受信したところ。ここまでは保存してあるので、続きから再開します。{" "}
        <button onClick={onStart}>やり直す</button>
        <button onClick={onClear}>キャッシュを消してやり直す</button>
      </p>
    );
  }
  const rate = state.totalMs > 0 ? state.judged / (state.totalMs / 1000) : null;
  return (
    <p className="laya-status">
      Laya 稼働中 ({state.provider}) ・ {eligible} 中 {state.judged} authors 判定済み
      {rate !== null ? ` ・ ${rate.toFixed(1)} authors/s` : null}
    </p>
  );
}
