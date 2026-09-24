// A fake Civitai for the platform layer's own tests.
//
// The bridge port moved the real boundary: the block used to talk to a HOST over
// `postMessage`, and now talks to a SERVER over `fetch`. So the fake sits where
// the boundary moved to — a `fetch` implementation serving the four
// `/api/v1/blocks/workflows/*` routes and `/api/v1/blocks/buzz`, plus
// `@civitai/sdk`'s own `createFakeTransport` standing in for the host handshake
// and the two host-UI requests that stayed on the bridge.
//
// 🔴 IT MIRRORS THE ROUTES' ERROR CONTRACT, WHICH IS THE WHOLE POINT. Each real
// route answers 2xx IFF the procedure RESOLVED — so a budget rejection is a 200
// carrying a `status:'failed'` snapshot that QUOTES the price it refused, and
// only a thrown procedure is a non-2xx. A fake that collapsed a refusal into a
// 4xx would make the block's top-up recovery path untestable and would certify
// a client that gets it wrong.
//
// 🔴 IT IS NOT PROOF THE ROUTES BEHAVE THIS WAY. It is proof the CLIENT reads
// the contract the route files declare. The routes are undeployed (404 in
// production as of 2026-09-24), so nothing here has been checked against a real
// server.

import { createFakeTransport, type FakeTransport } from '@civitai/sdk/testing';
import type { BlockWorkflowSnapshot } from '@civitai/app-sdk/blocks';

import { __configurePlatform } from './client.js';

export const SITE_URL = 'https://civitai.test/api/v1';

/** One recorded call against the fake server. */
export interface RecordedCall {
  method: string;
  /** Path below the site base, e.g. `blocks/workflows/submit`. */
  path: string;
  /** The `Authorization` header verbatim, so a test can pin that the token was sent. */
  authorization: string | null;
  body: unknown;
}

/** One answer the fake can give. */
export interface RouteResponse {
  status: number;
  body: unknown;
}

/**
 * What the fake answers a given route with. A function sees the request body.
 *
 * 🔴 IT MAY RETURN A PROMISE, AND THAT IS NOT A CONVENIENCE. Without it every
 * reply lands in REQUEST ORDER, so no test can build the state a latest-wins
 * guard exists for — two reads in flight where the FIRST answers SECOND. A
 * sweep against that guard SURVIVED a fully green suite for exactly this
 * reason: the fake could not express the case, so the assertion was about
 * request ordering rather than about the guard.
 */
export type RouteAnswer =
  | RouteResponse
  | ((body: Record<string, unknown>) => RouteResponse | Promise<RouteResponse>);

export interface FakeServer {
  /** Every call, in order. */
  readonly calls: RecordedCall[];
  /** Standing answer for a path below the site base. Replaces any previous one. */
  route(path: string, answer: RouteAnswer): void;
  /** The `fetch` to hand the SDK. */
  fetch: typeof fetch;
}

/** A 200 carrying `{ snapshot }`, the shape all four workflow routes return. */
export function snapshotReply(snapshot: Partial<BlockWorkflowSnapshot>): {
  status: number;
  body: unknown;
} {
  return { status: 200, body: { snapshot } };
}

/**
 * A non-2xx the way the routes emit one.
 *
 * `{ message }` rather than `{ error }`: the workflow routes funnel failures
 * through `handleEndpointError`, whose envelope is `{ message }`. The 401/400
 * guards ABOVE that try/catch use `{ error }`, which is why both keys are
 * exercised — `@civitai/sdk`'s http client reads either.
 */
export function errorReply(status: number, message: string): { status: number; body: unknown } {
  return { status, body: { message } };
}

export function createFakeServer(): FakeServer {
  const calls: RecordedCall[] = [];
  const routes = new Map<string, RouteAnswer>();

  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const path = url.pathname.replace(/^\/api\/v1\//, '');
    const headers = new Headers(init?.headers ?? {});
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const body: unknown = raw ? JSON.parse(raw) : undefined;

    calls.push({
      method: init?.method ?? 'GET',
      path,
      authorization: headers.get('authorization'),
      body,
    });

    const answer = routes.get(path);
    if (!answer) {
      // What civitai answers for a route that does not exist: Next's HTML 404.
      // Spelled as HTML on purpose — it is what the four workflow routes
      // actually return in production today, and a JSON 404 here would make the
      // fake kinder than the thing it stands in for.
      return new Response('<!DOCTYPE html><html><body>404</body></html>', {
        status: 404,
        headers: { 'Content-Type': 'text/html' },
      });
    }

    const resolved =
      typeof answer === 'function'
        ? await answer((body ?? {}) as Record<string, unknown>)
        : answer;
    return new Response(JSON.stringify(resolved.body), {
      status: resolved.status,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  return {
    calls,
    route(path, answer) {
      routes.set(path, answer);
    },
    fetch: fetchImpl as typeof fetch,
  };
}

export interface FakePlatform {
  transport: FakeTransport;
  server: FakeServer;
}

/**
 * Point the platform at a scripted host and a fake server, and drop any client
 * a previous test built. Call from `beforeEach`.
 *
 * The reset is the load-bearing half — see `__configurePlatform`.
 */
export function installFakePlatform(
  snapshot: Parameters<typeof createFakeTransport>[0] = {},
): FakePlatform {
  const transport = createFakeTransport({
    blockInstanceId: 'bi_test',
    token: {
      raw: 'test.block.jwt',
      scopes: ['ai:write:budgeted', 'buzz:read:self'],
      expiresAt: new Date(Date.now() + 15 * 60_000),
      buzzBudget: 50,
    },
    viewer: { id: 2, username: 'test-viewer', status: 'active' },
    context: {
      slotId: 'model.sidebar_top',
      modelId: 555,
      modelVersionId: 2835132,
      modelName: 'Luna_arianaV3',
      modelType: 'LORA',
      modelNsfwLevel: 1,
    },
    ...snapshot,
  });
  // 🔴 A STANDING `REQUEST_TOKEN` ANSWER, OR A 401 HANGS THE SUITE. The SDK's
  // http client retries a 401 once with `getToken({ fresh: true })`, which sends
  // `REQUEST_TOKEN` over the bridge; `createFakeTransport` leaves an unanswered
  // request pending FOREVER (no timeout), so a test exercising an auth failure
  // would time out rather than fail, and read as a hung runner rather than a
  // refusal. The refreshed token is deliberately DIFFERENT so a test can tell
  // the retry apart from the first attempt by the `Authorization` header alone.
  transport.handle('REQUEST_TOKEN', () => ({
    token: {
      raw: 'test.block.jwt.refreshed',
      scopes: ['ai:write:budgeted', 'buzz:read:self'],
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      buzzBudget: 50,
    },
  }));
  const server = createFakeServer();
  __configurePlatform({ transport, fetch: server.fetch, siteUrl: SITE_URL });
  return { transport, server };
}
