/** A Runner built from a session this file creates itself.
 *
 *  The vendored `OnnxRunner.create` fixes `graphOptimizationLevel` and does not
 *  take it as an option, so there is no way through it to ask onnxruntime to
 *  skip its rewrites. That matters now: halving the model from 647 MB to 325 MB
 *  did not move the failure, so it is not the byte count, and what both builds
 *  share is the graph and everything ORT does to it before running. Turning the
 *  optimiser off is the way to find out whether a rewrite is what WebKit cannot
 *  survive.
 *
 *  `Runner` is one method, so this reimplements it rather than modifying the
 *  vendored file, which stays an untouched copy.
 */

import * as ort from "onnxruntime-web";
import type { Runner } from "./vendor/agent.ts";
import type { Provider } from "./vendor/session.ts";
import type { Batch, RunnerOutput } from "./vendor/types.ts";

export type OptLevel = "disabled" | "basic" | "extended" | "all";

export interface CreateOptions {
  providers: Provider[];
  wasmPaths: string;
  /** Omitted means the vendored default: "basic" on webgpu, "all" on wasm. */
  optimization?: OptLevel;
  onAttempt?: (provider: Provider, error: unknown) => void;
}

export class DirectRunner implements Runner {
  constructor(
    readonly session: ort.InferenceSession,
    readonly provider: Provider,
  ) {}

  static async create(model: ArrayBuffer, options: CreateOptions): Promise<DirectRunner> {
    ort.env.wasm.wasmPaths = options.wasmPaths;
    for (const provider of options.providers) {
      if (provider === "webgpu" && !("gpu" in navigator)) {
        options.onAttempt?.(provider, "unavailable (navigator.gpu missing)");
        continue;
      }
      try {
        const session = await ort.InferenceSession.create(model, {
          executionProviders: [provider],
          // The vendored default, unless asked otherwise: the extended passes
          // include a fusion onnxruntime-web's WebGPU kernel cannot run against
          // this checkpoint's fp16 weights.
          graphOptimizationLevel:
            options.optimization ?? (provider === "webgpu" ? "basic" : "all"),
        });
        return new DirectRunner(session, provider);
      } catch (error) {
        options.onAttempt?.(provider, error);
      }
    }
    throw new Error(`No usable execution provider among ${options.providers.join(", ")}`);
  }

  async run(batch: Batch): Promise<RunnerOutput> {
    const output = await this.session.run({
      input_ids: new ort.Tensor("int64", batch.inputIds, [batch.rows, batch.length]),
      attention_mask: new ort.Tensor("int64", batch.attentionMask, [batch.rows, batch.length]),
      marker_pos: new ort.Tensor("int64", batch.markerPos, [batch.rows, batch.markers]),
      marker_mask: new ort.Tensor("bool", batch.markerMask, [batch.rows, batch.markers]),
      qtype: new ort.Tensor("int64", batch.qtype, [batch.rows]),
    });
    const logits = output["logits"];
    const actLogits = output["act_logits"];
    if (!logits || !actLogits) throw new Error("ONNX graph did not return logits/act_logits");
    if (logits.dims[0] !== batch.rows) {
      throw new Error(`logits for ${logits.dims[0]} rows, expected ${batch.rows}`);
    }
    return {
      rows: batch.rows,
      markers: Number(logits.dims[1]),
      actions: Number(actLogits.dims[1]),
      logits: logits.data as Float32Array,
      actLogits: actLogits.data as Float32Array,
    };
  }
}
