/**
 * ROUND 6 — the money verdict is a function of the job's LIFECYCLE, decided
 * ONCE, and the balance is allowed to move afterwards without re-deciding it.
 *
 * Every round from 3 to 5 patched `isSpendLimitRefusal`'s predicate and each
 * patch produced the next round's user-facing defect, always on the same money
 * path. The two changes under test here are structural rather than another
 * clause on the same rule:
 *
 *   Leg 1 — a refusal is a job that NEVER STARTED. A `submit()` that replies
 *   with any non-`failed` status was accepted and, per the SDK, FUNDED ("A
 *   resolved submit is money-COMMITTED (the reservation is kept regardless of
 *   snapshot status)… we do NOT refund on a non-throwing failed snapshot").
 *   Every failure such a job later reports is an execution failure and can
 *   never be an affordability refusal, whatever the price or the balance.
 *
 *   Leg 2 — classify at the instant the decision arrives and STORE the answer.
 *   The CTA used to re-derive it on every render from the hook's shared
 *   `result` while each card had frozen its own copy at write time, so a
 *   balance that moved in between made the two disagree on screen about one
 *   snapshot.
 *
 * 🔴 These tests are only meaningful because the harness can now MOVE the
 * balance (`setMockBuzzBalanceRefetch`). Before that, `refetchBuzzBalance` was
 * a bare spy and the balance was fixed before mount, so the whole family below
 * was unreachable and a fully green 176-test suite said nothing about it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  blocksReactMockFactory,
  getMockBuzzBalance,
  getMockSpies,
  renderApp,
  resetBlocksReactMock,
  setMockBuzzBalance,
  setMockBuzzBalanceRefetch,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { WorkflowEstimateError } from '@civitai/blocks-react';

import { App } from '../App';

const PRICE = 42; // under DEFAULT_TOKEN.buzzBudget (50), so the cap clause never fires
const clickGenerate = () =>
  userEvent.click(screen.getByRole('button', { name: /Generate Image|Re-generate Image/ }));

/**
 * Freeze the post-submit re-quote. A SUCCESSFUL estimate clears the stored
 * verdict on purpose (it is the block's recovery path out of the top-up CTA),
 * so leaving it live makes the window under assertion a race rather than a
 * state. Same device the existing queue tests use.
 */
const freezeEstimate = () =>
  getMockSpies().estimate.mockImplementation(() => new Promise(() => {}));

beforeEach(() => {
  resetBlocksReactMock();
});

