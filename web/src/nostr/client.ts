/** rx-nostr wiring: relay discovery, the kind:1 stream, and kind:0 lookups.
 *
 *  Every request here is built inside its Observable rather than beforehand.
 *  `RxReq` pushes filters through a plain Subject, so anything emitted before
 *  something subscribes is dropped on the floor and the relay is never asked --
 *  measurably: emit-then-subscribe yields 0 events where subscribe-then-emit
 *  yields the requested 3.
 */

import { verifier } from "@rx-nostr/crypto";
import {
  createRxBackwardReq,
  createRxForwardReq,
  createRxNostr,
  uniq,
  type EventPacket,
  type LazyFilter,
} from "rx-nostr";
import { Observable, filter, map, merge, scan, share, takeUntil, timer } from "rxjs";
import { BOOTSTRAP, fallbackRelays } from "./relays.ts";

export const rxNostr = createRxNostr({ verifier });

export type NostrEvent = EventPacket["event"];

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

/** One backward request, subscribed before its filters are emitted. */
function backward(relays: string[], filters: LazyFilter[]): Observable<NostrEvent> {
  return new Observable<NostrEvent>((subscriber) => {
    const req = createRxBackwardReq();
    const sub = rxNostr
      .use(req, { on: { relays } })
      .pipe(uniq(), map((packet) => packet.event))
      .subscribe(subscriber);
    for (const f of filters) req.emit(f);
    req.over();
    return () => sub.unsubscribe();
  });
}

/**
 * Resolve which relays to read notes from.
 *
 * kind:10002 decides it when present; kind:3's legacy map is a fallback, never a
 * supplement. The static set is emitted if nothing answers in time, but the
 * search keeps running, so a late kind:10002 still replaces it.
 */
export function discoverRelays(pubkey: string, eoseMs = 5000): Observable<RelayList> {
  return new Observable<RelayList>((subscriber) => {
    const req = createRxBackwardReq();
    const found = rxNostr.use(req, { on: { relays: BOOTSTRAP } }).pipe(
      uniq(),
      map((packet) => packet.event),
      // Keep whichever event is newest so far, and re-emit when a newer one lands.
      scan(
        (best, event) => (event.created_at > (best?.created_at ?? -1) ? event : best),
        null as null | NostrEvent,
      ),
      filter((event): event is NostrEvent => event !== null),
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
    const fallback = timer(eoseMs).pipe(
      map((): RelayList => ({ source: "fallback", read: fallbackRelays() })),
      takeUntil(found),
    );
    const sub = merge(found, fallback).subscribe(subscriber);
    req.emit({ kinds: [10002, 3], authors: [pubkey], limit: 2 });
    return () => sub.unsubscribe();
  });
}

/** Live kind:1 from the given relays. Forward strategy: new notes only. */
export function streamNotes(relays: string[]): Observable<NostrEvent> {
  return new Observable<NostrEvent>((subscriber) => {
    const req = createRxForwardReq();
    const sub = rxNostr
      .use(req, { on: { relays } })
      .pipe(uniq(), map((packet) => packet.event))
      .subscribe(subscriber);
    req.emit({ kinds: [1], limit: 0 });
    return () => sub.unsubscribe();
  });
}

/** One backward pass for recent kind:1, so the page has something to show at once. */
export const seedNotes = (relays: string[], limit = 100): Observable<NostrEvent> =>
  backward(relays, [{ kinds: [1], limit }]);

/** Newest kind:0 for each requested pubkey. Relays cap author lists, so batch. */
export function fetchProfiles(
  relays: string[],
  pubkeys: string[],
  batch = 100,
): Observable<NostrEvent> {
  const filters: LazyFilter[] = [];
  for (let i = 0; i < pubkeys.length; i += batch) {
    const chunk = pubkeys.slice(i, i + batch);
    filters.push({ kinds: [0], authors: chunk, limit: chunk.length });
  }
  return backward(relays, filters);
}
