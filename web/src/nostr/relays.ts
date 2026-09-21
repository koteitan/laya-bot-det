/** Relay sets. Bootstrap relays are only for resolving someone's relay list. */

export const BOOTSTRAP = [
  "wss://directory.yabu.me",
  "wss://purplepag.es",
  "wss://relay.nostr.band",
  "wss://indexer.coracle.social",
];

const FALLBACK_JA = [
  "wss://yabu.me",
  "wss://nostr.compile-error.net",
  "wss://r.kojira.io",
  "wss://relay-jp.nostr.wirednet.jp",
  "wss://nrelay-jp.c-stellar.net",
  "wss://nostream.ocha.one",
  "wss://snowflare.cc",
];

const FALLBACK = [
  "wss://relay.damus.io",
  "wss://nostr-pub.wellorder.net",
  "wss://offchain.pub",
  "wss://relay.snort.social",
];

export const fallbackRelays = (): string[] =>
  navigator.language.startsWith("ja") ? [...FALLBACK_JA] : [...FALLBACK];
