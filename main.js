'use strict';

const KEY = 'laya-bot-det';
const state = Object.assign(
  { dark: true, threshold: null, sort: 'score', filter: 'all', posts: true },
  readState()
);

function readState() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
  catch { return {}; }
}
function save(patch) {
  Object.assign(state, patch);
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode */ }
}

const $ = (id) => document.getElementById(id);

// authors.json lives here, and `picture_local` is stored relative to it, so the
// page has to rejoin the two: the page itself sits one level up.
const DATA_DIR = 'data/';

/** Cached picture first, the profile's own URL next, then nothing. The cache is
 *  gitignored, so a published copy of this page usually falls through to the URL. */
function avatarHtml(p) {
  const local = p.picture_local ? DATA_DIR + p.picture_local : '';
  const remote = p.picture_url || '';
  const src = local || remote;
  if (!src) return '<div class="avatar"></div>';
  const fallback = local && remote ? remote : '';
  return `<img class="avatar" src="${esc(src)}" alt="" loading="lazy"
    data-fallback="${esc(fallback)}" onerror="layaAvatarError(this)">`;
}

window.layaAvatarError = function (img) {
  const next = img.dataset.fallback;
  img.dataset.fallback = '';
  if (next) { img.src = next; return; }
  const blank = document.createElement('div');
  blank.className = 'avatar';
  img.replaceWith(blank);
};
const clamp01 = (x) => Math.min(1, Math.max(0, x || 0));
const pct = (x) => (clamp01(x) * 100).toFixed(0) + '%';

function applyTheme() {
  document.documentElement.classList.toggle('light', !state.dark);
}

let DATA = null;

function bar(label, value, blue) {
  return `<span>${label}</span>
    <span class="bar${blue ? ' blue' : ''}"><span style="width:${pct(value)}"></span></span>
    <span class="num">${value == null ? '—' : value.toFixed(2)}</span>`;
}

function card(a) {
  const p = a.profile || {};
  const laya = a.laya || {};
  const name = p.display_name || p.name || a.npub.slice(0, 16) + '…';
  const verdict = a.score >= state.threshold ? 'bot' : 'human';
  const label = typeof p.bot === 'boolean'
    ? `<span class="badge label-${p.bot ? 'bot' : 'human'}">NIP-24: bot=${p.bot}</span>` : '';
  const reasons = (a.heuristic?.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('');
  const f = a.features || {};
  const posts = state.posts
    ? `<div class="posts">${(a.sample || []).slice(0, 3)
        .map((s) => `<div>· ${esc(s.slice(0, 120))}</div>`).join('')}</div>` : '';

  return `<article class="card ${verdict}">
    <div class="top">
      ${avatarHtml(p)}
      <div class="who">
        <div class="name">${esc(name)}</div>
        <div class="npub">${esc(a.npub)}</div>
        ${p.about ? `<div class="about">${esc(p.about)}</div>` : ''}
      </div>
      <div class="verdict">
        <div class="tag">${verdict.toUpperCase()}</div>
        <div class="score">${a.score.toFixed(2)}</div>
      </div>
    </div>
    <div class="bars">
      ${bar('合成', a.score, false)}
      ${bar('Laya', laya.p_bot, true)}
      ${bar('統計', a.heuristic?.score, false)}
    </div>
    <div class="meta">
      ${label}
      <span class="badge">${esc(laya.category || '?')}</span>
      <span>投稿 ${f.posts ?? '?'}</span>
      <span>定型 ${laya.templated != null ? laya.templated.toFixed(2) : '—'}</span>
      <span>会話 ${laya.conversational != null ? laya.conversational.toFixed(2) : '—'}</span>
      ${f.regularity != null ? `<span>間隔の規則性 ${f.regularity.toFixed(2)}</span>` : ''}
      ${laya.order_spread > 0.15
        ? `<span title="選択肢の順番で答えが変わった量">順序差 ${laya.order_spread.toFixed(2)}</span>` : ''}
    </div>
    ${reasons ? `<ul class="reasons">${reasons}</ul>` : ''}
    ${posts}
  </article>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function render() {
  if (!DATA) return;
  let rows = DATA.authors.slice();
  const t = state.threshold;

  if (state.filter === 'bot') rows = rows.filter((a) => a.score >= t);
  else if (state.filter === 'human') rows = rows.filter((a) => a.score < t);
  else if (state.filter === 'labelled')
    rows = rows.filter((a) => typeof a.profile?.bot === 'boolean');
  else if (state.filter === 'disagree')
    rows = rows.filter((a) => Math.abs((a.laya?.p_bot ?? 0) - (a.heuristic?.score ?? 0)) >= 0.4);

  const keyed = {
    score: (a) => a.score,
    laya: (a) => a.laya?.p_bot ?? -1,
    heuristic: (a) => a.heuristic?.score ?? -1,
    posts: (a) => a.features?.posts ?? -1,
  }[state.sort];
  rows.sort((x, y) => keyed(y) - keyed(x));

  const bots = DATA.authors.filter((a) => a.score >= t).length;
  $('summary').textContent =
    `${DATA.notes} notes / ${DATA.authors_total} authors のうち ${DATA.authors_judged} 人を判定 — ` +
    `しきい値 ${t.toFixed(2)} で bot ${bots} 人 (${(bots / DATA.authors_judged * 100).toFixed(0)}%) ・ 表示 ${rows.length} 件`;
  $('list').innerHTML = rows.map(card).join('');
}

function bindMenu() {
  const button = $('menu-button');
  const panel = $('menu-panel');
  button.addEventListener('click', () => {
    const open = panel.hasAttribute('hidden');
    panel.toggleAttribute('hidden', !open);
    button.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hasAttribute('hidden')) {
      panel.setAttribute('hidden', '');
      button.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('click', (e) => {
    if (!panel.hasAttribute('hidden') && !panel.contains(e.target) && e.target !== button) {
      panel.setAttribute('hidden', '');
      button.setAttribute('aria-expanded', 'false');
    }
  });

  const dark = $('opt-dark');
  dark.checked = state.dark;
  dark.addEventListener('change', () => { save({ dark: dark.checked }); applyTheme(); });

  const thr = $('opt-threshold');
  const out = $('opt-threshold-out');
  thr.value = state.threshold;
  out.textContent = Number(state.threshold).toFixed(2);
  thr.addEventListener('input', () => {
    out.textContent = Number(thr.value).toFixed(2);
    save({ threshold: Number(thr.value) });
    render();
  });

  for (const [id, key] of [['opt-sort', 'sort'], ['opt-filter', 'filter']]) {
    const el = $(id);
    el.value = state[key];
    el.addEventListener('change', () => { save({ [key]: el.value }); render(); });
  }
  const showPosts = $('opt-posts');
  showPosts.checked = state.posts;
  showPosts.addEventListener('change', () => { save({ posts: showPosts.checked }); render(); });
}

applyTheme();
fetch('data/authors.json')
  .then((r) => {
    if (!r.ok) throw new Error(`data/authors.json: HTTP ${r.status}`);
    return r.json();
  })
  .then((d) => {
    DATA = d;
    // The pipeline's measured threshold is the default; a stored one wins on reload.
    if (state.threshold == null) state.threshold = d.threshold ?? 0.4;
    if (d.version) $('version').textContent = 'v' + d.version;
    bindMenu();
    render();
  })
  .catch((err) => {
    $('summary').textContent =
      `${err.message} — 先に ./bot-det all を実行してください`;
  });
