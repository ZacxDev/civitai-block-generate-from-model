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
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  blocksReactMockFactory,
  getMockBuzzBalance,
  getMockSpies,
  renderApp,
  resetBlocksReactMock,
  setMockBuzzBalance,
  setMockBuzzBalanceRefetch,
  setMockSettings,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { WorkflowEstimateError, WorkflowSubmitError } from '@civitai/blocks-react';

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
    // 🔴 THIS TEST IS NOT A POSITIVE CONTROL ON THE HARNESS, and the comment
    // that used to sit here said it was: "If `setMockBuzzBalance` did not
    // re-render a mounted `useBuzzBalance()`, this test could not pass at all."
    // MEASURED FALSE in round 7 — making `notifyBalance()` a global no-op, i.e.
    // deleting the entire `balanceListeners`/`useState` bump/`useEffect`
    // subscribe apparatus, fails 0 of 184 tests, this one included. It passes
    // because `clickGenerate` mints a queue card, and THAT `setQueue` forces the
    // render which refreshes `spendRef.current` — the balance move is picked up
    // by a render the click would have caused anyway. A comment telling the next
    // reader an escape route is closed while it is open is worse than none.
    //
    // The real pin is
    // `🔴 HARNESS PIN — an out-of-band balance move must re-render on its own`
    // below, which moves the balance with NO other render trigger available.
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

/* ------------------------------------------------------------------ *
 *  ROUND 7
 * ------------------------------------------------------------------ */

describe('R7 F1 — a submit throw that settled NOTHING must not wipe a live verdict', () => {
  /**
   * Put the app in a real, correct spend-limit state via the estimate path,
   * then freeze the estimate so no re-quote can restore the verdict behind our
   * back (the `isRegenerate` flip re-quotes after every submit, which is why
   * the defect is intermittent rather than always-on).
   */
  const arriveAtRefusedState = async () => {
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } }); // 5 < 42
    spies.estimate.mockRejectedValue(
      new WorkflowEstimateError(
        { workflowId: 'wf_est', status: 'failed', cost: { total: PRICE } } as never,
        'failed'
      )
    );
    await renderApp(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument()
    );
    freezeEstimate();
    return spies;
  };

  /** Ctrl+Enter on the prompt — the path that reaches `handleGenerate` while the CTA is swapped out. */
  const ctrlEnter = async () => {
    await userEvent.click(screen.getByLabelText('Prompt (optional)'));
    await userEvent.keyboard('{Control>}{Enter}{/Control}');
  };

  it('🔴 a TRANSPORT-level submit rejection leaves the stored verdict standing', async () => {
    // 🔴 THE ROUND-6 REGRESSION, in the numbers it was reported in. The viewer
    // holds 5 and the quote is 42, so the estimate refusal is a genuine,
    // top-up-fixable shortfall: "Top up · 500", the spend-limit copy, no
    // Generate button. The CTA is NOT a gate — `PromptTextarea` is mounted
    // `disabled={false}`, so Ctrl/Cmd+Enter reaches `handleGenerate` anyway.
    //
    // `submit()` then rejects at the TRANSPORT (`sendTypedRequest` hitting
    // `WORKFLOW_REQUEST_TIMEOUT_MS`, or a dead bridge). That path never reaches
    // the hook's `setResult(snapshot)` — no snapshot is published and none is
    // carried on the error — so nothing whatsoever was decided. The catch's
    // unconditional `setSpendLimited(false)` nonetheless wiped the top-up, the
    // copy and the gate, leaving a viewer 37 Buzz short staring at a Generate
    // button that fails identically and no way to buy the Buzz that would fix it.
    const spies = await arriveAtRefusedState();
    spies.submit.mockRejectedValue(new Error('bridge request timed out'));

    await ctrlEnter();
    await waitFor(() => expect(spies.submit).toHaveBeenCalled());
    // POSITIVE CONTROL: prove we are in the catch at all. Without this the
    // assertions below are equally happy if the keystroke never submitted.
    await waitFor(() =>
      expect(screen.getByText("Couldn't submit this generation.")).toBeInTheDocument()
    );
    // 🔴 PIN THE PROPERTY THE FIX TURNS ON, not just the outcome: what came out
    // of `submit()` is NOT a `WorkflowSubmitError`, so it carries no `snapshot`
    // and the SDK's "a budget rejection never arrives here" reasoning — which is
    // the entire justification for the unconditional clear — never applied to it.
    await expect(spies.submit.mock.results[0]?.value).rejects.toBeInstanceOf(Error);
    await expect(spies.submit.mock.results[0]?.value).rejects.not.toBeInstanceOf(
      WorkflowSubmitError
    );

    // All four user-visible parts of the verdict, still there.
    expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument();
    expect(screen.getByText('This generation hit a Buzz spend limit.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeNull();
    expect(screen.queryByText('Generation failed.')).toBeNull();
  });

  it('a submit throw that DOES carry a snapshot still re-decides the verdict', async () => {
    // ⚠️ INVARIANT GUARD, NOT REGRESSION COVERAGE — this passes on pre-change
    // code too, where the unconditional `setSpendLimited(false)` produced the
    // same screen. It exists so the fix cannot be "stop writing the verdict in
    // the catch at all": a `WorkflowSubmitError` carries the host's snapshot,
    // which IS a decision, and the one predicate must make it. Both thrown codes
    // carry an UNPRICED snapshot, so the predicate answers `false` and the
    // verdict clears — but it clears because the rule said so, not because a
    // literal was typed here.
    const spies = await arriveAtRefusedState();
    spies.submit.mockRejectedValue(
      new WorkflowSubmitError(
        { workflowId: 'failed', status: 'failed' } as never,
        'exception'
      )
    );

    await ctrlEnter();
    await waitFor(() => expect(spies.submit).toHaveBeenCalled());

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull()
    );
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
    expect(screen.queryByText(/Buzz spend limit/)).toBeNull();
  });
});

