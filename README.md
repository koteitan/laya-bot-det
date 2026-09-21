# laya-bot-det

Jev と同じ System One 系のオープンウェイトモデル [Laya](https://github.com/NandhaKishorM/laya) を [mizchi/laya-mlx](https://github.com/mizchi/laya-mlx) の ONNX export 経由で使って、nostr の kind:0 と kind:1 から投稿者ごとに bot かどうかを判定する。

ブラウザだけで動く版が https://koteitan.github.io/laya-bot-det/ にある。
リレーから流れてくる kind:1 をその場で判定する。

判定は2つのスコアの合成:

- **Laya** — [`mizchi/laya-multilingual-onnx`](https://huggingface.co/mizchi/laya-multilingual-onnx)
  (mmBERT-base 322M の typed decision モデル)。文章を読んで human / bot を選ぶ。
- **統計** — 投稿間隔の規則性、テンプレ率、返信率など、決定的に計算できる指標。

## web デモ (`web/`)

ブラウザの中で完結する nostr クライアント。サーバーもパイプラインも要らない。

開くとこの順に動く。

1. bootstrap リレーから **kind:10002** を取る (rx-nostr backward)
2. そこで得たリレーから **kind:1** を購読する (rx-nostr forward)
3. 初めて見る author の **kind:0 と picture** を取り、localStorage と Cache API に入れる
4. 投稿が 2 件たまった author から順に判定する
5. 結果は observable 経由で随時描画される

**Laya は任意**。開いた直後は決定的な統計だけで動いていて、ダウンロードは 0 バイト。
モデルを足したくなったら「Laya を読み込む」を押す。**681 MB**
(`model.onnx` 647 MB + `tokenizer.json` 34 MB) を Hugging Face から取る。
推論は WebGPU、無ければ WASM にフォールバックする (かなり遅い)。

**モバイルでは読み込めない。** 展開時のピークが 1.3 GB 前後になる
(647 MB のバッファと、`InferenceSession.create` が wasm ヒープに作るコピーが
同時に存在する) ため、iOS / iPadOS の Safari はその手前でタブを落とす。
エラーにはならず「問題が繰り返し起きました」の画面になるので、捕捉して
リカバリする手段がない。該当端末では事前に警告を出す。統計のみの判定は
どの端末でも動く。

取得は **8 MB ずつの Range リクエスト**で、チャンク単位で Cache API に入れる。
回線が切れても失うのは 1 チャンクだけで、リロードしても続きから再開する
(`web/src/laya/download.ts`)。647 MB を 1 本のレスポンスで読み切る作りだと、
313 MB 地点で切れたときに 0 バイトしか残らない。

この作りにしたのは、統計だけで AUC 0.839 出るから (下の表)。
681 MB 払う前に、何が起きるかは見えている方がいい。

```bash
cd web
npm install
npm run build      # dist/ が出る。ローカルで見るならこれを配信する
npm run dev        # vite の開発サーバ
```

`main` に push すると GitHub Actions が `web/dist` を Pages に出す
(`.github/workflows/pages.yml`)。

## セットアップ

```bash
git clone git@github.com:koteitan/laya-bot-det.git
cd laya-bot-det
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
./bot-det model            # ONNX バンドル 650MB を1回だけ取得
```

## コマンド

段階ごとに分かれていて、それぞれ `data/` に結果を書く。前の段階をやり直さずに再実行できる。

| コマンド | やること | 出力 |
|---|---|---|
| `./bot-det model` | Laya の ONNX を取得 (650MB, 初回のみ) | `models/` |
| `./bot-det relays` | (1) 自分の kind:10002 からリレー一覧を取る | `data/relays.json` |
| `./bot-det collect` | (2) そのリレーから kind:1 を 100件 × 10試行 | `data/cache/notes/` |
| `./bot-det snapshots` | 収集済みスナップショットの一覧 | |
| `./bot-det profiles` | (4) kind:0 と picture をキャッシュ | `data/cache/` |
| `./bot-det detect` | (3) author ごとに Laya で判定 | `data/authors.json` |
| `./bot-det eval` | kind:0 の `bot:true` を正解として精度を測る | `data/eval.json` |
| `./bot-det bench` | CPU と CUDA の速度を実データで比較 | |
| `./bot-det all` | 上を順に全部 | |

よく使うオプション:

```bash
./bot-det relays --npub npub1...        # 別の人のリレーリストを使う
./bot-det collect --trials 20 --limit 100
./bot-det detect --min-posts 3          # 投稿が少ない author を除く
./bot-det profiles --no-pictures        # 画像を落とさない
./bot-det -v collect                    # どのリレーが失敗したか出す
```

## kind:1 のキャッシュと再検証

収集した kind:1 は2つに分けて保存する。

- `data/cache/notes/notes.jsonl` — これまでに集めた全イベント。id で重複を排除して**追記のみ**。
- `data/cache/notes/snapshots/<id>.json` — その1回の `collect` が見た event id の一覧と、
  使ったリレー・試行回数。

分けてあるので、**キャッシュが増えても過去の実行をそのまま再現できる**。

```bash
./bot-det snapshots                          # 一覧
./bot-det detect --snapshot 20260921-110026  # その回と完全に同じイベントで再判定
./bot-det detect --snapshot latest           # 直近 (既定)
./bot-det detect --snapshot all              # キャッシュ全部
./bot-det eval  --snapshot 20260921-110026   # 同じ集合で精度を測り直す
```

判定ロジックを変えたとき、`--snapshot` を固定すれば**ネットワークに出ずに**、
同じ入力で前後を比較できる。`data/authors.json` にも使った snapshot id が入る。

`--snapshot` は `profiles` / `detect` / `eval` / `bench` で使える。

結果は `index.html` で見る。`data/authors.json` を `fetch` する静的ページなので、
**`file://` では開けない** (CORS で fetch が失敗して真っ白になる)。
HTTP で配信すること — live-server でも、リポジトリを置いたローカルサーバでもよい。

## GPU

`requirements.txt` は x86_64 では `onnxruntime-gpu` を入れる。CUDA 12 と cuDNN 9 の
共有ライブラリは `nvidia-*-cu12` の pip パッケージ (torch を入れると一緒に来る) にあれば
そのまま使う。起動時のログで確認できる:

```
laya: laya-multilingual-onnx on CUDAExecutionProvider   # GPU
laya: laya-multilingual-onnx on CPUExecutionProvider    # CPU にフォールバック
```

速度は「速度」の節を見ること。CPU と書かれていて GPU を使いたい場合:

```bash
.venv/bin/pip uninstall -y onnxruntime          # CPU 版が入っていると競合する
.venv/bin/pip install onnxruntime-gpu
./bot-det bench                                  # 実データで速度を比較
```

`onnxruntime` 自身の `preload_dlls()` は自分の site-packages しか見ないため、
CUDA ライブラリが user site (`~/.local/lib/.../nvidia/`) にあると
`libcublasLt.so.12: cannot open shared object file` で CPU に落ちる。
`pipeline/laya.py` の `preload_cuda()` がそれを先回りして ctypes で読み込む。

## Laya に何を渡しているか

state は kind:0 のプロフィールと、重複を除いた新しい投稿12件 (各140文字まで)。

```
display_name: じほう
about: Current time in Japan / 30分ごとに時間教えてくれます
posts:
- 2026年9月21日 12時00分
- 2026年9月21日 12時30分
- ...
```

質問は1回の forward pass にまとめて5つ:

| 名前 | 型 | 中身 |
|---|---|---|
| `bot_hb` | choice | `{human: "a human", bot: "an automated bot"}` |
| `bot_bh` | choice | 同じ質問、**選択肢の順番を逆**にしたもの |
| `category` | choice | person / news / data / bridge / spam / art |
| `templated` | noul | 毎回同じテンプレートか |
| `conversational` | noul | 他人に話しかけているか |

`bot_hb` と `bot_bh` の平均が Laya のスコア。順番で答えが変わるので両方聞いている。

## 設計は測って決めた

nostr には正解ラベルがある。kind:0 の NIP-24 `"bot": true` — アカウント自身の申告。
4,352 notes のサンプルで **bot:true 31件 / bot:false 8件**。これに対する AUC:

| 変えたもの | AUC |
|---|---|
| noul「これは bot の投稿だ」 | 0.52 |
| choice `{human, bot}` | 0.67 |
| state = 投稿12件 | 0.669 |
| state = 投稿5件 | 0.645 |
| state = kind:0 プロフィールのみ | 0.790 |
| **state = プロフィール + 投稿** | **0.819** |
| criteria を1文の説明にする | **0.383** (偶然以下) |
| criteria を短いラベル2語にする | **0.819** |
| **統計のみ (Laya を使わない)** | **0.839** |
| **Laya × 0.5 + 統計 × 0.5** | **0.907** |

読み取れること:

1. **凝った criteria を書くと悪化する。** 1文の説明を入れた版は AUC 0.383 で、
   偶然より悪い。`"a human"` / `"an automated bot"` の2語が最も良かった。
2. **決定的な統計だけで AUC 0.839。** Laya 単独 (0.819) より上。
   投稿間隔の規則性とテンプレ率を数えるほうが、文章を読むより効く。
3. **合成すると 0.907。** Laya が意味を持つのはここだけ。単独では算術に負ける。

だから UI は合成スコアだけでなく、Laya と統計を**別々に並べて**表示する。
どちらが効いているかが見えるように。

## 速度

RTX 4060 Ti (8GB) と i7-14700F (28コア) での実測。1 author = 5問を1バッチ。

| | author/s | typed decision/s | 343 authors の所要 |
|---|---|---|---|
| CPU | 0.6 | 3 | 約9分 |
| **CUDA** | **23.9** | **約120** | **14秒** |

約39倍。`./bot-det all` の実行例:

```
collected 5080 unique kind:1 events
5080 notes (5080 new to the cache) from 717 authors
profiles: 290 cached, 53 to fetch
pictures: 67/67
judging 343 authors (374 skipped for having under 2 posts)
laya: laya-multilingual-onnx on CUDAExecutionProvider
judged  20/343 (11.4/s)
judged 100/343 (13.2/s)
judged 200/343 (17.5/s)
judged 300/343 (22.2/s)
judged 343/343 (23.9/s)
```

表示は累積平均。投稿数の多い author から処理するので、最初は系列が長くて遅く、
末尾の軽い author では瞬間値で 50 author/s (約 250 decision/s) 前後まで上がる。

自分の環境で測るなら `./bot-det bench`。

## ファイル

```
bot-det              コマンド本体 (.venv の python を呼ぶだけ)
pipeline/
  nip19.py           bech32 (npub <-> hex)。ライブラリは使わず自前
  relaypool.py       WebSocket で REQ を投げて EOSE まで集める
  relays.py          kind:10002 -> kind:3 -> フォールバック の順で解決
  collect.py         kind:1 のページング収集、kind:0 と画像のキャッシュ
  features.py        決定的な統計と、その素朴なスコア
  laya.py            ONNX 推論。プロンプト構築と較正を上流から移植
  detect.py          Laya に何をどう聞くか (上の表の結論)
  evaluate.py        NIP-24 ラベルに対する AUC / しきい値
  run.py             CLI
index.html main.js style.css   パイプラインの結果表示 (ビルド不要)
web/                 ブラウザ版 nostr クライアント (TypeScript + Vite + React + rx-nostr)
  src/nostr/         リレー探索、kind:1 購読、kind:0 と画像のキャッシュ
  src/detect/        統計と質問の設計 (pipeline/ の移植)
  src/laya/vendor/   @laya-mlx/web をそのまま vendor (npm 未公開のため)
  src/ui/            カードとメニュー
.github/workflows/pages.yml   web/dist を GitHub Pages にデプロイ
data/                生成物。cache/pictures だけ .gitignore
```

`data/cache/pictures/` は 30MB 前後になるので git には入れない。
画像が無い場合、UI は kind:0 の `picture` URL を直接読む。

## ライセンス

Apache-2.0。

`pipeline/laya.py` は Laya (Convai Innovations) の派生で、laya-mlx とその
mizchi フォークを経由している。いずれも Apache-2.0。派生の連鎖、参照した
リビジョン、加えた変更は `NOTICE` に記載。

それ以外 — nostr の収集、投稿統計、質問の設計、NIP-24 ラベルによる評価、
web ページ — はこのリポジトリのオリジナル。

モデルの重みはリポジトリに含まない。実行時に Hugging Face から取得する
([mizchi/laya-multilingual-onnx](https://huggingface.co/mizchi/laya-multilingual-onnx)、
Apache-2.0)。