describe('F1 — a charged job that then failed is never re-classified by its own debit', () => {
  it('🔴 post-debit balance BELOW the price does NOT turn a moderation failure into a spend limit', async () => {
    // 🔴 THE ROUND-6 DEFECT, measured, in the exact numbers it was reported in.
    // The viewer holds 50 and the generation costs 42, so the balance covers it
    // and the job is accepted and charged. It then fails moderation. Round 5's
    // terminal-workflow `refetch()` returns the POST-DEBIT 8 — and because the
    // CTA re-derived its verdict live over the hook's shared `result`, which
    // still held that same failed snapshot, `8 < 42` re-classified the failure
    // that had CAUSED the debit. The screen showed "Top up · N", "This
    // generation hit a Buzz spend limit." and no Generate button, next to a
    // card reading "This generation failed.", for money the SDK says is gone
    // and will not be refunded.
    //
    // The trigger condition is only "balance before the job < 2× price", i.e.
    // any viewer near their budget. Round 5's guard missed it because it pinned
    // the balance at 500 (12× the price) and its `refetch` moved nothing.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 50 } });
    setMockBuzzBalanceRefetch({
      kind: 'resolves',
      balance: { blue: 0, green: 0, yellow: 8 },
    });
    spies.submit.mockResolvedValue({
      workflowId: 'wf_f1',
      status: 'pending',
      cost: { total: PRICE },
    } as never);
    spies.poll.mockResolvedValue({
      workflowId: 'wf_f1',
      status: 'failed',
      error: 'NSFW output was moderated after render',
      cost: { total: PRICE },
    } as never);

    await renderApp(<App />);
    freezeEstimate();
    await clickGenerate();

    await waitFor(() =>
      expect(screen.getByText('This generation failed.')).toBeInTheDocument()
    );
    // POSITIVE CONTROL, not decoration: without these two the assertions below
    // pass just as happily when the refetch never fired and the balance never
    // moved — which is precisely the shape that hid this defect.
    expect(spies.refetchBuzzBalance).toHaveBeenCalled();
    await waitFor(() => expect(getMockBuzzBalance().balance?.yellow).toBe(8));

    // The four user-visible parts of the defect, all absent.
    expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull();
    expect(screen.queryByText(/Buzz spend limit/)).toBeNull();
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
    expect(screen.getByText('Generation failed.')).toBeInTheDocument();
    expect(spies.openPurchaseModal).not.toHaveBeenCalled();

    // 🔴 AND THE OTHER HALF, in the same test so the guard above cannot pass by
    // the component simply never seeing the new figure: the refreshed balance
    // is exactly what the NEXT decision must be priced against. A fresh
    // estimate refusal at the same 42, with nothing else changed, DOES get the
    // top-up — because 8 really is short and that refusal really never started.
    spies.estimate.mockRejectedValue(
      new WorkflowEstimateError(
        { workflowId: 'wf_next', status: 'failed', cost: { total: PRICE } } as never,
        'failed'
      )
    );
    await userEvent.click(screen.getByRole('button', { name: 'Pick preview 2' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument()
    );
  });
});

describe('F2 — a refetch in flight, or a failed one, cannot move a decided verdict', () => {
  /** A genuine refusal: never queued, priced, and the viewer really is short. */
  const refuseSubmit = () =>
    getMockSpies().submit.mockResolvedValue({
      workflowId: 'failed',
      status: 'failed',
      error: 'spend cap exceeded',
      cost: { total: PRICE },
    } as never);

  it('(a) the top-up CTA does not FLICKER while the balance refetch is loading', async () => {
    // `refetch()` sets `loading` SYNCHRONOUSLY. Under the old rule — "loading
    // means the figure is being replaced, so treat the balance as unknown" —
    // every genuine shortfall lost its CTA and its copy for one bridge
    // round-trip and got the Generate button back, while the job card kept
    // saying "spend limit" throughout. The two consumers of one rule, visibly
    // disagreeing, on a schedule.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } }); // 5 < 42
    setMockBuzzBalanceRefetch({ kind: 'never' }); // stays loading forever
    refuseSubmit();

    await renderApp(<App />);
    freezeEstimate();
    await clickGenerate();

    await waitFor(() =>
      expect(
        screen.getAllByText('This generation hit a Buzz spend limit.')
      ).toHaveLength(2)
    );
    // We are genuinely inside the loading window — assert it, don't assume it.
    expect(spies.refetchBuzzBalance).toHaveBeenCalled();
    expect(getMockBuzzBalance().loading).toBe(true);
    // ...and the money surface is intact: CTA present, Generate gone.
    expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeNull();
  });

  it('(b) a refetch that ERRORS does not strand a genuine shortfall without its top-up', async () => {
    // The worse half: an errored refetch leaves `error` set until the next
    // terminal workflow, so the viewer who cannot afford the generation was
    // shown "Generation failed." and a Generate button that would fail
    // identically — with no top-up ever offered. The real hook keeps the last
    // good `balance` through an error; only the app was throwing it away.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } });
    setMockBuzzBalanceRefetch({ kind: 'fails', error: new Error('host refused') });
    refuseSubmit();

    await renderApp(<App />);
    freezeEstimate();
    await clickGenerate();

    // Wait for the failure to actually land before asserting on its effect.
    await waitFor(() => expect(getMockBuzzBalance().error).not.toBeNull());
    expect(spies.refetchBuzzBalance).toHaveBeenCalled();
    expect(getMockBuzzBalance().loading).toBe(false);
    // The verdict survives it, in both places.
    expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument();
    expect(
      screen.getAllByText('This generation hit a Buzz spend limit.')
    ).toHaveLength(2);
    expect(screen.queryByText('Generation failed.')).toBeNull();
  });
});

describe('the stored verdict is REPLACED by the next decision, never left behind', () => {
  it('an accepted job settling clears a spend-limit verdict left by an earlier estimate refusal', async () => {
    // 🔴 THIS GUARD EXISTS BECAUSE ITS ABSENCE SURVIVED THE FIRST MUTATION
    // ROUND. Deleting the poll-terminal `setSpendLimited(refused)` changed no
    // test: for an accepted job `refused` is always false, so that call only
    // ever CLEARS a verdict — and nothing exercised the clearing.
    //
    // It is load-bearing for parity with the behaviour being replaced. Before
    // the fix a settling poll snapshot overwrote the hook's shared `result`,
    // which the CTA re-derived from, so a stale spend-limit CTA disappeared the
    // moment any job settled. The stored verdict has to do that explicitly or a
    // viewer who is no longer being refused keeps a top-up button forever.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } }); // 5 < 42
    let releasePoll: (snap: unknown) => void = () => {};
    const pollSettled = new Promise((res) => {
      releasePoll = res;
    });
    spies.submit.mockResolvedValue({ workflowId: 'wf_seq', status: 'pending' } as never);
    spies.poll.mockImplementation(() => pollSettled);

    // Mount with a working estimate so Generate is on screen to click.
    await renderApp(<App />);
    // The post-submit re-quote is the decision that refuses.
    spies.estimate.mockRejectedValue(
      new WorkflowEstimateError(
        { workflowId: 'wf_est', status: 'failed', cost: { total: PRICE } } as never,
        'failed'
      )
    );
    await clickGenerate();

    // The refused estimate is the latest decision → the CTA is showing, over a
    // job that is still in flight.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument()
    );

    // That job now settles. It was accepted, so it is not a refusal, and it is
    // the newest decision — the CTA must go.
    await act(async () => {
      releasePoll({
        workflowId: 'wf_seq',
        status: 'succeeded',
        imageUrls: ['https://example.test/done.jpg'],
        cost: { total: 12 },
      });
      await pollSettled;
    });

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull()
    );
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
  });
});

