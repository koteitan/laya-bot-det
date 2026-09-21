/** Run a 106-byte model through the app's own onnxruntime.
 *
 *  memtest loads onnxruntime from a CDN, which makes its `wasmPaths` ambiguous:
 *  a relative path there can resolve against the CDN rather than this site, and
 *  the resulting 404 looks exactly like the failure being investigated. This
 *  runs inside the app bundle instead -- the same import, the same wasmPaths,
 *  the same backends as loading the real model -- so a failure here is the same
 *  failure, minus every question about size, memory and time.
 */

import * as ort from "onnxruntime-web";
import { mark } from "./trace.ts";

export interface SelfTestResult {
  provider: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const TINY = `${import.meta.env.BASE_URL}tiny.onnx`;

export async function selfTest(provider: "wasm" | "webgpu"): Promise<SelfTestResult> {
  const started = Date.now();
  const wasmPaths = new URL(`${import.meta.env.BASE_URL}ort/`, location.origin).href;
  try {
    mark(`selftest:${provider}:start`, `wasmPaths=${wasmPaths}`);
    ort.env.wasm.wasmPaths = wasmPaths;
    ort.env.wasm.numThreads = 1;

    const response = await fetch(TINY);
    if (!response.ok) throw new Error(`tiny.onnx: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();

    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: [provider],
      graphOptimizationLevel: provider === "webgpu" ? "basic" : "all",
    });
    const out = await session.run({
      X: new ort.Tensor("float32", new Float32Array([1, 1]), [1, 2]),
    });
    const y = Array.from(out.Y!.data as Float32Array);
    const ok = y[0] === 4 && y[1] === 6;
    mark(`selftest:${provider}:done`, ok ? "ok" : `wrong output ${y.join(",")}`);
    return {
      provider,
      ok,
      detail: ok ? `推論 OK [${y.join(", ")}]` : `出力が違う [${y.join(", ")}] 期待 [4, 6]`,
      ms: Date.now() - started,
    };
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    mark(`selftest:${provider}:fail`, detail.slice(0, 200));
    return { provider, ok: false, detail, ms: Date.now() - started };
  }
}

export const ortVersion = (): string =>
  (ort.env as { versions?: Record<string, string> }).versions?.web ?? "?";
