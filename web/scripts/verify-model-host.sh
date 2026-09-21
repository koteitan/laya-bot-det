#!/usr/bin/env bash
# Check that a host can actually serve a Laya bundle to the browser.
#
# Three things have to hold, and a host can satisfy two of them and still be
# unusable: HTTPS (the page is served over it, so http:// would be blocked as
# mixed content), Access-Control-Allow-Origin (the fetch is cross-origin), and
# Range requests (the downloader resumes in 8 MB pieces).
#
#   web/scripts/verify-model-host.sh https://example.com/laya/int8/
set -euo pipefail

BASE="${1:?usage: verify-model-host.sh <base-url-ending-in-slash> [origin]}"
ORIGIN="${2:-https://koteitan.github.io}"
[ "${BASE: -1}" = "/" ] || BASE="$BASE/"

fail=0
check() {
  local name="$1" url="$2" head code cors
  head=$(curl -s -I -H "Origin: $ORIGIN" -H "Range: bytes=0-99" "$url" || true)
  code=$(printf '%s' "$head" | awk 'tolower($1) ~ /^http/ {c=$2} END {print c}')
  cors=$(printf '%s' "$head" | grep -i '^access-control-allow-origin:' | head -1 | tr -d '\r' || true)
  printf '%-34s HTTP %-4s' "$name" "${code:-???}"
  if [ "$code" = "206" ]; then printf ' Range:OK '; else printf ' Range:NG '; fail=1; fi
  if [ -n "$cors" ]; then printf ' CORS:OK'; else printf ' CORS:NG'; fail=1; fi
  printf '\n'
}

case "$BASE" in
  https://*) ;;
  *) echo "HTTPS ではありません。ページが https なので混在コンテンツで弾かれます。"; fail=1 ;;
esac

# A split bundle has no model.onnx; it has parts named by the manifest. Small
# files may answer a range with 200 simply because it covers the whole file,
# so only the big ones say anything useful about Range support.
if curl -sfI "${BASE}model.onnx.parts.json" >/dev/null 2>&1; then
  echo "分割バンドル (model.onnx.parts.json あり)"
  FILES="onnx_config.json rl_agent_config.json tokenizer/tokenizer_config.json \
         tokenizer/tokenizer.json model.onnx.parts.json model.onnx.000"
else
  FILES="onnx_config.json rl_agent_config.json tokenizer/tokenizer_config.json \
         tokenizer/tokenizer.json model.onnx"
fi
for f in $FILES; do
  check "$f" "$BASE$f"
done

echo
if [ "$fail" = 0 ]; then
  echo "全部 OK。このまま MODEL_URL に使えます:"
  echo "  $BASE"
else
  echo "上の NG を直さないとブラウザから読めません。"
  exit 1
fi
