import { beforeEach, describe, expect, it } from 'vitest';

import {
  createWorkflowClient,
  fetchBuzzBalance,
  HOST_SYNTHESISED_WORKFLOW_ID,
  WorkflowEstimateError,
  WorkflowSubmitError,
  type WorkflowClient,
} from '../platform/index.js';
import {
  errorReply,
  installFakePlatform,
  snapshotReply,
  type FakeServer,
} from '../platform/testing.js';

/**
 * The platform layer against a fake SERVER.
 *
 * 🔴 THIS IS THE ONLY FILE IN THE REPO THAT TESTS THE TRANSPORT. Every other
 * suite mocks `src/platform/` wholesale (see `src/test/test-utils.ts`), so none
 * of them can see a wrong path, a dropped field, or a misread error contract —
 * they pin the block's behaviour GIVEN a platform. This file pins the platform
 * GIVEN a server, and the two together are the port's coverage.
 *
 * 🔴 AND IT IS NOT EVIDENCE THE ROUTES BEHAVE THIS WAY. The four
 * `/api/v1/blocks/workflows/*` routes are merged in `civitai/civitai`
 * (2a2eb0fe2f, #5068) and NOT DEPLOYED — all four answer `404 text/html` in
 * production as of 2026-09-24, where a deployed block route answers
 * `401 {"error":"Block token required"}` in JSON. What is asserted here is that
 * the CLIENT reads the contract those route files declare. Nothing below has
 * been checked against a real civitai.com.
 *
 * The one route this block uses that IS deployed is `GET /api/v1/blocks/buzz`
 * (401 JSON unauthenticated, measured the same day) — still fake-served here,
 * because a test that needs a real block token is not a unit test.
 */

const WF = {
  kind: 'textToImage',
  modelId: 555,
  modelVersionId: 2835132,
  params: { prompt: 'a cat', quantity: 1 },
} as const;

let server: FakeServer;
let client: WorkflowClient;

beforeEach(() => {
  ({ server } = installFakePlatform());
  client = createWorkflowClient();
});

/** The last call the fake server recorded, for the path assertions. */
function lastCall() {
  const call = server.calls.at(-1);
  if (!call) throw new Error('no call was made');
  return call;
}