describe('R7 F2 — the harness mechanisms the money tests rest on, actually pinned', () => {
  it('🔴 HARNESS PIN — an out-of-band balance move must re-render on its own', async () => {
    // ⚠️ INVARIANT GUARD ON THE HARNESS, not regression coverage on the app: it
    // passes at HEAD and at the base. Its job is to be the killing case for a
    // mutation that the whole suite otherwise survives — making `notifyBalance()`
    // a no-op, i.e. deleting `balanceListeners` + the `useState` bump + the
    // `useEffect` subscribe that round 6 added to `test-utils`. That apparatus
    // exists so the mock matches the REAL `useBuzzBalance`, which re-renders its
    // consumers when its own state moves; without it the mock silently freezes
    // the balance at whatever the last unrelated render saw.
    //
    // Every other balance test lets a click, a card mint or a showcase pick
    // force the render, so the mechanism is never the reason they pass. Here the
    // balance moves while `submit()` is in flight — after the click's render,
    // before the reply — so NOTHING else can re-render, and the verdict is
    // classified from `spendRef.current`, which only a re-render refreshes.
    //
    // 🔴 It asserts on RENDERED OUTPUT (the Top-up button), never on
    // `getMockBuzzBalance()`. Reading the module record is what made the comment
    // this replaces vacuous: the record moves whether or not React ever saw it.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 500 } }); // covers 42
    let releaseSubmit: (snap: unknown) => void = () => {};
    const submitSettled = new Promise((res) => {
      releaseSubmit = res;
    });
    spies.submit.mockImplementation(() => submitSettled);

    await renderApp(<App />);
    freezeEstimate();
    await clickGenerate();
    // In flight: the card is minted, the reply has not arrived.
    await waitFor(() => expect(spies.submit).toHaveBeenCalled());

    // The wallet empties elsewhere — another tab, another block, a sibling job.
    // No click, no card, no showcase change: the ONLY thing that can tell React
    // is the mock's own listener set.
    await act(async () => {
      setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } }); // 5 < 42
    });

    // Now the reply lands: a genuine refusal, priced 42, never queued.
    await act(async () => {
      releaseSubmit({
        workflowId: 'failed',
        status: 'failed',
        error: 'spend cap exceeded',
        cost: { total: PRICE },
      });
      await submitSettled;
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument()
    );
    expect(
      screen.getAllByText('This generation hit a Buzz spend limit.')
    ).toHaveLength(2);
  });

  it('🔴 HARNESS PIN — a FAILED refetch keeps the last good balance, and the next decision uses it', async () => {
    // ⚠️ INVARIANT GUARD ON THE HARNESS. `setMockBuzzBalanceRefetch`'s docstring
    // claims it "mirrors the REAL `useBuzzBalance` exactly", including "on
    // failure it sets `error` and clears `loading`, LEAVING the previous
    // `balance` in place — the hook never nulls a value it once fetched".
    // Measured in round 7: making the failed branch NULL the balance fails 0 of
    // 184 tests. The existing `(b)` case above cannot see it, because the verdict
    // it asserts on was already STORED before the refetch failed — the balance is
    // irrelevant to it by then.
    //
    // The property only becomes observable at the NEXT decision, which is priced
    // against whatever the balance is then. So: refuse once (verdict stored,
    // refetch fires and fails), then refuse AGAIN through the estimate path. A
    // mock that nulled the balance on failure would hand the predicate `null`,
    // which fails toward NOT-a-shortfall, and the top-up would vanish for a
    // viewer who is still short.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } }); // 5 < 42
    setMockBuzzBalanceRefetch({ kind: 'fails', error: new Error('host refused') });
    spies.submit.mockResolvedValue({
      workflowId: 'failed',
      status: 'failed',
      error: 'spend cap exceeded',
      cost: { total: PRICE },
    } as never);

    await renderApp(<App />);
    freezeEstimate();
    await clickGenerate();

    // The refetch really did fire and really did fail — assert it, don't assume.
    await waitFor(() => expect(getMockBuzzBalance().error).not.toBeNull());
    expect(spies.refetchBuzzBalance).toHaveBeenCalled();

    // A SECOND decision, from the estimate path, priced against whatever the
    // balance is now. Nothing else changed: the viewer still holds 5.
    spies.estimate.mockRejectedValue(
      new WorkflowEstimateError(
        { workflowId: 'wf_est2', status: 'failed', cost: { total: PRICE } } as never,
        'failed'
      )
    );
    await userEvent.click(screen.getByRole('button', { name: 'Pick preview 2' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument()
    );
    // Both consumers of the one verdict — the CTA's copy and the job card's.
    expect(
      screen.getAllByText('This generation hit a Buzz spend limit.')
    ).toHaveLength(2);
  });
});

