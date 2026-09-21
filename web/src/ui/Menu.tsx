import type { Settings } from "../settings.ts";

interface Props {
  open: boolean;
  onToggle: () => void;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onClearCache: () => void;
  cachedProfiles: number;
}

export function Menu({ open, onToggle, settings, onChange, onClearCache, cachedProfiles }: Props) {
  return (
    <div className="menu">
      <button aria-label="メニュー" aria-expanded={open} onClick={onToggle}>
        ☰
      </button>
      <div className="menu-panel" hidden={!open}>
        <label>
          <input
            type="checkbox"
            checked={settings.dark}
            onChange={(e) => onChange({ dark: e.target.checked })}
          />
          ダークモード
        </label>
        <hr />
        <label>
          しきい値 <output>{settings.threshold.toFixed(2)}</output>
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={settings.threshold}
            onChange={(e) => onChange({ threshold: Number(e.target.value) })}
          />
        </label>
        <hr />
        <label>
          並び順
          <select value={settings.sort} onChange={(e) => onChange({ sort: e.target.value as Settings["sort"] })}>
            <option value="score">bot スコア順</option>
            <option value="laya">Laya スコア順</option>
            <option value="heuristic">統計スコア順</option>
            <option value="posts">投稿数順</option>
            <option value="recent">新着順</option>
          </select>
        </label>
        <label>
          表示
          <select value={settings.filter} onChange={(e) => onChange({ filter: e.target.value as Settings["filter"] })}>
            <option value="all">すべて</option>
            <option value="bot">bot 判定のみ</option>
            <option value="human">human 判定のみ</option>
            <option value="labelled">NIP-24 ラベル付きのみ</option>
            <option value="disagree">Laya と統計が食い違うもの</option>
          </select>
        </label>
        <hr />
        <label>
          <input
            type="checkbox"
            checked={settings.seed}
            onChange={(e) => onChange({ seed: e.target.checked })}
          />
          過去の投稿も読む
        </label>
        <label>
          <input
            type="checkbox"
            checked={settings.showPosts}
            onChange={(e) => onChange({ showPosts: e.target.checked })}
          />
          投稿サンプルを表示
        </label>
        <hr />
        <button className="linkish" onClick={onClearCache}>
          プロフィールのキャッシュを消す ({cachedProfiles})
        </button>
      </div>
    </div>
  );
}