describe('the balance is re-read on every terminal transition, including the one the USER causes', () => {
  it('a submit that comes back TERMINAL refreshes the balance', async () => {
    // Round 5's guard. A cached hit (or a refusal) settles on the submit reply
    // and starts no poll loop, so the poll loop's terminal branch — the other
    // refetch site — never runs for it. Deleting the `else` branch's
    // `refetchBalanceRef.current()` must fail HERE by name.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 500 } });
    spies.submit.mockResolvedValue({
      workflowId: 'wf_cached',
      status: 'succeeded',
      imageUrls: ['https://example.test/cached.jpg'],
      cost: { total: 12 },
    } as never);

    await renderApp(<App />);
    freezeEstimate();
    spies.refetchBuzzBalance.mockClear();
    await clickGenerate();

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1)
    );
    expect(spies.refetchBuzzBalance).toHaveBeenCalledTimes(1);
  });

  it('CANCELLING a job refreshes the balance', async () => {
    // 🔴 The gap round 5 did not see. `cancelJob` kills the poll token first,
    // so the poll loop's terminal branch never runs and the balance was never
    // re-read for a user cancel — even though the submit had already committed
    // the reservation and the orchestrator cancel is best-effort. Round 5's
    // claim that a refetch fires on "every terminal workflow" was false for the
    // one terminal transition a user can trigger by hand.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 500 } });
    spies.submit.mockResolvedValue({ workflowId: 'wf_cancel', status: 'pending' } as never);
    spies.poll.mockImplementation(() => new Promise(() => {})); // stays in flight

    await renderApp(<App />);
    freezeEstimate();
    await clickGenerate();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Cancel generation' })).toBeInTheDocument()
    );
    // Nothing has settled yet, so nothing has refreshed the balance yet.
    spies.refetchBuzzBalance.mockClear();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel generation' }));

    await waitFor(() => expect(screen.getByText('Canceled')).toBeInTheDocument());
    expect(spies.refetchBuzzBalance).toHaveBeenCalledTimes(1);
  });
});

describe('a refusal is priced against the balance as of the REFUSAL, not as of mount', () => {
  it('a balance that dropped after mount is the one the verdict uses', async () => {
    // 🔴 Round 5 added `spendRef.current = spend` so the per-job closures read
    // the CURRENT balance rather than whatever was live when they were made —
    // and it SURVIVED mutation, because no test could move the balance after
    // mount. This is that guard's killing case: the viewer could afford 42 at
    // mount and cannot by the time the refusal arrives.
    //
    // It is also the harness's own positive control. If `setMockBuzzBalance`
    // did not re-render a mounted `useBuzzBalance()`, this test could not pass
    // at all — which is what makes F1's "the component never saw the new
    // figure" escape route unavailable.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 500 } }); // covers 42
    await renderApp(<App />);
    freezeEstimate();

    // The wallet moves — another tab, another block, an earlier generation.
    await act(async () => {
      setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } }); // 5 < 42
    });

    spies.submit.mockResolvedValue({
      workflowId: 'failed',
      status: 'failed',
      error: 'spend cap exceeded',
      cost: { total: PRICE },
    } as never);
    await clickGenerate();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument()
    );
    expect(
      screen.getAllByText('This generation hit a Buzz spend limit.')
    ).toHaveLength(2);
  });
});