/* ------------------------------------------------------------------ *
 *  ROUND 8 — the same shapes, at the sites round 7 did not sweep.
 * ------------------------------------------------------------------ */

describe('R8 F1 — a transport-level ESTIMATE rejection must not wipe a live verdict', () => {
  it('🔴 a plain-Error estimate rejection leaves the stored verdict standing', async () => {
    // 🔴 ROUND 7'S OWN DEFECT, ONE SITE OVER. Round 7 closed exactly this shape
    // at the submit catch and left it byte-identical at the estimate catch,
    // where it is not merely reachable but fires on the app's BUSIEST path: the
    // post-submit re-quote runs after every single submit.
    //
    // The measured screen, in the numbers it was reported in. The viewer holds
    // 5, the quote is 42, and submit replies a genuine priced refusal — never
    // queued, top-up-fixable — so the verdict is true and correct: "Top up ·
    // 500", the spend-limit copy in BOTH places, no Generate button. The
    // re-quote at the bottom of `handleGenerate` fires immediately; the bridge
    // is down, so `estimate()` rejects with a plain `Error` (the SDK's estimate
    // catch RETHROWS the raw error rather than wrapping it). The old code handed
    // the predicate `null` for the missing snapshot, `null` fails toward
    // NOT-a-shortfall, and the verdict was cleared by a rejection that had
    // decided nothing: top-up gone, copy gone, Generate back — while the job
    // card beside it still read "This generation hit a Buzz spend limit."
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } }); // 5 < 42
    spies.submit.mockResolvedValue({
      workflowId: 'failed',
      status: 'failed',
      error: 'spend cap exceeded',
      cost: { total: PRICE },
    } as never);

    // Mount with a WORKING estimate so the Generate button is on screen...
    await renderApp(<App />);
    // ...then break the bridge, so the post-submit re-quote is the transport
    // rejection under test. NOT `freezeEstimate` — the rejection is the event.
    spies.estimate.mockRejectedValue(new Error('bridge request timed out'));

    await clickGenerate();

    // POSITIVE CONTROL, twice over: the refusal really was classified (the card
    // carries the money copy), and the estimate really did reject afterwards
    // (its own error line is on screen). Without both, every assertion below
    // passes just as happily if the re-quote never ran at all — which is the
    // shape that hid this for a whole round.
    await waitFor(() =>
      expect(
        screen.getByText(
          "Couldn't estimate cost: the estimate service is unavailable — try again in a moment."
        )
      ).toBeInTheDocument()
    );
    // 🔴 PIN THE PROPERTY THE FIX TURNS ON, not just the outcome: what came out
    // of `estimate()` is NOT a `WorkflowEstimateError`, so it carries no
    // `snapshot`, and there was never anything for the predicate to classify.
    const lastEstimate = spies.estimate.mock.results.at(-1)?.value;
    await expect(lastEstimate).rejects.toBeInstanceOf(Error);
    await expect(lastEstimate).rejects.not.toBeInstanceOf(WorkflowEstimateError);

    // All four user-visible parts of the verdict, still there — and the copy in
    // BOTH places, which is what makes the card-vs-CTA disagreement visible.
    expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument();
    expect(
      screen.getAllByText('This generation hit a Buzz spend limit.')
    ).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeNull();
    expect(spies.openPurchaseModal).not.toHaveBeenCalled();
  });

  it('a WorkflowEstimateError that DOES carry a snapshot still re-decides the verdict', async () => {
    // ⚠️ INVARIANT GUARD, NOT REGRESSION COVERAGE — it passes on pre-change code
    // too. It exists so the F1 fix cannot be "stop writing the verdict in the
    // estimate catch at all": a `WorkflowEstimateError` carries the host's
    // snapshot, which IS a decision, and the one predicate must make it. Here
    // the snapshot is `succeeded`/`no-cost` — not a refusal — so the predicate
    // answers `false` and a standing verdict CLEARS, because the rule said so
    // and not because a literal was typed here.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } });
    spies.submit.mockResolvedValue({
      workflowId: 'failed',
      status: 'failed',
      error: 'spend cap exceeded',
      cost: { total: PRICE },
    } as never);

    await renderApp(<App />);
    spies.estimate.mockRejectedValue(
      new WorkflowEstimateError({ workflowId: 'w', status: 'succeeded' } as never, 'no-cost')
    );
    await clickGenerate();

    await waitFor(() =>
      expect(
        screen.getByText("Couldn't estimate cost: no price came back for these settings.")
      ).toBeInTheDocument()
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull()
    );
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
  });
});

