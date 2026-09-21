"""Predict on the exact states the TypeScript run built, and compare.

Run `npx tsx scripts/verify-parity.ts` first; it writes `parity.json`. Both
sides then see one identical input, so any difference is the port and not two
separately assembled prompts.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))

from pipeline.detect import QUESTIONS  # noqa: E402
from pipeline.laya import Laya  # noqa: E402

rows = json.loads((Path(__file__).parent / "parity.json").read_text(encoding="utf-8"))
laya = Laya(ROOT / "models" / "laya-multilingual-onnx", providers=["CPUExecutionProvider"])

print(f"\n{'name':20} | {'ts p_bot':>8} | {'py p_bot':>8} | {'差':>7}")
print("-" * 20 + "-+-" + "-" * 8 + "-+-" + "-" * 8 + "-+-" + "-" * 7)
worst = 0.0
for row in rows:
    answers = laya.predict(row["state"], QUESTIONS)["answers"]
    py = (answers["bot_hb"]["probabilities"]["bot"] + answers["bot_bh"]["probabilities"]["bot"]) / 2
    diff = abs(py - row["ts_p_bot"])
    worst = max(worst, diff)
    print(f"{row['name'][:20]:20} | {row['ts_p_bot']:8.4f} | {py:8.4f} | {diff:7.4f}")
print(f"\n最大差: {worst:.6f}")
print("一致" if worst < 1e-3 else "不一致 — 移植にずれがある")
