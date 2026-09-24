// The viewer's Buzz balance, over REST.
//
// The bridge op was `GET_BUZZ_BALANCE` → `BUZZ_BALANCE_RESULT`, which the host
// answered from its `blocks.getMyBuzzBalance` tRPC mutation. The REST twin is
// `GET /api/v1/blocks/buzz` (scope `buzz:read:self`), and its docblock states
// that it returns the SAME projection field for field — `{ blue, green, yellow }`
// as a BARE object with no envelope — specifically so a consumer can switch
// transports without a shape change.
//
// Unlike the four `/workflows/*` routes, this one IS deployed: unauthenticated
// it answers `401 {"error":"Block token required"}` in JSON (measured
// 2026-09-24), which is what an existing block route answers.
//
// ⚠️ ONE KNOWN DIVERGENCE, stated by the route itself: the tRPC procedure also
// evaluates the `app-blocks-enabled` kill-switch against the token subject and
// charges the per-instance catalog rate-limit bucket. This route does neither.
// It is a read of the viewer's own balance, so the practical effect is that a
// killed app can still render a balance it cannot spend.

import { getClient } from './client.js';

/**
 * The viewer's per-pool balance, in the domain-clamped set a Civitai App can
 * read. Never includes the platform-internal pools (`red`/`purple`).
 */
export interface BuzzBalance {
  blue: number;
  green: number;
  yellow: number;
}

/** A missing pool reads 0, exactly as the server's own projection defaults it. */
export async function fetchBuzzBalance(): Promise<BuzzBalance> {
  const app = await getClient();
  const res = await app.site.get<Partial<BuzzBalance>>('blocks/buzz');
  return {
    blue: res?.blue ?? 0,
    green: res?.green ?? 0,
    yellow: res?.yellow ?? 0,
  };
}
