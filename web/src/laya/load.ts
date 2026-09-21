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

import * as ort from "onnxruntime-web";
import { LayaAgent } from "./vendor/agent.ts";
import { LayaTokenizer, type TokenizerConfig, type TokenizerJson } from "./vendor/tokenizer.ts";
import type { OnnxConfig, Provider } from "./vendor/session.ts";
import { DirectRunner, type OptLevel } from "./runner.ts";
import type { AgentConfig } from "./vendor/types.ts";
import { mark } from "./trace.ts";
import {
  cachedBytes,
  clearModelCache,
  downloadBytes,
  downloadJson,
  pruneStaleChunks,
  type Progress,
} from "./download.ts";

const DEFAULT_MODEL_URL = "https://huggingface.co/mizchi/laya-multilingual-onnx/resolve/main/";

/** `?model=<base-url>` points the loader at another bundle.
 *
 *  A host has to satisfy three things at once -- HTTPS, CORS, and Range --
 *  and whether it does is only knowable by trying. Making the URL a parameter
 *  means a candidate can be tested from a phone without a redeploy, and an
 *  int8 bundle can be tried without committing to shipping it. */
export const MODEL_URL = ((): string => {
  const given = new URLSearchParams(location.search).get("model");
  if (!given) return DEFAULT_MODEL_URL;
  try {
    const url = new URL(given, location.href);
    if (url.protocol !== "https:") return DEFAULT_MODEL_URL;
    return url.href.endsWith("/") ? url.href : url.href + "/";
  } catch {
    return DEFAULT_MODEL_URL;
  }
})();

