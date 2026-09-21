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
import { cachedBytes, downloadModel, fetchJsonCached } from "./download.ts";

export const MODEL_URL = "https://huggingface.co/mizchi/laya-multilingual-onnx/resolve/main/";
export const TOKENIZER_BYTES = 34_363_188;
export const MODEL_BYTES = 646_870_871;

const modelFile = MODEL_URL + "model.onnx";

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
    onProgress("config", 0, TOKENIZER_BYTES);
    const [config, onnxConfig, tokenizerJson, tokenizerConfig] = await Promise.all([
      fetchJsonCached<AgentConfig>(MODEL_URL + "rl_agent_config.json"),
      fetchJsonCached<OnnxConfig>(MODEL_URL + "onnx_config.json"),
      fetchJsonCached<TokenizerJson>(MODEL_URL + "tokenizer/tokenizer.json"),
      fetchJsonCached<TokenizerConfig>(MODEL_URL + "tokenizer/tokenizer_config.json"),
    ]);
    if (onnxConfig.format !== "laya-onnx") {
      throw new Error(`Not a Laya ONNX bundle: ${MODEL_URL}`);
    }

    phase = "model";
    const model = await downloadModel(modelFile, (p) => {
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

/** How much of the model a previous visit already paid for. */
export async function cachedProgress(): Promise<number> {
  return (await cachedBytes(modelFile))?.received ?? 0;
}
