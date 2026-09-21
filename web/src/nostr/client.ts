/** rx-nostr wiring: relay discovery, the kind:1 stream, and kind:0 lookups. */

import { verifier } from "@rx-nostr/crypto";
import {
  createRxBackwardReq,
  createRxForwardReq,
  createRxNostr,
  uniq,
  type EventPacket,
} from "rx-nostr";
import { Observable, filter, map, merge, scan, share, takeUntil, timer } from "rxjs";
import { BOOTSTRAP, fallbackRelays } from "./relays.ts";

export const rxNostr = createRxNostr({ verifier });

export interface RelayList {
  source: "kind:10002" | "kind:3" | "fallback";
  read: string[];
}

/** NIP-65: ['r', url] with an optional read/write marker. No marker means both. */
function parse10002(event: { tags: string[][] }): string[] {
  const read: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "r" || !tag[1]?.startsWith("ws")) continue;
    // Drop relays the author only reads from; their notes are not written there.
    if ((tag[2] ?? "").toLowerCase() === "read") continue;
    read.push(tag[1]);
  }
  return read;
}

function parseKind3(content: string): string[] {
  try {
    const map = JSON.parse(content || "{}") as Record<string, { write?: boolean }>;
    return Object.entries(map)
      .filter(([url, p]) => url.startsWith("ws") && (p?.write ?? true))
      .map(([url]) => url);
  } catch {
    return [];
  }
}

/**
 * Resolve which relays to read someone's notes from.
 *
 * kind:10002 decides it when present; kind:3's legacy map is a fallback, never a
 * supplement. Emits as soon as a usable answer exists rather than waiting for
 * every bootstrap relay, and emits again if a newer kind:10002 arrives late.
 */
export function discoverRelays(pubkey: string, eoseMs = 5000): Observable<RelayList> {
  const req = createRxBackwardReq();
  const found = rxNostr.use(req, { on: { relays: BOOTSTRAP } }).pipe(
    uniq(),
    map((packet) => packet.event),
    // Keep whichever event is newest so far, and re-emit when a newer one lands.
    scan(
      (best, event) => (event.created_at > (best?.created_at ?? -1) ? event : best),
      null as null | EventPacket["event"],
    ),
    filter((event): event is EventPacket["event"] => event !== null),
    map((event): RelayList | null => {
      if (event.kind === 10002) {
        const read = parse10002(event);
        return read.length ? { source: "kind:10002", read } : null;
      }
      const read = parseKind3(event.content);
      return read.length ? { source: "kind:3", read } : null;
    }),
    filter((list): list is RelayList => list !== null),
    share(),
  );
  // The static set covers the case where nothing answers in time, but the search
  // keeps running: a kind:10002 that arrives late still replaces it, rather than
  // the client being stuck on the fallback for the rest of the session.
  const fallback = timer(eoseMs).pipe(
    map((): RelayList => ({ source: "fallback", read: fallbackRelays() })),
    takeUntil(found),
  );
  const result = merge(found, fallback);
  req.emit({ kinds: [10002, 3], authors: [pubkey], limit: 2 });
  return result;
}

/** Live kind:1 from the given relays. Forward strategy: new notes only. */
export function streamNotes(relays: string[]): Observable<EventPacket["event"]> {
  const req = createRxForwardReq();
  const notes = rxNostr
    .use(req, { on: { relays } })
    .pipe(uniq(), map((packet) => packet.event));
  req.emit({ kinds: [1], limit: 0 });
  return notes;
}

/** One backward pass for recent kind:1, so the page has something to show at once. */
export function seedNotes(relays: string[], limit = 100): Observable<EventPacket["event"]> {
  const req = createRxBackwardReq();
  const notes = rxNostr
    .use(req, { on: { relays } })
    .pipe(uniq(), map((packet) => packet.event));
  req.emit({ kinds: [1], limit });
  req.over();
  return notes;
}

/** Newest kind:0 for each requested pubkey. Relays cap author lists, so batch. */
export function fetchProfiles(
  relays: string[],
  pubkeys: string[],
  batch = 100,
): Observable<EventPacket["event"]> {
  const req = createRxBackwardReq();
  const events = rxNostr
    .use(req, { on: { relays } })
    .pipe(uniq(), map((packet) => packet.event));
  for (let i = 0; i < pubkeys.length; i += batch) {
    const chunk = pubkeys.slice(i, i + batch);
    req.emit({ kinds: [0], authors: chunk, limit: chunk.length });
  }
  req.over();
  return events;
}
