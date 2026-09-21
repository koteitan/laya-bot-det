/** A resumable download for the 647 MB model.
 *
 *  The vendored loader fetches the model as one response and caches it only
 *  once the whole thing has arrived. On a flaky connection that is all or
 *  nothing: a transfer that dies at 313 MB leaves nothing behind, and the next
 *  attempt starts from zero again.
 *
 *  Here the file is fetched as 16 MB ranges, each cached on its own. A dropped
 *  connection costs one chunk, a retry resumes where it stopped, and closing
 *  the tab does not throw the progress away -- the next visit picks up the
 *  chunks already in the Cache API. Hugging Face's CDN answers Range requests
 *  with 206 and exposes the headers cross-origin, which is what makes this
 *  possible.
 *
 *  Only the chunks are kept. Writing the assembled 647 MB back as a single
 *  entry as well would double the storage for no gain, and is exactly the kind
 *  of large single write a browser is most likely to refuse.
 */

const CHUNK_BYTES = 16 * 1024 * 1024;
const ATTEMPTS = 4;
const CACHE = "laya-models";

export interface DownloadProgress {
  received: number;
  total: number;
}

const chunkKey = (url: string, start: number): string => `${url}?chunk=${start}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function totalBytes(url: string): Promise<number> {
  // A HEAD would be cheaper, but the CDN redirect chain answers it inconsistently;
  // a one-byte ranged GET always comes back with a Content-Range to read.
  const response = await fetch(url, { headers: { Range: "bytes=0-0" } });
  if (!response.ok) throw new Error(`Failed to size ${url}: HTTP ${response.status}`);
  const range = response.headers.get("content-range");
  const total = range ? Number(range.split("/")[1]) : Number(response.headers.get("content-length"));
  if (!Number.isFinite(total) || total <= 0) throw new Error(`Could not determine the size of ${url}`);
  return total;
}

async function fetchChunk(url: string, start: number, end: number): Promise<Response> {
  let last: unknown;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (response.status !== 206) throw new Error(`Expected 206, got ${response.status}`);
      // Read it here rather than handing the stream on, so a mid-chunk failure is
      // caught by this retry loop instead of surfacing much later.
      const bytes = await response.arrayBuffer();
      const want = end - start + 1;
      if (bytes.byteLength !== want) {
        throw new Error(`Chunk at ${start}: got ${bytes.byteLength} of ${want} bytes`);
      }
      return new Response(bytes);
    } catch (error) {
      last = error;
      if (attempt < ATTEMPTS) await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw new Error(
    `Chunk at ${start} failed after ${ATTEMPTS} attempts: ` +
      (last instanceof Error ? last.message : String(last)),
  );
}

/** Bytes already cached, so the UI can say what a fresh attempt will actually cost. */
export async function cachedBytes(url: string): Promise<{ received: number; total: number } | null> {
  if (typeof caches === "undefined") return null;
  try {
    const cache = await caches.open(CACHE);
    const keys = await cache.keys();
    const prefix = `${url}?chunk=`;
    let received = 0;
    for (const request of keys) {
      if (!request.url.startsWith(prefix)) continue;
      const hit = await cache.match(request);
      received += Number(hit?.headers.get("content-length")) || 0;
    }
    return received ? { received, total: 0 } : null;
  } catch {
    return null;
  }
}

export async function downloadModel(
  url: string,
  onProgress: (p: DownloadProgress) => void,
): Promise<ArrayBuffer> {
  const cache = typeof caches === "undefined" ? null : await caches.open(CACHE).catch(() => null);
  const total = await totalBytes(url);
  const bytes = new Uint8Array(total);
  let received = 0;

  for (let start = 0; start < total; start += CHUNK_BYTES) {
    const end = Math.min(start + CHUNK_BYTES, total) - 1;
    const key = chunkKey(url, start);
    let response = cache ? await cache.match(key).catch(() => undefined) : undefined;
    if (!response) {
      response = await fetchChunk(url, start, end);
      if (cache) {
        // A chunk that cannot be stored is not worth failing over; it just costs
        // a refetch next time.
        await cache.put(key, response.clone()).catch(() => undefined);
      }
    }
    const buffer = await response.arrayBuffer();
    bytes.set(new Uint8Array(buffer), start);
    received += buffer.byteLength;
    onProgress({ received, total });
  }
  if (received !== total) throw new Error(`Assembled ${received} of ${total} bytes`);
  return bytes.buffer;
}

/** Cached JSON, for the 34 MB tokenizer that would otherwise be refetched every visit. */
export async function fetchJsonCached<T>(url: string): Promise<T> {
  const cache = typeof caches === "undefined" ? null : await caches.open(CACHE).catch(() => null);
  const hit = cache ? await cache.match(url).catch(() => undefined) : undefined;
  if (hit) return (await hit.json()) as T;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  if (cache) await cache.put(url, response.clone()).catch(() => undefined);
  return (await response.json()) as T;
}

export async function clearModelCache(): Promise<void> {
  try {
    await caches.delete(CACHE);
  } catch { /* storage blocked */ }
}
