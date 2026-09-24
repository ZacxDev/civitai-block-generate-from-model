import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  useBlockContext,
  useBuzzBalance,
  useBuzzWorkflow,
  WorkflowEstimateError,
} from '../platform/index.js';
import {
  errorReply,
  installFakePlatform,
  snapshotReply,
  type FakeServer,
} from '../platform/testing.js';

/**
 * The hooks, against a fake server.
 *
 * 🔴 THIS FILE EXISTS BECAUSE OF THE SEAM, NOT BECAUSE OF THE HOOKS. The REST
 * client is covered in `platform-workflows.test.ts` and the block's behaviour is
 * covered by the UI suites — but each of those is scoped to ONE surface, and
 * `hooks.ts` is the surface neither loads. The UI suites mock these hooks away
 * wholesale; the client tests never render one. A hook that resolved correctly
 * and published the WRONG thing to `result` would pass both.
 *
 * `result` is the specific thing at stake. `App.tsx`'s money verdict reads the
 * settled snapshot off `useBuzzWorkflow().result` rather than off the returned
 * value, so a hook that skips the assignment on the rejecting path leaves the
 * PREVIOUS call's snapshot in place — a live control on a spend path quoting a
 * price this call never got.
 */

const WF = {
  kind: 'textToImage',
  modelId: 555,
  modelVersionId: 2835132,
  params: { prompt: 'a cat', quantity: 1 },
} as const;

let server: FakeServer;

beforeEach(() => {
  ({ server } = installFakePlatform());
});

describe('useBlockContext', () => {
  it('reports the handshake, the instance id and the token budget cap', async () => {
    const { result } = renderHook(() => useBlockContext());

    await waitFor(() => expect(result.current.ready).toBe(true));
    // 🔴 Neither of these is on `BlockAppClient` — they come off the transport
    // snapshot, which is why `client.ts` keeps the transport it initialised
    // with. `blockInstanceId` keys the block's localStorage draft and
    // `token.buzzBudget` is the per-call ceiling its spend predicate applies;
    // reading `undefined` for either is silent and consequential.
    expect(result.current.blockInstanceId).toBe('bi_test');
    expect(result.current.token.buzzBudget).toBe(50);
    expect(result.current.viewer?.id).toBe(2);
  });
});

describe('useBuzzWorkflow', () => {
  it('publishes the priced snapshot and moves to confirming', async () => {
    server.route('blocks/workflows/estimate', snapshotReply({
      workflowId: 'whatif',
      status: 'pending',
      cost: { total: 34 },
    }));

    const { result } = renderHook(() => useBuzzWorkflow());
    await act(async () => {
      await result.current.estimate(WF);
    });

    expect(result.current.status).toBe('confirming');
    expect(result.current.result?.cost?.total).toBe(34);
  });

  it('🔴 publishes a REFUSED estimate to `result` before rejecting', async () => {
    server.route('blocks/workflows/estimate', snapshotReply({
      workflowId: 'whatif',
      status: 'failed',
      cost: { total: 90 },
      error: 'over the per-call budget',
    }));

    const { result } = renderHook(() => useBuzzWorkflow());
    let thrown: unknown;
    await act(async () => {
      thrown = await result.current.estimate(WF).catch((e: unknown) => e);
    });

    expect(thrown).toBeInstanceOf(WorkflowEstimateError);
    // The assignment the rejection must not jump over.
    expect(result.current.result).toMatchObject({ status: 'failed', cost: { total: 90 } });
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe(thrown);
  });

  it('🔴 does not let a failed estimate leave the PREVIOUS quote standing', async () => {
    // The fail-closed property, stated as a sequence rather than as a snapshot:
    // a priced estimate, then a refused one. If the second skipped its
    // assignment, `result` would still read 34 and the block would offer
    // Generate at a price nothing quoted.
    server.route('blocks/workflows/estimate', snapshotReply({
      workflowId: 'whatif',
      status: 'pending',
      cost: { total: 34 },
    }));
    const { result } = renderHook(() => useBuzzWorkflow());
    await act(async () => {
      await result.current.estimate(WF);
    });
    expect(result.current.result?.cost?.total).toBe(34);

    server.route('blocks/workflows/estimate', errorReply(500, 'orchestrator unavailable'));
    await act(async () => {
      await result.current.estimate(WF).catch(() => undefined);
    });

    expect(result.current.result?.cost?.total).toBeUndefined();
    expect(result.current.result?.error).toBe('orchestrator unavailable');
  });

  it('🔴 RESOLVES a budget rejection and publishes the price it quoted', async () => {
    server.route('blocks/workflows/submit', snapshotReply({
      workflowId: 'whatif',
      status: 'failed',
      cost: { total: 60 },
      error: 'insufficient funds',
    }));

    const { result } = renderHook(() => useBuzzWorkflow());
    let snap: unknown;
    await act(async () => {
      snap = await result.current.submit(WF);
    });

    expect(snap).toMatchObject({ status: 'failed', cost: { total: 60 } });
    // `failed` is terminal, so the hook is done rather than polling.
    expect(result.current.status).toBe('done');
    expect(result.current.result?.cost?.total).toBe(60);
  });

  it("moves to polling on an accepted, non-terminal submit", async () => {
    server.route('blocks/workflows/submit', snapshotReply({ workflowId: '2-abc', status: 'pending' }));

    const { result } = renderHook(() => useBuzzWorkflow());
    await act(async () => {
      await result.current.submit(WF);
    });

    expect(result.current.status).toBe('polling');
  });

  it('leaves the hook usable after a failed cancel — cancel is best-effort', async () => {
    server.route('blocks/workflows/cancel', errorReply(403, 'not your workflow'));

    const { result } = renderHook(() => useBuzzWorkflow());
    await act(async () => {
      await result.current.cancel('2-abc').catch(() => undefined);
    });

    expect(result.current.error?.message).toBe('not your workflow');
    // NOT wedged into 'error': the block clears its own card and carries on.
    expect(result.current.status).toBe('idle');
  });
});

