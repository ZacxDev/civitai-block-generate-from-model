import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createHarnessFetch } from '../dev/harnessServer.js';
import { __configurePlatform, createWorkflowClient, fetchBuzzBalance } from '../platform/index.js';
import { installFakePlatform, SITE_URL } from '../platform/testing.js';

/**
 * The dev harness's fake civitai.
 *
 * 🔴 WHY A DEV-ONLY FILE IS WORTH A TEST. The `@civitai/sdk` port moved the
 * block's data path from `postMessage` to `fetch`, which means `pnpm
 * dev:harness` would otherwise send real POSTs at civitai.com from localhost.
 * `harnessServer.ts` is what stops that — so if it silently answers 404 for a
 * path the client actually calls, the harness is both leaky AND broken, and the
 * only way anyone finds out is by losing an afternoon to it.
 *
 * What is asserted is the JOIN: the real `createWorkflowClient` driving the real
 * harness server through a full estimate → submit → poll → succeeded cycle. Each
 * half tested alone would prove nothing about the seam between them — a path
 * spelled one way in the client and another in the server passes both.
 */

let transport: ReturnType<typeof installFakePlatform>['transport'];

beforeEach(() => {
  // The fake transport supplies the handshake and the token; the harness server
  // supplies the HTTP side. `__configurePlatform` replaces overrides wholesale,
  // so both must be passed in ONE call.
  ({ transport } = installFakePlatform());
  __configurePlatform({ transport, fetch: createHarnessFetch(), siteUrl: SITE_URL });
});

describe('dev harness server', () => {
  it('drives a generation from estimate to a succeeded poll', async () => {
    vi.useFakeTimers();
    try {
      const client = createWorkflowClient();

      const quote = await client.estimate({
        kind: 'textToImage',
        modelId: 1,
        modelVersionId: 2,
        params: { prompt: 'a cat', quantity: 1 },
      });
      expect(quote.cost?.total).toBe(34);

      const submitted = await client.submit({
        kind: 'textToImage',
        modelId: 1,
        modelVersionId: 2,
        params: { prompt: 'a cat', quantity: 1 },
      });
      expect(submitted.status).toBe('pending');
      expect(submitted.workflowId).toMatch(/^2-\d+$/);

      // Still running immediately after submit...
      await expect(client.poll(submitted.workflowId)).resolves.toMatchObject({
        status: 'processing',
      });

      // ...and terminal once the harness's run window has elapsed. Fake timers
      // so the assertion is about the state machine, not about waiting 3s.
      vi.advanceTimersByTime(5_000);
      await expect(client.poll(submitted.workflowId)).resolves.toMatchObject({
        status: 'succeeded',
        imageUrls: [expect.any(String)],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a running workflow', async () => {
    const client = createWorkflowClient();
    const submitted = await client.submit({
      kind: 'textToImage',
      modelId: 1,
      modelVersionId: 2,
      params: { prompt: 'a cat', quantity: 1 },
    });

    await expect(client.cancel(submitted.workflowId)).resolves.toMatchObject({
      status: 'canceled',
    });
  });

  it('serves a balance, so the money chrome renders locally', async () => {
    await expect(fetchBuzzBalance()).resolves.toMatchObject({ yellow: expect.any(Number) });
  });

  it('400s a submit with no idempotencyKey, exactly as the real route does', async () => {
    // Reached through `fetch` rather than the client, because the client always
    // supplies a key — which is the point: a harness that accepted a keyless
    // submit would hide the one client defect that double-charges a viewer.
    const res = await createHarnessFetch()('https://civitai.test/api/v1/blocks/workflows/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('answers an unhandled block route the way an UNDEPLOYED one does', async () => {
    const res = await createHarnessFetch()('https://civitai.test/api/v1/blocks/shared-storage/list');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
  });
});
