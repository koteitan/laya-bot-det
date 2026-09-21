"""Laya typed-decision inference on onnxruntime.

Derived from Laya (https://github.com/NandhaKishorM/laya, Copyright Convai
Innovations and Laya contributors) by way of laya-mlx
(https://github.com/mizorewww/laya-mlx) and mizchi's fork of it
(https://github.com/mizchi/laya-mlx, revision dc3aa6b1). Licensed under
Apache-2.0; see the LICENSE and NOTICE files at the repository root.

Changed from those sources: the prompt construction, batching and calibration
are reimplemented in Python against the exported ONNX graph rather than MLX or
onnxruntime-web, CUDA library preloading is added, and the language router,
presets, email helpers and action-cost handling are omitted.

The graph takes `input_ids`, `attention_mask`, `marker_pos`, `marker_mask` and
`qtype`, and returns `logits` (one per option marker) and `act_logits`. The option
logits still need the calibration temperature and a softmax; that happens here.
"""

import json
import logging
import math
from pathlib import Path
from typing import Any

import numpy as np

log = logging.getLogger(__name__)

def preload_cuda() -> bool:
    """Make the CUDA/cuDNN shared objects loadable before onnxruntime asks for them.

    The libraries ship as `nvidia-*-cu12` pip packages (pulled in by torch, among
    others). onnxruntime's own `preload_dlls()` only searches its own
    site-packages, so it misses them when they live in the user site directory,
    and the CUDA provider then fails with "libcublasLt.so.12: cannot open shared
    object file". Loading every .so in those directories with RTLD_GLOBAL puts
    them in the process's symbol table, which also satisfies the further dlopen
    calls cuDNN makes for its own sub-libraries.

    Returns whether CUDA looks usable; the caller falls back to CPU if not.
    """
    import ctypes
    import glob

    try:
        import nvidia
    except ImportError:
        return False
    root = Path(nvidia.__file__).parent
    libs = sorted(glob.glob(str(root / "*" / "lib" / "*.so*")))
    if not libs:
        return False
    # Two passes: the first loads whatever has no unmet dependencies, the second
    # picks up the rest now that their dependencies are in the symbol table.
    pending = libs
    for _ in range(2):
        failed = []
        for lib in pending:
            try:
                ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
            except OSError:
                failed.append(lib)
        if not failed:
            break
        pending = failed
    return True


HF_REPO = "mizchi/laya-multilingual-onnx"
QTYPES = {"choice": 0, "score": 1, "noul": 2}
QTYPE_NAMES = ["choice", "score", "noul"]
OPTION_TOKEN_CAP = 48


def py_json(value: Any) -> str:
    """Python's `json.dumps` defaults, which upstream builds its prompts with."""
    return json.dumps(value, ensure_ascii=False, separators=(", ", ": "))


def render_criterion(value: Any) -> str:
    return value if isinstance(value, str) else py_json(value)


def _blank(v: Any) -> bool:
    return v is None or v == ""


def render_options(q: dict) -> list[str]:
    """Option texts in label order; noul is always [false, true]."""
    t = q["t"]
    if t == "choice":
        return [k if _blank(v) else f"{k}: {render_criterion(v)}" for k, v in q["crit"].items()]
    if t == "score":
        return [f"level {i}: {render_criterion(c)}" for i, c in enumerate(q["crit"])]
    crit = q["crit"] or {}
    f, tr = crit.get("false"), crit.get("true")
    return [
        "false: " + ("no, the statement does not hold" if _blank(f) else render_criterion(f)),
        "true: " + ("yes, the statement holds" if _blank(tr) else render_criterion(tr)),
    ]


def to_internal(question: dict) -> dict:
    """Validate one question into the internal {t, ins, crit} shape."""
    kind = question.get("type")
    if kind not in QTYPES:
        raise ValueError(f"Unknown question type {kind!r}; expected choice, score, or noul")
    if "instructions" not in question:
        raise ValueError("Question is missing instructions")
    raw = question["instructions"]
    ins = raw if isinstance(raw, str) else py_json(raw)
    crit = question.get("criteria")
    if kind == "choice":
        if isinstance(crit, list):
            if len(set(crit)) != len(crit):
                raise ValueError("Choice labels must be unique")
            crit = {c: None for c in crit}
        if not isinstance(crit, dict) or not crit:
            raise ValueError("Choice criteria must be a nonempty dictionary or list")
        return {"t": "choice", "ins": ins, "crit": crit}
    if kind == "score":
        if not isinstance(crit, list) or not crit:
            raise ValueError("Score criteria must be a nonempty list")
        return {"t": "score", "ins": ins, "crit": crit}
    if crit is not None and not isinstance(crit, dict):
        raise ValueError("Noul criteria must be a dictionary with false/true descriptions")
    return {"t": "noul", "ins": ins, "crit": crit}