describe('useBuzzBalance', () => {
  it('fetches on mount', async () => {
    server.route('blocks/buzz', { status: 200, body: { blue: 1, green: 2, yellow: 3 } });

    const { result } = renderHook(() => useBuzzBalance());

    await waitFor(() => expect(result.current.balance).toEqual({ blue: 1, green: 2, yellow: 3 }));
    expect(result.current.loading).toBe(false);
  });

  it('🔴 KEEPS the last good balance when a refetch fails', async () => {
    // `App.tsx` treats `balance === null` as "we have never known" and fails
    // toward NOT-a-shortfall on it. Nulling here would blank a genuine
    // shortfall's top-up CTA and put the Generate button back beside a card
    // still reading "spend limit" — the defect this behaviour was written for.
    server.route('blocks/buzz', { status: 200, body: { blue: 0, green: 0, yellow: 500 } });
    const { result } = renderHook(() => useBuzzBalance());
    await waitFor(() => expect(result.current.balance?.yellow).toBe(500));

    server.route('blocks/buzz', errorReply(503, 'balance service down'));
    await act(async () => {
      result.current.refetch();
    });

    await waitFor(() => expect(result.current.error?.message).toBe('balance service down'));
    expect(result.current.balance).toEqual({ blue: 0, green: 0, yellow: 500 });
  });

  it('🔴 applies the LATEST refetch, even when an older one answers LAST', async () => {
    // 🔴 THE ORDERING IS THE WHOLE TEST. Two refetches in flight, and the FIRST
    // one answers SECOND. Without the sequence guard the stale reply overwrites
    // the newer balance — and nothing has unmounted, so a bare mount check
    // passes right through it.
    //
    // An earlier version of this case fired both refetches and let them settle
    // in request order. It was green, and it SURVIVED a mutant that deleted the
    // guard entirely: with replies in order the last write is the newest one
    // whether or not anything is guarding. Delaying the first reply is what
    // makes the assertion about the guard rather than about the fake.
    server.route('blocks/buzz', { status: 200, body: { yellow: 1 } });
    const { result } = renderHook(() => useBuzzBalance());
    await waitFor(() => expect(result.current.balance?.yellow).toBe(1));

    let releaseFirst!: () => void;
    const firstLanded = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    server.route('blocks/buzz', async () => {
      call += 1;
      if (call === 1) {
        await firstLanded;
        return { status: 200, body: { yellow: 100 } };
      }
      return { status: 200, body: { yellow: 200 } };
    });

    await act(async () => {
      result.current.refetch();
      result.current.refetch();
    });

    // The newer read lands first and is applied.
    await waitFor(() => expect(result.current.balance?.yellow).toBe(200));

    // Now let the SUPERSEDED read answer. It must be dropped on the floor.
    await act(async () => {
      releaseFirst();
      await firstLanded;
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(call).toBe(2);
    expect(result.current.balance?.yellow).toBe(200);
    // ...and the stale reply must not resurrect `loading` either.
    expect(result.current.loading).toBe(false);
  });
});