describe('R8 F2 (INVERTED IN ROUND 9) — a thrown submit never sells Buzz for money that may already be gone', () => {
  it('🔴 a PRICED workflow-failed throw gets NO top-up CTA — the SDK says Buzz may already be spent', async () => {
    // 🔴 THIS TEST USED TO ASSERT THE OPPOSITE, AND THAT WAS ROUND 6's F1 INSIDE
    // THE GUARD WRITTEN TO PREVENT ITS COUSIN. Round 8 fabricated this same
    // priced `workflow-failed` throw and asserted the viewer MUST get "Top up"
    // + the spend-limit copy ×2. The SDK's docstring for that code forbids it in
    // as many words: "🔴 DO NOT TELL THE VIEWER NOTHING WAS CHARGED… treats *any
    // resolved* submit as money-COMMITTED (the reservation is kept regardless of
    // snapshot status)… So Buzz may already be spent for this call." A thrown
    // `workflow-failed` scored `accepted: false` — the lifecycle clause keys on
    // `submit()` REPLYING non-`failed`, and a throw is not a reply — so the
    // predicate fell through to the balance arithmetic and offered to sell Buzz
    // for a charge the server may already have taken.
    //
    // ⚠️ STILL A SEAM GUARD OVER A FIXTURE TODAY'S SDK CANNOT PRODUCE, on TWO
    // independent axes: `submit()` throws only under `status === 'failed' &&
    // typeof cost?.total !== 'number'`, so a thrown snapshot is never priced;
    // and the code is chosen by `snapshot.workflowId === 'failed' ? 'exception'
    // : 'workflow-failed'`, so round 8's `workflowId: 'failed'` would have been
    // an `'exception'`, not the code it labelled. The id below is a plausible
    // server-built one, which is what actually reaches this arm.
    //
    // It is REGRESSION coverage, not an invariant guard: at 5c9c738 this fixture
    // renders "Top up" and the money copy, and the assertions below fail.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } }); // 5 < 42
    spies.submit.mockRejectedValue(
      new WorkflowSubmitError(
        { workflowId: 'wf_srv_8814', status: 'failed', cost: { total: PRICE } } as never,
        'workflow-failed'
      )
    );

    await renderApp(<App />);
    // The `isRegenerate` flip re-quotes after every submit, and a SUCCESSFUL
    // re-quote clears the verdict on purpose. Freeze it so what is asserted is
    // a state rather than a race.
    freezeEstimate();
    await clickGenerate();

    // POSITIVE CONTROL: we are in the catch at all, and the card really did
    // settle. Without it every negative assertion below passes just as happily
    // if the click never submitted.
    await waitFor(() => expect(spies.submit).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByText('This generation failed to start.')).toBeInTheDocument()
    );

    // The money surface, absent — nowhere, in either consumer.
    expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull();
    expect(screen.queryByText(/Buzz spend limit/)).toBeNull();
    expect(spies.openPurchaseModal).not.toHaveBeenCalled();
    // ...and Generate is back, because a viewer whose money may already be
    // committed is not blocked behind a purchase they do not need.
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
  });

  // 🔴 NO SECOND TEST HERE, AND THAT IS A MEASUREMENT. The other half of this
  // fix — that `workflow-failed` and `exception` still carry their own
  // sentences — is already pinned by `queue.test.tsx > a THROWN
  // workflow-failed submit says something different from a plain exception`.
  // A guard was written for it and then deleted: collapsing the two code
  // branches into one sentence killed the new guard AND that existing test with
  // the identical message ("Unable to find an element with the text: This
  // generation failed to start."), so the new one died for a neighbour's reason
  // and added no coverage the suite lacked. A duplicate that reads as coverage
  // while providing none is worse than none.
});