describe('estimate', () => {
  it('POSTs { body } to blocks/workflows/estimate, bearing the block token', async () => {
    server.route('blocks/workflows/estimate', snapshotReply({
      workflowId: 'whatif',
      status: 'pending',
      cost: { total: 34 },
    }));

    const snap = await client.estimate(WF);

    expect(snap.cost?.total).toBe(34);
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: 'blocks/workflows/estimate',
      authorization: 'Bearer test.block.jwt',
      body: { body: WF },
    });
  });

  it('resolves a price of 0 — a cache hit is a real quote, and 0 is falsy', async () => {
    server.route('blocks/workflows/estimate', snapshotReply({
      workflowId: 'whatif',
      status: 'pending',
      cost: { total: 0 },
    }));

    await expect(client.estimate(WF)).resolves.toMatchObject({ cost: { total: 0 } });
  });

  it("rejects a status:'failed' 200 as code 'failed', carrying the snapshot", async () => {
    server.route('blocks/workflows/estimate', snapshotReply({
      workflowId: 'whatif',
      status: 'failed',
      error: 'model not available',
    }));

    const err = await client.estimate(WF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowEstimateError);
    expect((err as WorkflowEstimateError).code).toBe('failed');
    expect((err as WorkflowEstimateError).snapshot.error).toBe('model not available');
  });

  it("rejects a failed estimate that DOES carry a price — still not a quote to spend against", async () => {
    server.route('blocks/workflows/estimate', snapshotReply({
      workflowId: 'whatif',
      status: 'failed',
      cost: { total: 12 },
    }));

    const err = await client.estimate(WF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowEstimateError);
    expect((err as WorkflowEstimateError).code).toBe('failed');
  });

  it("rejects a non-failed reply with no numeric cost as code 'no-cost'", async () => {
    server.route('blocks/workflows/estimate', snapshotReply({
      workflowId: 'whatif',
      status: 'pending',
    }));

    const err = await client.estimate(WF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowEstimateError);
    expect((err as WorkflowEstimateError).code).toBe('no-cost');
  });

  it('turns a non-2xx into the failure snapshot the bridge used to deliver', async () => {
    // The route's own envelope for a thrown procedure: `handleEndpointError`
    // answers `{ message }`, not `{ error }`.
    server.route('blocks/workflows/estimate', errorReply(500, 'orchestrator unavailable'));

    const err = await client.estimate(WF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowEstimateError);
    expect((err as WorkflowEstimateError).code).toBe('failed');
    // 🔴 The whole point of the translation: `App.tsx` branches on
    // `instanceof WorkflowEstimateError` and reads the reason off
    // `.snapshot.error`. A bare `ApiError` would fall out of that branch.
    expect((err as WorkflowEstimateError).snapshot).toMatchObject({
      workflowId: HOST_SYNTHESISED_WORKFLOW_ID,
      status: 'failed',
      error: 'orchestrator unavailable',
    });
  });

  it("reads the routes' OTHER envelope too — a 401 guard answers { error }, not { message }", async () => {
    // The 401/400 guards sit ABOVE `handleEndpointError` and use `{ error }`.
    // Both keys have to reach `.snapshot.error` or the reason is lost for
    // exactly the failures a viewer is most likely to hit.
    server.route('blocks/workflows/estimate', { status: 401, body: { error: 'Block token required' } });

    const err = await client.estimate(WF).catch((e: unknown) => e);
    expect((err as WorkflowEstimateError).snapshot.error).toBe('Block token required');
  });

  it('rejects a malformed 200 rather than returning a statusless snapshot', async () => {
    server.route('blocks/workflows/estimate', { status: 200, body: { snapshot: {} } });

    const err = await client.estimate(WF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/malformed response/);
  });

  it('surfaces the UNDEPLOYED route as a failure, not as a hang', async () => {
    // No `server.route(...)`: the fake answers a Next-style HTML 404, which is
    // exactly what civitai.com returns for these four paths today. Pinned so
    // the block's behaviour in that state is a known quantity rather than a
    // discovery on the day it ships.
    const err = await client.estimate(WF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowEstimateError);
    expect((err as WorkflowEstimateError).code).toBe('failed');
  });
});

