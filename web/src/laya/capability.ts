/** Whether this device can load the model, and what to say when it cannot.
 *
 *  Measured on Safari 26.6.1 with single-node models, so that only the byte
 *  count varied:
 *
 *    34 MB   loads, create in 2.5 s
 *    134 MB  loads
 *    201 MB  sometimes loads, sometimes kills the tab
 *    325 MB  kills the tab
 *    341 MB  kills the tab
 *
 *  Those sizes behave the same with one node as with Laya's thousands, so the
 *  graph is not involved. Nor is the device's memory: contiguous 1.3 GB
 *  buffers and a wasm heap grown to 2.5 GB both allocate fine, and a 106-byte
 *  model runs on both backends.
 *
 *  The 201 MB result is what settles it. A threshold that a size sometimes
 *  clears is not a size limit, and there is no quantisation that lands
 *  reliably under it: int4 would put Laya near 180 MB, squarely in the range
 *  that works only sometimes. A feature that occasionally kills the browser
 *  tab is worse than one that is absent, so WebKit is warned off by default --
 *  `?model=` still lets anyone try.
 */

/** The largest size measured to load every time. */
const RELIABLE_BYTES = 134_000_000;

/** iOS and iPadOS run every browser on WebKit, and desktop Safari behaves the
 *  same way here, so this is about the engine rather than the app or the
 *  device. */
function isWebKit(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPod|iPad/.test(ua)) return true;
  if (/Chrome|Chromium|Edg\//.test(ua)) return false;
  return /Safari\//.test(ua) && /AppleWebKit\//.test(ua);
}

/** Chrome and Edge expose this, rounded to 0.25/0.5/1/2/4/8. Safari does not. */
function deviceMemoryGb(): number | null {
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === "number" ? value : null;
}

export interface Warning {
  /** True when loading is expected to kill the tab rather than merely be slow. */
  fatal: boolean;
  text: string;
}

export function memoryWarning(): Warning | null {
  if (isWebKit()) {
    return {
      fatal: true,
      text:
        "この端末（WebKit）では、モデルの読み込み中にタブが落ちます。" +
        `実測では ${Math.round(RELIABLE_BYTES / 1e6)} MB までは通り、200 MB あたりから` +
        "通ったり落ちたりし、325 MB 以上は必ず落ちます（既定のモデルは 647 MB）。" +
        "端末のメモリ量やモデルの構造が原因ではないことは測って確かめました。" +
        "量子化して小さくしても、確実に通る大きさには収まりません。" +
        "判定は Laya だけで行うので、この端末では結果が出ません。",
    };
  }
  const gb = deviceMemoryGb();
  if (gb !== null && gb < 4) {
    return {
      fatal: true,
      text:
        `この端末の搭載メモリは約 ${gb} GB です。読み込み中に 1.3 GB 前後を使うため、` +
        "途中でタブが落ちる可能性が高いです。",
    };
  }
  if (gb !== null && gb < 8) {
    return {
      fatal: false,
      text: `搭載メモリ約 ${gb} GB。読み込み中に 1.3 GB 前後を使うので、他のタブは閉じてください。`,
    };
  }
  return null;
}