describe('R8 F3 — a submit that throws is a terminal transition, so it re-reads the balance', () => {
  it('🔴 the submit catch refetches, and the stored verdict survives the new figure', async () => {
    // 🔴 THE SENTENCE THIS MAKES TRUE. `knownBuzzBalance`'s comment licenses an
    // accepted stale-HIGH residual with "every terminal transition refetches, so
    // the window closes on its own at the next settle" — and the submit catch
    // patches the job to `'failed'`, which IS in `JOB_TERMINAL`, while starting
    // no poll loop. So on the one path round 7 changed, the block was left
    // holding a pre-submit balance AND a standing verdict with nothing scheduled
    // to refresh either: the residual's own escape hatch was missing exactly
    // where round 7 had just made the state persist.
    //
    // 🔴 AND THE MEASUREMENT THAT SAYS THE REFETCH IS SAFE TO ADD, rather than
    // an assumption. The new balance (500) COVERS the price (42), so if anything
    // still re-derived the verdict from the balance — round 6's F1 — this
    // refetch would clear a correct refusal the instant it landed. It does not,
    // because round 6's leg 2 made the verdict stored rather than derived. Both
    // halves are asserted below: the refetch fired, the figure really moved to
    // the flipping value, and the money surface is untouched.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } }); // 5 < 42
    setMockBuzzBalanceRefetch({
      kind: 'resolves',
      balance: { blue: 0, green: 0, yellow: 500 }, // covers 42 — would flip it
    });
    // Arrive at a real, correct spend-limit state via the estimate path.
    spies.estimate.mockRejectedValue(
      new WorkflowEstimateError(
        { workflowId: 'wf_est', status: 'failed', cost: { total: PRICE } } as never,
        'failed'
      )
    );
    await renderApp(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument()
    );
    freezeEstimate();

    // Nothing has settled a job yet, so nothing has refetched yet.
    spies.refetchBuzzBalance.mockClear();

    // The CTA is not a gate — `PromptTextarea` is mounted `disabled={false}`, so
    // Ctrl+Enter reaches `handleGenerate` with the top-up button on screen.
    spies.submit.mockRejectedValue(new Error('bridge request timed out'));
    await userEvent.click(screen.getByLabelText('Prompt (optional)'));
    await userEvent.keyboard('{Control>}{Enter}{/Control}');

    // POSITIVE CONTROL: we are in the catch.
    await waitFor(() =>
      expect(screen.getByText("Couldn't submit this generation.")).toBeInTheDocument()
    );
    // The claim itself. RED at 8f05293, where this path refetches nothing.
    expect(spies.refetchBuzzBalance).toHaveBeenCalledTimes(1);
    // ...and it really moved the figure, to one that COVERS the price.
    await waitFor(() => expect(getMockBuzzBalance().balance?.yellow).toBe(500));

    // The safety half: a decided verdict is not re-decided by the figure its own
    // refetch fetched.
    expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument();
    expect(screen.getByText('This generation hit a Buzz spend limit.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 *  ROUND 9 — the verdict is an answer ABOUT something, and the subject
 *  can change under it.
 * ------------------------------------------------------------------ */

describe('R9 F1 — a verdict about a 42 quote does not survive the viewer making it a 3 quote', () => {
  it('🔴 lowering a cost-bearing param retires the stale refusal, even when the re-quote never lands', async () => {
    // 🔴 ROUND 8's OWN DEFECT, IN THE DIRECTION IT DID NOT NAME. Round 8 made a
    // snapshot-less estimate rejection stop CLEARING the verdict — correct for a
    // transport error, which decides nothing — and traded the wipe for a
    // LOCKOUT, because the verdict was a bare boolean that outlived the quote it
    // was computed for.
    //
    // The measured screen, in the numbers it was reported in. The viewer holds
    // 5, the mount quote is 42, and a genuine priced refusal stores the verdict:
    // "Top up · 500", the spend-limit copy in both places, and NO Generate
    // button — the CTA replaces it. The viewer then lowers Steps so the real
    // price would be 3. The debounced re-quote fires, the orchestrator's whatIf
    // is slow, `sendTypedRequest` hits `WORKFLOW_REQUEST_TIMEOUT_MS`, and the
    // SDK's `estimate` catch RETHROWS the raw error — so a plain `Error` lands,
    // there is no snapshot, and round 8's guard skips the write. At 5c9c738 the
    // viewer is left holding a Top-up CTA and no Generate button for a
    // configuration they can afford. At 8f05293 the same rejection cleared the
    // verdict and Generate came back, and `submit()` is a different message type
    // so it would have succeeded — the regression is strictly newer than the
    // defect round 8 fixed.
    //
    // 🔴 WHY THE OTHER CANDIDATE FIX IS NOT ON THIS PATH: a re-quote after a
    // submit THROW (`runEstimateNow(true)` sits after the `await` and is never
    // reached on the throw path) cannot touch this. There is no throw here —
    // `submit()` RESOLVES a priced refusal, so line ~1136 already re-quotes on
    // exactly this path, and the lockout happens BECAUSE that re-quote rejects
    // at the transport. Adding the same call to the catch adds a retry of the
    // call that is already failing.
    setMockSettings({ show_advanced: true });
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } }); // 5 < 42
    spies.estimate.mockResolvedValue({
      workflowId: 'wf_quote',
      status: 'pending',
      cost: { total: PRICE },
    } as never);
    spies.submit.mockResolvedValue({
      workflowId: 'failed',
      status: 'failed',
      error: 'spend cap exceeded',
      cost: { total: PRICE },
    } as never);

    await renderApp(<App />);
    // The mount quote really is 42 — assert it, so "the price the verdict is
    // about" is a measurement rather than an assumption.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Generate Image · 42/ })
      ).toBeInTheDocument()
    );

    // Freeze the post-submit re-quote: a SUCCESSFUL estimate clears the verdict
    // on purpose, so leaving it live would make the refused state a race.
    freezeEstimate();
    await clickGenerate();

    // A genuine, correct refusal — never queued, priced 42, and 5 really is
    // short. This is the state the fix must NOT weaken.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument()
    );
    expect(
      screen.getAllByText('This generation hit a Buzz spend limit.')
    ).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeNull();

    // The viewer lowers Steps — and the bridge is down, so the debounced
    // re-quote rejects at the TRANSPORT with a plain `Error`.
    spies.estimate.mockRejectedValue(new Error('bridge request timed out'));
    await userEvent.click(screen.getByRole('button', { name: /Advanced settings/i }));
    fireEvent.change(screen.getByLabelText('Steps'), { target: { value: '5' } });

    // POSITIVE CONTROL: the re-quote really fired and really rejected. Without
    // it every assertion below passes just as happily if the debounce never ran.
    await waitFor(
      () =>
        expect(
          screen.getByText(
            "Couldn't estimate cost: the estimate service is unavailable — try again in a moment."
          )
        ).toBeInTheDocument(),
      { timeout: 1500 }
    );
    // 🔴 PIN THE PROPERTY, not just the outcome: what came out of `estimate()`
    // is NOT a `WorkflowEstimateError`, so it carries no snapshot and round 8's
    // guard correctly declined to write. The verdict is retired by the SUBJECT
    // changing, not by the rejection.
    const lastEstimate = spies.estimate.mock.results.at(-1)?.value;
    await expect(lastEstimate).rejects.toBeInstanceOf(Error);
    await expect(lastEstimate).rejects.not.toBeInstanceOf(WorkflowEstimateError);

    // The claim. The stored answer was about the 42 quote; this is not that
    // configuration, so it does not apply and Generate is available again.
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull();
    // 🔴 EXACTLY ONE, NOT ZERO. The CTA's copy goes with the CTA; the JOB CARD
    // keeps its sentence, because that card is a record of a decision that was
    // correct when it was made and is not re-decided by anything here.
    expect(
      screen.queryAllByText('This generation hit a Buzz spend limit.')
    ).toHaveLength(1);
    expect(spies.openPurchaseModal).not.toHaveBeenCalled();
  });

  it('a re-quote for the SAME params leaves a live verdict standing (round 8, not weakened)', async () => {
    // ⚠️ INVARIANT GUARD, NOT REGRESSION COVERAGE — green at 5c9c738 too, where
    // round 8's fix already produced this screen. It is here because the F1 fix
    // is a rule about WHAT the verdict is about, and the cheapest way to get
    // that rule wrong is to make it fire on any re-quote rather than on a
    // subject change. This is the control arm of the test above: same setup,
    // same transport rejection, NO param edit — so the verdict must stand.
    setMockSettings({ show_advanced: true });
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } }); // 5 < 42
    spies.estimate.mockResolvedValue({
      workflowId: 'wf_quote',
      status: 'pending',
      cost: { total: PRICE },
    } as never);
    spies.submit.mockResolvedValue({
      workflowId: 'failed',
      status: 'failed',
      error: 'spend cap exceeded',
      cost: { total: PRICE },
    } as never);

    await renderApp(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Generate Image · 42/ })
      ).toBeInTheDocument()
    );
    freezeEstimate();
    await clickGenerate();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument()
    );

    // A NON-cost-bearing edit — the prompt does not price and does not re-quote
    // — plus a transport rejection driven by the identity effect's own re-run.
    spies.estimate.mockRejectedValue(new Error('bridge request timed out'));
    await userEvent.click(screen.getByLabelText('Prompt (optional)'));
    await userEvent.keyboard('a cat');
    await userEvent.click(screen.getByRole('button', { name: /Advanced settings/i }));
    // Toggling the seed is a price change the block deliberately does NOT treat
    // as a subject change. 🔴 The reason written here in round 9 — "it only ever
    // moves the price UP" — was FALSE and is corrected in round 10: 🎲 is a
    // toggle, and cancelling it moves the price back DOWN. The decision stays
    // out of the key because both its flags flip as a side effect of SUBMITTING,
    // so keying on either would retire the verdict at the instant the submit
    // reply sets it. The PRESS direction asserted here is still not a subject
    // change; the CANCEL direction is the hole named on `spendSubjectKey`.
    await userEvent.click(screen.getByRole('button', { name: /🎲 random/ }));

    await waitFor(() =>
      expect(
        screen.getByText(
          "Couldn't estimate cost: the estimate service is unavailable — try again in a moment."
        )
      ).toBeInTheDocument()
    );
    // Still refused, in both places, with no Generate button.
    expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument();
    expect(
      screen.getAllByText('This generation hit a Buzz spend limit.')
    ).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeNull();
  });
});