describe('submit', () => {
  it('sends an idempotencyKey inside the charset the route enforces', async () => {
    server.route('blocks/workflows/submit', snapshotReply({ workflowId: '2-abc', status: 'pending' }));

    await client.submit(WF);

    const body = lastCall().body as { body: unknown; idempotencyKey: string };
    expect(body.body).toEqual(WF);
    // `BLOCK_IDEMPOTENCY_KEY_REGEX` in civitai/civitai — anything else 400s.
    expect(body.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('reuses a caller-supplied key verbatim, so a retry cannot double-charge', async () => {
    server.route('blocks/workflows/submit', snapshotReply({ workflowId: '2-abc', status: 'pending' }));

    await client.submit(WF, { idempotencyKey: 'job-7' });
    expect((lastCall().body as { idempotencyKey: string }).idempotencyKey).toBe('job-7');

    await client.submit(WF, { idempotencyKey: 'job-7' });
    expect((lastCall().body as { idempotencyKey: string }).idempotencyKey).toBe('job-7');
  });

  it('mints a DIFFERENT key per call when none is supplied — each call is a new logical submit', async () => {
    server.route('blocks/workflows/submit', snapshotReply({ workflowId: '2-abc', status: 'pending' }));

    await client.submit(WF);
    const first = (lastCall().body as { idempotencyKey: string }).idempotencyKey;
    await client.submit(WF);
    const second = (lastCall().body as { idempotencyKey: string }).idempotencyKey;

    expect(second).not.toBe(first);
  });

  it('🔴 RESOLVES a budget rejection — a priced refusal is the top-up recovery path', async () => {
    // Four server exits answer a budget rejection by RESOLVING with a
    // failure-shaped snapshot that QUOTES the price it refused to charge. The
    // route keeps that a 200 on purpose. Turning it into a rejection here would
    // erase the block's only route to the top-up CTA, so this is the single
    // assertion most worth protecting in the file.
    server.route('blocks/workflows/submit', snapshotReply({
      workflowId: 'whatif',
      status: 'failed',
      cost: { total: 60 },
      error: 'insufficient funds',
    }));

    await expect(client.submit(WF)).resolves.toMatchObject({
      status: 'failed',
      cost: { total: 60 },
    });
  });

  it.each<['succeeded' | 'canceled' | 'expired', string[] | undefined]>([
    ['succeeded', ['https://example.test/out.jpg']],
    ['canceled', undefined],
    ['expired', undefined],
  ])(
    'resolves a cost-less %s reply — only FAILED is a rejection candidate',
    async (status, imageUrls) => {
      server.route('blocks/workflows/submit', snapshotReply({
        workflowId: '2-abc',
        status,
        ...(imageUrls ? { imageUrls } : {}),
      }));

      await expect(client.submit(WF)).resolves.toMatchObject({ status });
    },
  );

  it("rejects a cost-less failure bearing the sentinel id as 'exception'", async () => {
    server.route('blocks/workflows/submit', snapshotReply({
      workflowId: HOST_SYNTHESISED_WORKFLOW_ID,
      status: 'failed',
      error: 'nack',
    }));

    const err = await client.submit(WF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowSubmitError);
    expect((err as WorkflowSubmitError).code).toBe('exception');
  });

  it("rejects a cost-less failure bearing a REAL workflow id as 'workflow-failed'", async () => {
    server.route('blocks/workflows/submit', snapshotReply({
      workflowId: '2-1758684000',
      status: 'failed',
      error: 'moderation',
    }));

    const err = await client.submit(WF).catch((e: unknown) => e);
    expect((err as WorkflowSubmitError).code).toBe('workflow-failed');
  });

  it.each(['failed-x', 'x-failed', 'FAILED'])(
    "treats %s as a REAL id — the sentinel compare is exact and case-sensitive",
    async (workflowId) => {
      // Near misses, each killing a different widening: `.startsWith` accepts
      // `failed-x`, `.endsWith` accepts `x-failed`, a case-folding compare
      // accepts `FAILED`. Every one of those widenings buys an unknown id the
      // reassuring "nothing was charged" arm, which is the direction that costs
      // a viewer money.
      server.route('blocks/workflows/submit', snapshotReply({ workflowId, status: 'failed' }));

      const err = await client.submit(WF).catch((e: unknown) => e);
      expect((err as WorkflowSubmitError).code).toBe('workflow-failed');
    },
  );

  it("turns a non-2xx into 'exception' — the block has no workflow to report", async () => {
    server.route('blocks/workflows/submit', errorReply(502, 'upstream refused'));

    const err = await client.submit(WF).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowSubmitError);
    expect((err as WorkflowSubmitError).code).toBe('exception');
    expect((err as WorkflowSubmitError).snapshot.error).toBe('upstream refused');
  });
});

describe('poll', () => {
  it('POSTs the workflowId to blocks/workflows/poll', async () => {
    server.route('blocks/workflows/poll', snapshotReply({ workflowId: '2-abc', status: 'processing' }));

    const snap = await client.poll('2-abc');

    expect(snap.status).toBe('processing');
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: 'blocks/workflows/poll',
      body: { workflowId: '2-abc' },
    });
  });

  it('sends waitSeconds when long polling is asked for', async () => {
    server.route('blocks/workflows/poll', snapshotReply({ workflowId: '2-abc', status: 'processing' }));

    await client.poll('2-abc', { waitSeconds: 15 });

    expect(lastCall().body).toEqual({ workflowId: '2-abc', waitSeconds: 15 });
  });

  it.each([0, undefined])('OMITS waitSeconds for %s — the route floors it to no hold anyway', async (waitSeconds) => {
    server.route('blocks/workflows/poll', snapshotReply({ workflowId: '2-abc', status: 'processing' }));

    await client.poll('2-abc', waitSeconds === undefined ? undefined : { waitSeconds });

    expect(lastCall().body).toEqual({ workflowId: '2-abc' });
    expect(lastCall().body).not.toHaveProperty('waitSeconds');
  });

  it('returns a non-terminal rate-limit reply as the result it is, not as a failure', async () => {
    // The route's rate-limit bucket RESOLVES with a deliberately non-terminal
    // snapshot rather than throwing a 429, so a paid, still-running generation
    // keeps its watch loop. Nothing here may reclassify that as an error.
    server.route('blocks/workflows/poll', snapshotReply({ workflowId: '2-abc', status: 'processing' }));

    await expect(client.poll('2-abc')).resolves.toMatchObject({ status: 'processing' });
  });
});

