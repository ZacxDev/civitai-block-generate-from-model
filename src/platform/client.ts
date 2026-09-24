// The one place this app reaches `@civitai/sdk`.
//
// `initialize()` waits for the host's BLOCK_INIT handshake, then hands back a
// client carrying the viewer, the slot context, the settings, the theme and —
// the part this block lives on — `site`, a REST client that signs every call
// with the block token the host minted.
//
// It is a module-level singleton because `initialize()` is a handshake, not a
// query: running it once per component would open a second conversation with
// the host and race the first. Everything below awaits the SAME promise.

import {
  getTransport,
  initialize,
  type BlockAppClient,
  type BlockSnapshot,
  type BlockTransport,
} from '@civitai/sdk';

/** Swapped in by tests so the block talks to a scripted host + a fake `fetch`. */
export interface PlatformOverrides {
  transport?: BlockTransport;
  fetch?: typeof fetch;
  siteUrl?: string;
}

let overrides: PlatformOverrides = {};
let clientPromise: Promise<BlockAppClient> | null = null;
let transportRef: BlockTransport | null = null;

/**
 * The transport `getClient()` initialises against.
 *
 * Held separately because `BlockAppClient` does NOT expose two fields this
 * block reads — `blockInstanceId` (the localStorage draft key) and
 * `token.buzzBudget` (the per-call ceiling the money predicate applies). Both
 * live only on the transport's synchronous snapshot, so the platform seam has
 * to keep the transport it handed to `initialize()` rather than re-deriving
 * one: `getTransport()` is cached on `globalThis`, but an OVERRIDDEN transport
 * (every test) is not, and re-calling `getTransport()` there would silently
 * read the real, never-initialised singleton instead.
 */
export function getPlatformTransport(): BlockTransport {
  const existing = transportRef;
  if (existing) return existing;
  const created = overrides.transport ?? getTransport();
  transportRef = created;
  return created;
}

/** The transport's synchronous snapshot. `ready: false` before the handshake. */
export function getSnapshot(): BlockSnapshot {
  return getPlatformTransport().snapshot.get();
}

/**
 * The initialised client, or the in-flight handshake.
 *
 * Callers `await` this rather than gating on a `ready` flag, so a REST call
 * issued during boot queues behind the handshake instead of failing.
 */
export function getClient(): Promise<BlockAppClient> {
  const existing = clientPromise;
  if (existing) return existing;
  const started = initialize({
    transport: getPlatformTransport(),
    ...(overrides.fetch ? { fetch: overrides.fetch } : {}),
    ...(overrides.siteUrl ? { siteUrl: overrides.siteUrl } : {}),
  });
  clientPromise = started;
  return started;
}

/**
 * Point the platform at a scripted host and a fake `fetch`, and drop any client
 * already built. Tests call this in `beforeEach`; nothing in production does.
 *
 * The reset is the load-bearing half: the singletons above would otherwise leak
 * the FIRST test's host into every later test, which reads as a passing suite
 * that never exercised its own fixtures.
 */
export function __configurePlatform(next: PlatformOverrides): void {
  overrides = next;
  clientPromise = null;
  transportRef = null;
}