describe('R9 F1b — the subject is stamped at KICKOFF, so a slow quote cannot claim a newer configuration', () => {
  it('🔴 a refusal that settles after the params moved does not attach itself to the new params', async () => {
    // 🔴 THIS TEST EXISTS BECAUSE A MUTATION SURVIVED. Stamping the estimate
    // verdict from `spendKeyRef.current` at SETTLE time instead of from the key
    // captured at KICKOFF passed all 194 tests — the choice was prose, not a
    // guard. This is its killing case, and it is the F1 defect one indirection
    // over: the answer would be about the quote that was SENT while the key it
    // carried named the configuration on screen when it came BACK.
    //
    // The window is real, not contrived. The debounce is 400ms, so a second
    // edit does not bump `estimateInFlightRef` until its own timer fires; an
    // in-flight quote that settles inside that gap is still "the latest" and
    // does write. Here the viewer quotes at Steps=28 (42, unaffordable), edits
    // to Steps=5 while it is in flight, and the 28-quote's refusal lands.
    //
    // (28, not 30: the showcase's own steps ARE 30, so `fireEvent.change` to
    // that value sets no new value and React fires no `change` — the edit, the
    // debounce and the quote would all be silently skipped, and every assertion
    // below would then pass with no quote in flight at all.)
    setMockSettings({ show_advanced: true });
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } }); // 5 < 42
    spies.estimate.mockResolvedValue({
      workflowId: 'wf_quote',
      status: 'pending',
      cost: { total: PRICE },
    } as never);

    await renderApp(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Generate Image · 42/ })
      ).toBeInTheDocument()
    );
    await userEvent.click(screen.getByRole('button', { name: /Advanced settings/i }));

    // The next quote hangs, so we can settle it by hand AFTER the params move.
    let rejectQuote: (e: unknown) => void = () => {};
    const quotePending = new Promise((_resolve, reject) => {
      rejectQuote = reject;
    });
    spies.estimate.mockImplementation(() => quotePending as never);
    const callsBefore = spies.estimate.mock.calls.length;

    fireEvent.change(screen.getByLabelText('Steps'), { target: { value: '28' } });
    // The 28-quote really did leave (the debounce fired) — assert it, so what
    // follows is a settle-after-edit rather than a quote that never started.
    await waitFor(() => expect(spies.estimate.mock.calls.length).toBe(callsBefore + 1), {
      timeout: 1500,
    });

    // The viewer edits again. Synchronous, and inside the 400ms before this
    // edit's own quote fires — so the hung 30-quote is still the latest and its
    // settle is NOT dropped by the race guard.
    fireEvent.change(screen.getByLabelText('Steps'), { target: { value: '5' } });
    await act(async () => {
      rejectQuote(
        new WorkflowEstimateError(
          { workflowId: 'wf_est30', status: 'failed', cost: { total: PRICE } } as never,
          'failed'
        )
      );
      await quotePending.catch(() => {});
    });

    // POSITIVE CONTROL, and it is the discriminating one: the catch ran with
    // `myId` still current. Had the race guard dropped this settle, nothing
    // would have written `estimateError` either, and every assertion below
    // would pass for the wrong reason.
    await waitFor(() =>
      expect(
        screen.getByText(
          "Couldn't estimate cost: the estimate service is unavailable — try again in a moment."
        )
      ).toBeInTheDocument()
    );

    // The claim: that refusal priced Steps=28. The screen is Steps=5.
    expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull();
    expect(screen.queryByText(/Buzz spend limit/)).toBeNull();
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
    expect(spies.openPurchaseModal).not.toHaveBeenCalled();
  });
});