def serialize_state(state: Any) -> str:
    return state if isinstance(state, str) else py_json(state)


def _softmax(z: np.ndarray) -> np.ndarray:
    e = np.exp(z - np.max(z))
    return e / e.sum()


def _temp_bucket(qtype: int, k: int) -> str:
    size = "2" if k <= 2 else "3-5" if k <= 5 else "6-10" if k <= 10 else "11+"
    return f"{QTYPE_NAMES[qtype]}:{size}"


def _confidence_from_probs(p: np.ndarray, k: int) -> float:
    """1 - H(p)/log(k): 1 when the model is certain, 0 when the options are uniform."""
    if k < 2:
        return 1.0
    entropy = -float(sum(v * math.log(min(max(v, 1e-12), 1.0)) for v in p[:k]))
    return min(max(1.0 - entropy / math.log(k), 0.0), 1.0)


class Laya:
    def __init__(self, model_dir: str | Path, providers: list[str] | None = None):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        model_dir = Path(model_dir)
        self.config = json.loads((model_dir / "rl_agent_config.json").read_text())
        self.max_len = int(self.config["max_len"])
        self.head_max_len = int(self.config["head_max_len"])
        self.temperature = self.config.get("temperature") or [1.0, 1.0, 1.0]
        self.temperature_by_options = self.config.get("temperature_by_options") or {}

        self.tok = Tokenizer.from_file(str(model_dir / "tokenizer" / "tokenizer.json"))
        tcfg = json.loads((model_dir / "tokenizer" / "tokenizer_config.json").read_text())
        self.mask_token = tcfg.get("mask_token") or "[MASK]"
        if isinstance(self.mask_token, dict):
            self.mask_token = self.mask_token.get("content", "[MASK]")
        cls_token = tcfg.get("cls_token") or "[CLS]"
        sep_token = tcfg.get("sep_token") or "[SEP]"
        pad_token = tcfg.get("pad_token") or "[PAD]"
        for name, tok in (("cls", cls_token), ("sep", sep_token), ("pad", pad_token)):
            if isinstance(tok, dict):
                tok = tok.get("content")
            tid = self.tok.token_to_id(tok)
            if tid is None:
                raise ValueError(f"tokenizer has no {name} token {tok!r}")
            setattr(self, f"{name}_id", tid)
        self.mask_id = self.tok.token_to_id(self.mask_token)
        if self.mask_id is None:
            raise ValueError(f"tokenizer has no mask token {self.mask_token!r}")

        opts = ort.SessionOptions()
        opts.log_severity_level = 3
        if providers is None:
            available = ort.get_available_providers()
            providers = ["CPUExecutionProvider"]
            if "CUDAExecutionProvider" in available and preload_cuda():
                providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
        self.session = ort.InferenceSession(
            str(model_dir / "model.onnx"), sess_options=opts, providers=providers
        )
        active = self.session.get_providers()[0]
        if "CUDA" in str(providers) and active != "CUDAExecutionProvider":
            log.warning("CUDA was requested but onnxruntime fell back to %s", active)
        log.info("laya: %s on %s", model_dir.name, active)

    def _encode(self, text: str) -> list[int]:
        return self.tok.encode(text, add_special_tokens=False).ids

    def _build_prefix(self, q: dict) -> tuple[list[int], list[int]]:
        """[CLS] <type> question: <instructions> [SEP] [MASK] opt0 [MASK] opt1 ... [SEP]"""
        options = render_options(q)
        ins = q["ins"].replace(self.mask_token, " ")
        head_ids = self._encode(f"{q['t']} question: {ins}")
        opt_ids = [
            [self.mask_id] + self._encode(" " + o.replace(self.mask_token, " "))[:OPTION_TOKEN_CAP]
            for o in options
        ]
        total = lambda rows: sum(len(r) for r in rows)  # noqa: E731
        opt_budget = self.head_max_len - total(opt_ids)
        if opt_budget < 16:
            per = max(4, (self.head_max_len - 16) // max(1, len(opt_ids)))
            opt_ids = [r[:per] for r in opt_ids]
            opt_budget = self.head_max_len - total(opt_ids)
        head_ids = head_ids[: max(8, opt_budget)]
        ids = [self.cls_id] + head_ids + [self.sep_id]
        markers: list[int] = []
        for row in opt_ids:
            markers.append(len(ids))
            ids.extend(row)
        ids.append(self.sep_id)
        return ids, markers

    def _build_sequence(self, state: Any, q: dict) -> dict:
        prefix_ids, markers = self._build_prefix(q)
        room = max(0, self.max_len - len(prefix_ids) - 1)
        state_ids = self._encode(serialize_state(state).replace(self.mask_token, " "))[:room]
        ids = (prefix_ids + state_ids + [self.sep_id])[: self.max_len]
        return {
            "ids": ids,
            "markers": [m for m in markers if m < self.max_len],
            "qtype": QTYPES[q["t"]],
        }

    def predict(self, state: Any, questions: dict[str, dict]) -> dict:
        """One state, several named questions, one batched forward pass."""
        if not questions:
            raise ValueError("questions must be nonempty")
        qids = list(questions)
        internal = [to_internal(questions[k]) for k in qids]
        items = [self._build_sequence(state, q) for q in internal]

        rows = len(items)
        length = max(len(it["ids"]) for it in items)
        markers = max(max(len(it["markers"]) for it in items), 2)
        input_ids = np.full((rows, length), self.pad_id, dtype=np.int64)
        attention = np.zeros((rows, length), dtype=np.int64)
        marker_pos = np.zeros((rows, markers), dtype=np.int64)
        marker_mask = np.zeros((rows, markers), dtype=bool)
        qtype = np.array([it["qtype"] for it in items], dtype=np.int64)
        for r, it in enumerate(items):
            n = len(it["ids"])
            input_ids[r, :n] = it["ids"]
            attention[r, :n] = 1
            for i, pos in enumerate(it["markers"]):
                marker_pos[r, i] = pos
                marker_mask[r, i] = True

        logits, act_logits = self.session.run(
            ["logits", "act_logits"],
            {
                "input_ids": input_ids,
                "attention_mask": attention,
                "marker_pos": marker_pos,
                "marker_mask": marker_mask,
                "qtype": qtype,
            },
        )
        if not np.isfinite(logits).all() or not np.isfinite(act_logits).all():
            raise ValueError("Non-finite model outputs")

        answers: dict[str, Any] = {}
        for r, (qid, q, it) in enumerate(zip(qids, internal, items)):
            k = len(it["markers"])
            act = _softmax(np.asarray(act_logits[r], dtype=np.float64))
            scale = self.temperature_by_options.get(
                _temp_bucket(it["qtype"], k), self.temperature[it["qtype"]]
            )
            p = _softmax(np.asarray(logits[r][:k], dtype=np.float64) / max(1e-3, float(scale)))
            base = {
                "confidence": round(_confidence_from_probs(p, k), 4),
                "action": {"act_probability": round(float(act[0]), 4)},
            }
            if q["t"] == "choice":
                labels = list(q["crit"])
                answers[qid] = {
                    "type": "choice", **base,
                    "choice": labels[int(np.argmax(p))],
                    "probabilities": {l: round(float(p[i]), 4) for i, l in enumerate(labels)},
                }
            elif q["t"] == "score":
                answers[qid] = {
                    "type": "score", **base,
                    "score": round(float(sum(i * v for i, v in enumerate(p))), 4),
                    "legend": {str(i): render_criterion(c) for i, c in enumerate(q["crit"])},
                    "probabilities": {str(i): round(float(v), 4) for i, v in enumerate(p)},
                }
            else:
                p_true = float(p[1])
                answers[qid] = {
                    "type": "noul", **base,
                    "confidence": round(max(p_true, 1 - p_true), 4),
                    "noul": round(p_true, 4),
                }
        return {
            "model": "laya-rl-agent",
            "answers": answers,
            "usage": {"input_tokens": sum(len(it["ids"]) for it in items), "output_tokens": 0},
        }


def ensure_model(model_dir: Path, repo: str = HF_REPO) -> Path:
    """Download the ONNX bundle once; reuse it afterwards."""
    if (model_dir / "model.onnx").exists():
        return model_dir
    from huggingface_hub import snapshot_download

    log.info("downloading %s ...", repo)
    path = snapshot_download(repo_id=repo, local_dir=str(model_dir))
    return Path(path)
