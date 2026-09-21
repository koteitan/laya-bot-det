/** Loading the Laya ONNX bundle in the browser.
 *
 *  The weights are not served from this site: `model.onnx` is 647 MB and
 *  `tokenizer.json` another 34 MB, well past what GitHub Pages will host. They
 *  come from the Hugging Face CDN and land in a Cache API bucket, so the cost is
 *  paid once per browser rather than once per visit.
 */

import { loadAgent, type LoadProgress, type Provider } from "./vendor/session.ts";
import type { LayaAgent } from "./vendor/agent.ts";

export const MODEL_URL = "https://huggingface.co/mizchi/laya-multilingual-onnx/resolve/main/";
export const TOKENIZER_BYTES = 34_400_000;
export const MODEL_BYTES = 646_870_871;

export interface Loaded {
  agent: LayaAgent;
  provider: Provider;
}

/** Which file the loader is on. `loadBundle` fetches the four JSON files first --
 *  one of which is the 34 MB tokenizer -- and only reports progress for
 *  `model.onnx`, so without this the UI sits at 0% through a large download and
 *  looks wedged. */
export type Phase = "config" | "model";

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
  onProgress("config", 0, TOKENIZER_BYTES);
  try {
    const { agent, provider } = await loadAgent(MODEL_URL, {
      providers: ["webgpu", "wasm"],
      cacheName: "laya-models",
      // onnxruntime-web fetches these at runtime; vite.config.ts copies them to dist/ort/.
      wasmPaths: `${import.meta.env.BASE_URL}ort/`,
      onProgress: (p: LoadProgress) => {
        phase = "model";
        received = p.received;
        onProgress("model", p.received, p.total ?? MODEL_BYTES);
      },
    });
    return { agent, provider };
  } catch (error) {
    // Naming the file and the byte count turns "Load failed" into something
    // actionable: a browser that gave up 300 MB into model.onnx is a different
    // problem from one that never got the tokenizer.
    const failure: Failure = {
      phase,
      received,
      message: error instanceof Error ? error.message : String(error),
    };
    throw Object.assign(new Error(failure.message), failure);
  }
}

export const hasWebGPU = (): boolean => "gpu" in navigator;

/** Whether a previous visit already paid for the model. */
export async function isCached(): Promise<boolean> {
  try {
    if (typeof caches === "undefined") return false;
    const cache = await caches.open("laya-models");
    return (await cache.match(MODEL_URL + "model.onnx")) !== undefined;
  } catch {
    return false;
  }
}