describe('R10 F1 — the seed VALUE is cost-bearing, so it is part of the subject', () => {
  it('🔴 clearing a typed seed back to the showcase value retires the stale refusal', async () => {
    // 🔴 THE SEED PRICES, AND ROUND 9 LEFT IT OUT OF BOTH HALVES.
    // `buildSubmitParams` resolves `overrides.seed ?? showcase.seed` into the
    // estimate payload, and the block's own pricing rule is that the showcase's
    // cached seed whatifs to 0 while anything else is a fresh job at full cost.
    // So a typed seed moves the price exactly the way the randomize decision
    // does — and at 4459967 `overrides.seed` was in NEITHER the subject key NOR
    // either estimate effect's deps.
    //
    // The measured screen at 4459967: the viewer types a seed, gets a priced
    // refusal, then clears the field back to the showcase value. The key never
    // moves, so the verdict still applies; and NOTHING re-quotes, so no
    // replacement is even scheduled. Top-up CTA, no Generate button, over a
    // configuration the block has never priced as unaffordable. Unlike round 9's
    // repro this needs no bridge outage to reach — zero re-quotes fire either
    // way.
    //
    // This test pins BOTH halves, because either alone is a defect: the key
    // alone would retire the verdict with nothing scheduled to replace it, and
    // the re-quote alone would leave the stale verdict standing whenever that
    // re-quote fails at the transport (which is exactly the arm asserted here).
    setMockSettings({ show_advanced: true });
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } }); // 5 < 42
    spies.estimate.mockResolvedValue({
      workflowId: 'wf_quote',
      status: 'pending',
      cost: { total: PRICE },
    } as never);
    spies.submit.mockResolvedValue({
      workflowId: 'failed',
      status: 'failed',
      error: 'spend cap exceeded',
      cost: { total: PRICE },
    } as never);

    await renderApp(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Generate Image · 42/ })
      ).toBeInTheDocument()
    );

    // Type a seed the showcase does not carry (showcase[0].seed is 12345). This
    // is the configuration the refusal below will be ABOUT.
    await userEvent.click(screen.getByRole('button', { name: /Advanced settings/i }));
    fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '999' } });

    // POSITIVE CONTROL ON THE PAYLOAD, not on the UI: the seed the block sends
    // really does change with the field, so "the seed prices" is a measurement
    // of what leaves this block rather than a claim about the orchestrator.
    await waitFor(
      () => {
        const last = spies.estimate.mock.calls.at(-1)![0] as {
          params: { seed?: number };
        };
        expect(last.params.seed).toBe(999);
      },
      { timeout: 1500 }
    );

    // Freeze the post-submit re-quote so the refused window is a state, not a
    // race — a SUCCESSFUL estimate clears the verdict on purpose.
    freezeEstimate();
    await clickGenerate();

    // A genuine, correct refusal, priced 42 against a balance of 5.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument()
    );
    expect(
      screen.getAllByText('This generation hit a Buzz spend limit.')
    ).toHaveLength(2);
    expect(
      screen.queryByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeNull();

    // The viewer clears the seed back to the showcase's own value — a price
    // change DOWNWARD (fresh job → cache hit) — and the bridge is down, so the
    // re-quote this now schedules rejects at the TRANSPORT with a plain `Error`
    // and, by round 8's rule, writes nothing.
    spies.estimate.mockRejectedValue(new Error('bridge request timed out'));
    fireEvent.change(screen.getByLabelText('Seed'), { target: { value: '' } });

    // POSITIVE CONTROL — half two of the fix. At 4459967 a seed edit fired ZERO
    // re-quotes, so this message never appeared at all. Without this assertion
    // the CTA claim below would pass just as happily on a key-only change that
    // schedules nothing.
    await waitFor(
      () =>
        expect(
          screen.getByText(
            "Couldn't estimate cost: the estimate service is unavailable — try again in a moment."
          )
        ).toBeInTheDocument(),
      { timeout: 1500 }
    );
    // 🔴 PIN THE PROPERTY: what came out of `estimate()` carries no snapshot, so
    // round 8's guard correctly declined to write. The verdict is retired by the
    // SUBJECT changing, not by the rejection — the same discrimination round 9
    // made for width/height/steps.
    const lastEstimate = spies.estimate.mock.results.at(-1)?.value;
    await expect(lastEstimate).rejects.toBeInstanceOf(Error);
    await expect(lastEstimate).rejects.not.toBeInstanceOf(WorkflowEstimateError);

    // The claim. The stored answer was about the seed-999 configuration; this is
    // not that configuration, so it does not apply.
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull();
    // Exactly one, not zero — the JOB CARD keeps its sentence, because it is a
    // record of a decision that was correct when it was made.
    expect(
      screen.queryAllByText('This generation hit a Buzz spend limit.')
    ).toHaveLength(1);
    expect(spies.openPurchaseModal).not.toHaveBeenCalled();
  });
});

