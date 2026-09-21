/** Resumable downloads for the files that are too big to lose.
 *
 *  The vendored loader fetches each file as one response and caches it only
 *  once the whole thing has arrived. On a flaky connection that is all or
 *  nothing: a transfer that dies at 313 MB leaves nothing behind, and the next
 *  attempt starts from zero again.
 *
 *  Here a file is fetched as 8 MB ranges, each cached on its own. A dropped
 *  connection costs one chunk, a retry resumes where it stopped, and closing
 *  the tab does not throw the progress away -- the next visit picks up the
 *  chunks already in the Cache API. Hugging Face's CDN answers Range requests
 *  with 206 and exposes the headers cross-origin, which is what makes this
 *  possible.
 *
 *  Only the chunks are kept. Writing an assembled 647 MB back as a single entry
 *  as well would double the storage for no gain, and is exactly the kind of
 *  large single write a browser is most likely to refuse.
 *
 *  A file smaller than one chunk simply has one chunk, so the small JSON
 *  configs go through the same path without a special case.
 */

const CHUNK_BYTES = 8 * 1024 * 1024;
const ATTEMPTS = 4;
const CACHE = "laya-models";

export interface Progress {
  received: number;
  total: number;
}

/** The key names the exact byte range, not just its start.
 *
 *  Keying on the start alone ties the cache to whatever CHUNK_BYTES happened to
 *  be when it was written: shrinking chunks from 16 MB to 8 MB left the old
 *  16 MB body sitting at `?chunk=0`, where the new loop read it as if it were
 *  8 MB and counted 8 MB too many. Naming both ends means an entry written
 *  under a different chunk size simply misses, and is refetched. */
const chunkKey = (url: string, start: number, end: number): string =>
  `${url}?chunk=${start}-${end}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const openCache = async (): Promise<Cache | null> =>
  typeof caches === "undefined" ? null : caches.open(CACHE).catch(() => null);

async function totalBytes(url: string): Promise<number> {
  // A HEAD would be cheaper, but the CDN redirect chain answers it inconsistently;
  // a one-byte ranged GET always comes back with a Content-Range to read.
  const response = await fetch(url, { headers: { Range: "bytes=0-0" } });
  if (!response.ok) throw new Error(`Failed to size ${url}: HTTP ${response.status}`);
  const range = response.headers.get("content-range");
  const total = range
    ? Number(range.split("/")[1])
    : Number(response.headers.get("content-length"));
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error(`Could not determine the size of ${url}`);
  }
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

export async function downloadBytes(
  url: string,
  onProgress?: (p: Progress) => void,
): Promise<ArrayBuffer> {
  const cache = await openCache();
  const total = await totalBytes(url);
  const bytes = new Uint8Array(total);
  let received = 0;

  for (let start = 0; start < total; start += CHUNK_BYTES) {
    const end = Math.min(start + CHUNK_BYTES, total) - 1;
    const want = end - start + 1;
    const key = chunkKey(url, start, end);

    let buffer: ArrayBuffer | null = null;
    const hit = cache ? await cache.match(key).catch(() => undefined) : undefined;
    if (hit) {
      const cached = await hit.arrayBuffer();
      // Never trust a cached body's length. A wrong one here would either
      // overrun `bytes.set` or silently miscount, and refetching is cheap
      // next to either.
      if (cached.byteLength === want) buffer = cached;
      else await cache?.delete(key).catch(() => undefined);
    }
    if (!buffer) {
      const response = await fetchChunk(url, start, end);
      if (cache) {
        // A chunk that cannot be stored is not worth failing over; it just costs
        // a refetch next time.
        await cache.put(key, response.clone()).catch(() => undefined);
      }
      buffer = await response.arrayBuffer();
    }
    bytes.set(new Uint8Array(buffer), start);
    received += buffer.byteLength;
    onProgress?.({ received, total });
  }
  if (received !== total) throw new Error(`Assembled ${received} of ${total} bytes from ${url}`);
  return bytes.buffer;
}

export async function downloadJson<T>(
  url: string,
  onProgress?: (p: Progress) => void,
): Promise<T> {
  const bytes = await downloadBytes(url, onProgress);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/** Bytes of `url` already in the cache, so the UI can say what a fresh attempt costs. */
export async function cachedBytes(url: string): Promise<number> {
  const cache = await openCache();
  if (!cache) return 0;
  try {
    const prefix = `${url}?chunk=`;
    let received = 0;
    for (const request of await cache.keys()) {
      if (!request.url.startsWith(prefix)) continue;
      // Read the size from the key rather than the stored body, so a stale
      // entry cannot inflate the figure the UI shows.
      const [start, end] = request.url.slice(prefix.length).split("-").map(Number);
      if (Number.isFinite(start) && Number.isFinite(end)) received += end - start + 1;
    }
    return received;
  } catch {
    return 0;
  }
}

/** Drop chunk entries written under the older `?chunk=<start>` key.
 *
 *  Those are unreachable now that keys name both ends of the range, so they
 *  would sit there holding a few hundred MB that nothing can ever read. */
export async function pruneStaleChunks(): Promise<number> {
  const cache = await openCache();
  if (!cache) return 0;
  let dropped = 0;
  try {
    for (const request of await cache.keys()) {
      const query = new URL(request.url).search;
      const match = /^\?chunk=(.*)$/.exec(query);
      if (match && !match[1]!.includes("-")) {
        await cache.delete(request).catch(() => undefined);
        dropped++;
      }
    }
  } catch {
    // Storage blocked; there is nothing to prune.
  }
  return dropped;
}

export async function clearModelCache(): Promise<void> {
  try {
    await caches.delete(CACHE);
  } catch {
    // Storage blocked; nothing was cached to begin with.
  }
}
