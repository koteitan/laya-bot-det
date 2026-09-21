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
export const MODEL_BYTES = 647_000_000 + 34_400_000;

export interface Loaded {
  agent: LayaAgent;
  provider: Provider;
}

export async function load(onProgress: (p: LoadProgress) => void): Promise<Loaded> {
  const { agent, provider } = await loadAgent(MODEL_URL, {
    providers: ["webgpu", "wasm"],
    cacheName: "laya-models",
    // onnxruntime-web fetches these at runtime; vite.config.ts copies them to dist/ort/.
    wasmPaths: `${import.meta.env.BASE_URL}ort/`,
    onProgress,
  });
  return { agent, provider };
}

export const hasWebGPU = (): boolean => "gpu" in navigator;