describe('cancel', () => {
  it('POSTs the workflowId and returns the re-read snapshot', async () => {
    server.route('blocks/workflows/cancel', snapshotReply({ workflowId: '2-abc', status: 'canceled' }));

    await expect(client.cancel('2-abc')).resolves.toMatchObject({ status: 'canceled' });
    expect(lastCall()).toMatchObject({
      method: 'POST',
      path: 'blocks/workflows/cancel',
      body: { workflowId: '2-abc' },
    });
  });

  it('does not fail on an ALREADY-TERMINAL workflow — the re-read reports the real state', async () => {
    server.route('blocks/workflows/cancel', snapshotReply({ workflowId: '2-abc', status: 'succeeded' }));

    await expect(client.cancel('2-abc')).resolves.toMatchObject({ status: 'succeeded' });
  });
});

describe('buzz balance', () => {
  it('GETs blocks/buzz and returns the three pools', async () => {
    server.route('blocks/buzz', { status: 200, body: { blue: 1, green: 2, yellow: 3 } });

    await expect(fetchBuzzBalance()).resolves.toEqual({ blue: 1, green: 2, yellow: 3 });
    expect(lastCall()).toMatchObject({
      method: 'GET',
      path: 'blocks/buzz',
      authorization: 'Bearer test.block.jwt',
    });
  });

  it('defaults a missing pool to 0, as the server projection does', async () => {
    server.route('blocks/buzz', { status: 200, body: { yellow: 7 } });

    await expect(fetchBuzzBalance()).resolves.toEqual({ blue: 0, green: 0, yellow: 7 });
  });

  it('propagates a refusal rather than reporting a zero balance', async () => {
    // 🔴 A FAILED READ MUST NOT LOOK LIKE AN EMPTY WALLET. `App.tsx` fails
    // toward NOT-a-shortfall on an unknown balance; a `{0,0,0}` on error would
    // instead assert the viewer is broke and offer to sell them Buzz for a
    // problem money cannot solve.
    server.route('blocks/buzz', { status: 403, body: { error: 'Invalid subject claim' } });

    await expect(fetchBuzzBalance()).rejects.toThrow(/Invalid subject claim/);
  });
});

describe('token handling', () => {
  it('retries a 401 once with a refreshed token', async () => {
    let attempt = 0;
    server.route('blocks/workflows/poll', () => {
      attempt += 1;
      return attempt === 1
        ? { status: 401, body: { error: 'expired' } }
        : snapshotReply({ workflowId: '2-abc', status: 'succeeded' });
    });

    await expect(client.poll('2-abc')).resolves.toMatchObject({ status: 'succeeded' });

    const auths = server.calls.map((c) => c.authorization);
    expect(auths).toEqual(['Bearer test.block.jwt', 'Bearer test.block.jwt.refreshed']);
  });
});
