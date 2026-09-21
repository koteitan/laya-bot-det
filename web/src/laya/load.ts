/** Loading the Laya ONNX bundle in the browser.
 *
 *  The weights are not served from this site: `model.onnx` is 647 MB and
 *  `tokenizer.json` another 34 MB, well past what GitHub Pages will host. They
 *  come from the Hugging Face CDN.
 *
 *  This composes the agent the way the vendored `loadAgent` does, but fetches
 *  the model through `download.ts` instead, so an interrupted transfer resumes
 *  from the last 16 MB chunk rather than starting over. See that file for why.
 */

import { LayaAgent } from "./vendor/agent.ts";
import { LayaTokenizer, type TokenizerConfig, type TokenizerJson } from "./vendor/tokenizer.ts";
import { OnnxRunner, type OnnxConfig, type Provider } from "./vendor/session.ts";
import type { AgentConfig } from "./vendor/types.ts";
import {
  cachedBytes,
  clearModelCache,
  downloadBytes,
  downloadJson,
  pruneStaleChunks,
  type Progress,
} from "./download.ts";

export const MODEL_URL = "https://huggingface.co/mizchi/laya-multilingual-onnx/resolve/main/";
export const TOKENIZER_BYTES = 34_363_188;
export const MODEL_BYTES = 646_870_871;

const MODEL_FILE = MODEL_URL + "model.onnx";
const TOKENIZER_FILE = MODEL_URL + "tokenizer/tokenizer.json";

export interface Loaded {
  agent: LayaAgent;
  provider: Provider;
}

/** Which file the loader is on. The 34 MB tokenizer comes before the model, and
 *  without naming it the UI sits at 0% through a large download. */
export type Phase = "config" | "model" | "session";

export interface Failure {
  phase: Phase;
  received: number;
  message: string;
}

export async function load(
  onProgress: (phase: Phase, received: number, total: number) => void,
): Promise<Loaded> {
  let phase: Phase = "config";
  let received = 0;
  try {
    // Entries from an earlier chunk size can never be read again; reclaim them
    // before asking the browser for several hundred more MB.
    await pruneStaleChunks();
    onProgress("config", 0, TOKENIZER_BYTES);
    // The tokenizer is 34 MB and goes through the same resumable path as the
    // model; the other three configs are a few hundred bytes each and only ride
    // along because one chunk covers them.
    const [config, onnxConfig, tokenizerJson, tokenizerConfig] = await Promise.all([
      downloadJson<AgentConfig>(MODEL_URL + "rl_agent_config.json"),
      downloadJson<OnnxConfig>(MODEL_URL + "onnx_config.json"),
      downloadJson<TokenizerJson>(TOKENIZER_FILE, (p: Progress) => {
        received = p.received;
        onProgress("config", p.received, p.total);
      }),
      downloadJson<TokenizerConfig>(MODEL_URL + "tokenizer/tokenizer_config.json"),
    ]);
    if (onnxConfig.format !== "laya-onnx") {
      throw new Error(`Not a Laya ONNX bundle: ${MODEL_URL}`);
    }

    phase = "model";
    received = 0;
    const model = await downloadBytes(MODEL_FILE, (p: Progress) => {
      received = p.received;
      onProgress("model", p.received, p.total);
    });

    phase = "session";
    onProgress("session", MODEL_BYTES, MODEL_BYTES);
    const runner = await OnnxRunner.create(model, {
      providers: ["webgpu", "wasm"],
      // onnxruntime-web fetches these at runtime; vite.config.ts copies them to dist/ort/.
      wasmPaths: `${import.meta.env.BASE_URL}ort/`,
    });
    const agent = new LayaAgent({
      config,
      tokenizer: new LayaTokenizer(tokenizerJson, tokenizerConfig),
      runner,
    });
    return { agent, provider: runner.provider };
  } catch (error) {
    // Naming the file and the byte count turns "Load failed" into something
    // actionable: a browser that gave up 300 MB in is a different problem from
    // one that never got the tokenizer.
    const failure: Failure = {
      phase,
      received,
      message: error instanceof Error ? error.message : String(error),
    };
    throw Object.assign(new Error(failure.message), failure);
  }
}

export const hasWebGPU = (): boolean => "gpu" in navigator;

export { clearModelCache };

/** How much of the download a previous visit already paid for, across both big files. */
export async function cachedProgress(): Promise<{ received: number; total: number }> {
  const [model, tokenizer] = await Promise.all([
    cachedBytes(MODEL_FILE),
    cachedBytes(TOKENIZER_FILE),
  ]);
  return { received: model + tokenizer, total: MODEL_BYTES + TOKENIZER_BYTES };
}
