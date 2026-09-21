#!/usr/bin/env bash
# Upload a Laya ONNX bundle to a static host over FTP.
#
# No credentials appear here, on the command line, or in shell history: curl
# looks them up itself with --netrc. Set that up once, on your machine, before
# running this (see the README section "モデルを自分のサーバーに置く").
#
#   web/scripts/upload-model.sh ftp.example.com /public_html/laya/int8
#
# The destination has to serve the files over HTTPS with
# `Access-Control-Allow-Origin` and honour Range requests; run
# `verify-model-host.sh` against the resulting URL to confirm all three.
set -euo pipefail

HOST="${1:?usage: upload-model.sh <ftp-host> [remote-dir] [local-bundle]}"
REMOTE="${2:-/public_html/laya/int8}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${3:-${HERE}/../../models/laya-multilingual-onnx-int8}"

[ -d "$SRC" ] || { echo "$SRC がありません" >&2; exit 1; }

# Smallest first: a wrong host or path fails in a second instead of after 325 MB.
FILES=(
  onnx_config.json
  rl_agent_config.json
  tokenizer/tokenizer_config.json
  tokenizer/tokenizer.json
  model.onnx
)

for f in "${FILES[@]}"; do
  printf '→ %-32s %6.1f MB\n' "$f" "$(stat -c%s "$SRC/$f" | awk '{print $1/1e6}')"
  curl --netrc --ftp-create-dirs --progress-bar \
       -T "$SRC/$f" "ftp://${HOST}${REMOTE}/$f"
done

echo
echo "完了。次に確認:"
echo "  web/scripts/verify-model-host.sh https://<公開URL>/"
