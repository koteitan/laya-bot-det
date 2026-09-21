/** kind:0 profiles in localStorage, picture bytes in the Cache API.
 *
 *  Profiles are small JSON and are read on every render, which is what
 *  localStorage is for. Picture bytes are not: a few hundred avatars would blow
 *  through the ~5 MB localStorage quota, so they go in a Cache API bucket, which
 *  is built for opaque binary and has a much larger budget.
 */

const KEY = "laya-bot-det:profiles";
const PICTURES = "laya-bot-det:pictures";

export interface Profile {
  name: string;
  display_name: string;
  about: string;
  nip05: string;
  picture: string;
  /** NIP-24 self-declaration. Kept for display only; it never feeds a judgement. */
  bot: boolean | null;
  created_at: number;
}

type Store = Record<string, Profile>;

function read(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}") as Store;
  } catch {
    return {};
  }
}

let store: Store = read();

export const getProfile = (pubkey: string): Profile | undefined => store[pubkey];
export const hasProfile = (pubkey: string): boolean => pubkey in store;

let flushTimer: number | undefined;
function flush() {
  clearTimeout(flushTimer);
  // Batched: a profile burst would otherwise serialise the whole store per event.
  flushTimer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
    } catch {
      // Quota exhausted or storage blocked. Keep the in-memory copy and carry on;
      // the next visit simply refetches.
    }
  }, 500) as unknown as number;
}

export function putProfile(pubkey: string, event: { content: string; created_at: number }): Profile {
  let meta: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(event.content || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch {
    // A malformed kind:0 still counts as "seen", so it is cached as an empty profile
    // rather than refetched on every visit.
  }
  const str = (k: string): string => (typeof meta[k] === "string" ? (meta[k] as string) : "");
  const profile: Profile = {
    name: str("name"),
    display_name: str("display_name") || str("displayName"),
    about: str("about"),
    nip05: str("nip05"),
    picture: str("picture"),
    bot: typeof meta.bot === "boolean" ? meta.bot : null,
    created_at: event.created_at,
  };
  const known = store[pubkey];
  if (known && known.created_at >= profile.created_at) return known;
  store[pubkey] = profile;
  flush();
  return profile;
}

export function clearCache(): void {
  store = {};
  try {
    localStorage.removeItem(KEY);
  } catch { /* storage blocked */ }
  void caches?.delete(PICTURES);
}

export const cachedProfileCount = (): number => Object.keys(store).length;

/** Put the picture bytes in the Cache API and hand back a URL the page can use. */
export async function cachePicture(url: string): Promise<string> {
  if (!url || !/^https?:\/\//.test(url) || typeof caches === "undefined") return url;
  try {
    const cache = await caches.open(PICTURES);
    const hit = await cache.match(url);
    if (hit) return URL.createObjectURL(await hit.blob());
    const response = await fetch(url, { mode: "cors" });
    if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("image/")) {
      return url;
    }
    await cache.put(url, response.clone());
    return URL.createObjectURL(await response.blob());
  } catch {
    // Opaque CORS responses, blocked storage, a dead host: fall back to letting
    // the <img> fetch it itself.
    return url;
  }
}
