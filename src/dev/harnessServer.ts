// The dev harness's fake civitai, on the `fetch` side.
//
// 🔴 WHY THIS EXISTS AT ALL — THE PORT MOVED WHERE "UNANSWERED" LANDS. Before
// the `@civitai/sdk` port the block asked the HOST for a generation over
// `postMessage`, and `Harness.tsx` answered only `REQUEST_TOKEN`, so an
// estimate or a submit simply timed out inside the page. It now asks a SERVER
// over `fetch` — which, left alone, means `pnpm dev:harness` fires real,
// money-shaped POSTs at civitai.com from localhost, signed with the harness's
// deliberately-invalid mock JWT. They cannot spend anything (the token does not
// verify) and today they 404 (the four `/blocks/workflows/*` routes are not
// deployed), but sending them is wrong on both counts: it leaks a dev loop onto
// production infrastructure, and it leaves the harness unable to demonstrate
// the one flow this block exists for.
//
// So the harness serves those routes itself, with the SAME contract the real
// routes declare — `{ snapshot }` on 2xx, resolve-vs-throw for failures — and
// runs a small in-memory workflow that actually progresses from `pending` to
// `succeeded`. Anything it does not recognise falls through to the real
// `fetch`, so nothing else about the page changes.
//
// Dev-only: `main.tsx` installs it exactly when `VITE_DEV_HARNESS=true`, which
// `.env.production` does not set.

import { __configurePlatform } from '../platform/index.js';

/** Mock showcase output, so a completed generation renders something. */
const RESULT_IMAGE = 'https://picsum.photos/seed/civitai-gen/512/512';

/** How long a harness generation "runs" before it reports success. */
const RUN_MS = 3_000;

interface HarnessWorkflow {
  id: string;
  startedAt: number;
  canceled: boolean;
  cost: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build the harness server's `fetch`.
 *
 * Separate from `installHarnessServer` so it can be composed with a scripted
 * transport in a test. `__configurePlatform` replaces its overrides WHOLESALE,
 * so a test that installed a fake transport and then called the installer would
 * silently lose it and fall back to a real `IframeTransport` with no host —
 * which does not fail, it HANGS until `initialize()`'s 10s timeout.
 */
export function createHarnessFetch(): typeof fetch {
  const workflows = new Map<string, HarnessWorkflow>();
  let serial = 0;
  const realFetch = globalThis.fetch.bind(globalThis);

  const snapshotFor = (wf: HarnessWorkflow) => {
    if (wf.canceled) return { workflowId: wf.id, status: 'canceled' as const, cost: { total: wf.cost } };
    const done = Date.now() - wf.startedAt >= RUN_MS;
    return done
      ? {
          workflowId: wf.id,
          status: 'succeeded' as const,
          cost: { total: wf.cost },
          imageUrls: [RESULT_IMAGE],
        }
      : { workflowId: wf.id, status: 'processing' as const, cost: { total: wf.cost } };
  };

  const harnessFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString(), location.href);
    if (!url.pathname.startsWith('/api/v1/blocks/')) return realFetch(input as RequestInfo, init);

    const route = url.pathname.replace('/api/v1/blocks/', '');
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;

    switch (route) {
      case 'buzz':
        return json({ blue: 120, green: 0, yellow: 480 });

      case 'workflows/estimate':
        // A deterministic price that is visibly not a placeholder zero, so the
        // CTA's cost label is exercised.
        return json({ snapshot: { workflowId: 'whatif', status: 'pending', cost: { total: 34 } } });

      case 'workflows/submit': {
        // 🔴 MIRROR THE ROUTE'S OWN 400, because it is the single easiest thing
        // for a caller to get wrong: `idempotencyKey` is REQUIRED and bounded by
        // `/^[A-Za-z0-9_-]{1,64}$/`. A harness that accepted anything would hide
        // exactly the defect that costs a viewer a double charge in production.
        const key = body.idempotencyKey;
        if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
          return json({ error: 'Invalid request body' }, 400);
        }
        serial += 1;
        const id = `2-${serial}`;
        workflows.set(id, { id, startedAt: Date.now(), canceled: false, cost: 34 });
        return json({ snapshot: { workflowId: id, status: 'pending', cost: { total: 34 } } });
      }

      case 'workflows/poll': {
        const wf = workflows.get(String(body.workflowId));
        if (!wf) return json({ message: 'workflow not found' }, 404);
        return json({ snapshot: snapshotFor(wf) });
      }

      case 'workflows/cancel': {
        const wf = workflows.get(String(body.workflowId));
        if (!wf) return json({ message: 'workflow not found' }, 404);
        wf.canceled = true;
        return json({ snapshot: snapshotFor(wf) });
      }

      default:
        // Unhandled block routes answer the way an undeployed one does, rather
        // than silently succeeding.
        return new Response('<!DOCTYPE html><html><body>404</body></html>', {
          status: 404,
          headers: { 'Content-Type': 'text/html' },
        });
    }
  };

  return harnessFetch;
}

/**
 * Point the platform's REST calls at the harness server.
 *
 * Passes ONLY `fetch`, leaving `transport` unset — the harness drives the REAL
 * `IframeTransport` by posting a `BLOCK_INIT` at it (see `Harness.tsx`), and
 * overriding the transport here would disconnect the two.
 */
export function installHarnessServer(): void {
  __configurePlatform({ fetch: createHarnessFetch() });
}