describe('R10 F2 — the SUBMIT site stamps its verdict at KICKOFF, not at settle', () => {
  it('a refusal that settles after the params moved does not attach itself to the new params', async () => {
    // ⚠️ INVARIANT GUARD, NOT REGRESSION COVERAGE — green at 4459967, where
    // `submitSubjectKey` already captures the key before the awaits. It exists
    // because round 9 added the equivalent guard for the ESTIMATE site (R9 F1b)
    // after that site's mutation survived, wrote the same rule at the submit
    // site, and added no guard there. Mutating the submit stamp to settle-time
    // (`spendKeyRef.current`) SURVIVED all 195 tests at 4459967, so the rule was
    // asserted only by a comment.
    //
    // The behaviour it covers is real: click Generate at Steps=30, move Steps to
    // 5 while the submit is in flight, and the reply is a priced refusal against
    // the SUBMITTED configuration. Stamped at kickoff it names Steps=30, which is
    // no longer on screen, so no CTA appears. Stamped at settle it names Steps=5
    // — a configuration this refusal was never about, and one the block has
    // never quoted — and the viewer is asked to buy Buzz for it.
    setMockSettings({ show_advanced: true });
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 5 } }); // 5 < 42
    spies.estimate.mockResolvedValue({
      workflowId: 'wf_quote',
      status: 'pending',
      cost: { total: PRICE },
    } as never);

    // A submit we hold open, so the param edit lands strictly between kickoff
    // and settle — the only window in which the two stamps differ.
    let settleSubmit!: (snap: unknown) => void;
    spies.submit.mockImplementation(
      () =>
        new Promise((resolve) => {
          settleSubmit = resolve;
        })
    );

    await renderApp(<App />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Generate Image · 42/ })
      ).toBeInTheDocument()
    );
    await userEvent.click(screen.getByRole('button', { name: /Advanced settings/i }));

    // Freeze the estimate so the ONLY writer of the verdict in this test is the
    // submit reply. A successful re-quote would clear it and mask both stamps.
    freezeEstimate();
    await clickGenerate();
    await waitFor(() => expect(spies.submit).toHaveBeenCalledTimes(1));

    // The submitted configuration really was Steps=30 (showcase[0]).
    const submitted = spies.submit.mock.calls.at(-1)![0] as {
      params: { steps?: number };
    };
    expect(submitted.params.steps).toBe(30);

    // The viewer moves a cost-bearing param while the submit is still open.
    fireEvent.change(screen.getByLabelText('Steps'), { target: { value: '5' } });

    // Now the refusal lands — about Steps=30, not about what is on screen.
    await act(async () => {
      settleSubmit({
        workflowId: 'failed',
        status: 'failed',
        error: 'spend cap exceeded',
        cost: { total: PRICE },
      });
    });

    // The job card records the decision that was made...
    await waitFor(() =>
      expect(
        screen.getAllByText('This generation hit a Buzz spend limit.')
      ).toHaveLength(1)
    );
    // ...but the CTA does not, because the verdict is not about this
    // configuration. Under the settle-time mutant both of these invert.
    expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
    expect(spies.openPurchaseModal).not.toHaveBeenCalled();
  });
});