export const usingCustomModel = (): boolean => MODEL_URL !== DEFAULT_MODEL_URL;
export const TOKENIZER_BYTES = 34_363_188;
/** The default bundle's size. A bundle named by `?model=` reports its own,
 *  so the progress bar follows what is actually being fetched. */
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
    mark("load:start", `${MODEL_URL} | ${navigator.userAgent.slice(0, 90)}`);
    // Entries from an earlier chunk size can never be read again; reclaim them
    // before asking the browser for several hundred more MB.
    await pruneStaleChunks();
    mark("prune:done");
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
    mark("config:done", `tokenizer ${JSON.stringify(tokenizerJson).length} chars`);
    if (onnxConfig.format !== "laya-onnx") {
      throw new Error(`Not a Laya ONNX bundle: ${MODEL_URL}`);
    }

    phase = "model";
    received = 0;
    let lastMark = 0;
    const model = await downloadBytes(MODEL_FILE, (p: Progress) => {
      received = p.received;
      onProgress("model", p.received, p.total);
      // One mark per 64 MB: enough to see where a download stops, few enough
      // not to be the thing that slows it down.
      if (p.received - lastMark >= 64 * 1024 * 1024) {
        lastMark = p.received;
        mark("model:chunk", `${Math.round(p.received / 1e6)} MB`);
      }
    });
    mark("model:done", `${model.byteLength} bytes`);

    phase = "session";
    onProgress("session", MODEL_BYTES, MODEL_BYTES);

    // Pin the wasm backend to one thread.
    //
    // Left unset, onnxruntime-web sizes its thread pool from
    // hardwareConcurrency, and multi-threaded wasm needs SharedArrayBuffer,
    // which needs COOP/COEP response headers. GitHub Pages does not send
    // them, so the threads were never going to work here -- and asking for
    // them anyway is the one thing the Node runs, which load the same model
    // from the same bytes without incident, do differently.
    // `?threads=N` overrides this for testing.
    const params = new URLSearchParams(location.search);
    const threads = Number(params.get("threads"));
    ort.env.wasm.numThreads = Number.isFinite(threads) && threads > 0 ? threads : 1;
    // `?provider=wasm` forces the CPU backend. WebGPU is the default because it
    // is far faster, but it is also where this fails on some devices, and the
    // failure takes the tab with it rather than returning an error to catch --
    // so the choice has to be reachable from outside the code.
    const forced = params.get("provider");
    const providers: Provider[] =
      forced === "wasm" ? ["wasm"] : forced === "webgpu" ? ["webgpu"] : ["webgpu", "wasm"];
    // Halving the model to 325 MB did not move the failure, so it is not the
    // byte count. What both builds share is the graph, and everything ORT does
    // to it before running: parsing it, then rewriting it. These two knobs turn
    // each of those down.
    //
    // `?opt=disabled` skips every optimisation pass. If that is enough, the
    // fault is in a rewrite, not in the model.
    // `?proxy=1` runs onnxruntime in a worker, off the main thread, which also
    // gives it its own stack -- the relevant difference if the parser is
    // recursing deeper than WebKit's main-thread stack allows.
    const opt = params.get("opt");
    const level: OptLevel | undefined =
      opt === "disabled" || opt === "basic" || opt === "extended" || opt === "all"
        ? opt
        : undefined;
    if (params.get("proxy") === "1") ort.env.wasm.proxy = true;
    mark(
      "session:create:before",
      `threads=${ort.env.wasm.numThreads} providers=${providers.join(",")}` +
        ` opt=${level ?? "default"} proxy=${String(ort.env.wasm.proxy ?? false)}`,
    );
    const runner = await DirectRunner.create(model, {
      providers,
      ...(level ? { optimization: level } : {}),
      // onnxruntime-web fetches these at runtime; vite.config.ts copies them to dist/ort/.
      wasmPaths: `${import.meta.env.BASE_URL}ort/`,
      onAttempt: (provider, error) =>
        mark(`session:${provider}:failed`, String(error).slice(0, 160)),
    });
    mark("session:create:after", runner.provider);
    const agent = new LayaAgent({
      config,
      tokenizer: new LayaTokenizer(tokenizerJson, tokenizerConfig),
      runner,
    });
    mark("agent:ready", runner.provider);
    return { agent, provider: runner.provider };
  } catch (error) {
    // Naming the file and the byte count turns "Load failed" into something
    // actionable: a browser that gave up 300 MB in is a different problem from
    // one that never got the tokenizer.
    mark("load:error", error instanceof Error ? error.message.slice(0, 200) : String(error));
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

/** The real size of whichever bundle is in use.
 *
 *  MODEL_BYTES describes the default one. A bundle named by `?model=` is a
 *  different size -- the int8 build is 325 MB, not 647 -- and quoting the
 *  default's figure at someone about to download it is simply wrong. A split
 *  bundle states its size in its manifest; otherwise ask the file itself. */
async function bundleBytes(): Promise<number> {
  if (!usingCustomModel()) return MODEL_BYTES + TOKENIZER_BYTES;
  try {
    const manifest = await fetch(MODEL_FILE + ".parts.json");
    if (manifest.ok) {
      const { size } = (await manifest.json()) as { size: number };
      if (Number.isFinite(size) && size > 0) return size + TOKENIZER_BYTES;
    }
    const head = await fetch(MODEL_FILE, { headers: { Range: "bytes=0-0" } });
    const range = head.headers.get("content-range");
    const size = range
      ? Number(range.split("/")[1])
      : Number(head.headers.get("content-length"));
    if (Number.isFinite(size) && size > 0) return size + TOKENIZER_BYTES;
  } catch {
    // Unreachable host: fall through to the default's figure rather than
    // blocking the page on a number that is only for display.
  }
  return MODEL_BYTES + TOKENIZER_BYTES;
}

/** How much of the download a previous visit already paid for. */
export async function cachedProgress(): Promise<{ received: number; total: number }> {
  const [model, tokenizer, total] = await Promise.all([
    cachedBytes(MODEL_FILE),
    cachedBytes(TOKENIZER_FILE),
    bundleBytes(),
  ]);
  return { received: model + tokenizer, total };
}
