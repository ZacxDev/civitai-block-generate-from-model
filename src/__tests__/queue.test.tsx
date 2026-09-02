/**
 * Task 3: client-side generation queue.
 *
 * The block replicates the on-site Civitai generator's queue UX — firing
 * off multiple generations that run + poll independently and stack in the
 * results carousel as queued / processing / done items, without waiting
 * for one to finish before starting the next.
 *
 * The SDK's `useBuzzWorkflow` is single-workflow-stateful (one shared
 * `status` / `result`), but its `submit()` / `poll()` primitives RETURN
 * the snapshot directly, so the queue drives N concurrent workflows off
 * the returned values without any SDK change. These tests assert:
 *   - multiple submits enqueue without waiting on each other
 *   - each job polls + completes independently (per-job poll loop)
 *   - the form stays enabled across submits (task 2 pairing)
 *   - results land per-job (each completed job gets its own card)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  blocksReactMockFactory,
  getMockSpies,
  renderApp,
  resetBlocksReactMock,
  setMockBuzzBalance,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { App } from '../App';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  resetBlocksReactMock();
});

describe('Generation queue (task 3)', () => {
  it('two submits enqueue WITHOUT waiting — the second submit fires before the first completes', async () => {
    const spies = getMockSpies();
    // submit() resolves instantly with a per-call workflowId so the queue
    // can track each job; poll() stays pending (deferred) so neither job
    // completes during this test — proving the 2nd submit doesn't wait on
    // the 1st finishing.
    let submitN = 0;
    spies.submit.mockImplementation(() => {
      submitN += 1;
      return Promise.resolve({
        workflowId: `wf_${submitN}`,
        status: 'pending',
      } as never);
    });
    const pollGate = deferred<never>();
    spies.poll.mockImplementation(() => pollGate.promise);

    await renderApp(<App />);
    const generate = () =>
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ });

    await userEvent.click(generate());
    await waitFor(() => expect(spies.submit).toHaveBeenCalledTimes(1));
    // Button is still enabled — fire a second one immediately.
    expect(generate()).not.toBeDisabled();
    await userEvent.click(generate());
    await waitFor(() => expect(spies.submit).toHaveBeenCalledTimes(2));

    // Two in-flight LoadingCards now sit in the carousel — one per job.
    await waitFor(() => {
      expect(screen.getAllByLabelText('Generating')).toHaveLength(2);
    });
  });

  // ----------------------------------------------------------------------
  // Queue-driver invariants (post-bridge-removal, 2026-06-01).
  //
  // The shared-state "compatibility bridge" useEffect was removed: the queue
  // is now driven SOLELY by handleGenerate + per-job poll loops. The three
  // phantom-card bugs the bridge caused (estimate mints a phantom; a stale
  // estimate result mints a 2nd card mid-poll; a submit's shared-result race
  // mints a duplicate) are now STRUCTURALLY impossible — nothing reads the
  // hook's shared `result`/`status` into the queue. These tests assert the
  // user-visible guarantees those regressions protected, driven via the REAL
  // path, so the guarantees stay covered even though the bug mechanism is gone.
  // ----------------------------------------------------------------------

  it('calling estimate() (mount + showcase pick) adds NO queue card', async () => {
    // estimate() fires on mount, on every showcase pick, and on cost-bearing
    // override changes. None of these may surface a queue card — only an
    // explicit Generate click does. (The pre-removal bridge minted a phantom
    // "pending" card on every estimate because each estimate's unique whatif
    // workflowId looked like a never-seen submitted workflow.)
    const spies = getMockSpies();
    await renderApp(<App />);

    // Mount already ran the auto-estimate.
    await waitFor(() => expect(spies.estimate).toHaveBeenCalled());
    expect(screen.queryAllByLabelText('Generating')).toHaveLength(0);
    expect(screen.queryByTestId('gfm-results-carousel')).not.toBeInTheDocument();

    // A showcase pick fires another estimate — still no card.
    await userEvent.click(screen.getByRole('button', { name: 'Pick preview 2' }));
    await waitFor(() =>
      expect(spies.estimate.mock.calls.length).toBeGreaterThan(1)
    );
    expect(screen.queryAllByLabelText('Generating')).toHaveLength(0);
    expect(screen.queryByTestId('gfm-results-carousel')).not.toBeInTheDocument();
  });

  it('a single submit that polls produces EXACTLY ONE card even while estimates fire concurrently', async () => {
    // handleGenerate calls runEstimateNow() right after submit() resolves, so
    // an estimate snapshot lands in the hook's shared `result` WHILE the job
    // polls. With the bridge gone this can't mint a phantom: there is exactly
    // one card the whole time, driven by the own job's poll loop.
    const spies = getMockSpies();
    spies.submit.mockResolvedValue({ workflowId: 'wf_real', status: 'pending' } as never);
    const pollGate = deferred<never>();
    spies.poll.mockImplementation(() => pollGate.promise); // own job stays in flight

    await renderApp(<App />);
    const generate = () =>
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ });
    await userEvent.click(generate());
    await waitFor(() => expect(spies.submit).toHaveBeenCalledTimes(1));
    // Exactly one in-flight card.
    await waitFor(() => expect(screen.getAllByLabelText('Generating')).toHaveLength(1));

    // Force several more estimates (showcase picks) while the job polls — none
    // may add a second card.
    await userEvent.click(screen.getByRole('button', { name: 'Pick preview 2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Pick preview 3' }));
    await userEvent.type(screen.getByLabelText('Prompt (optional)'), 'extra');

    // Still exactly ONE in-flight card — no phantom from any estimate.
    await waitFor(() => expect(screen.getAllByLabelText('Generating')).toHaveLength(1));
    expect(screen.getAllByLabelText('Generating')).toHaveLength(1);

    pollGate.resolve({
      workflowId: 'wf_real',
      status: 'succeeded',
      imageUrls: ['https://example.test/done.jpg'],
    } as never);
  });

  it('two submits produce TWO independent cards (no merge, no duplicate)', async () => {
    // Each Generate click mints its own job keyed by a fresh localId; two
    // clicks → two distinct in-flight cards driven by two independent poll
    // loops. The shared hook state plays no part.
    const spies = getMockSpies();
    let submitN = 0;
    spies.submit.mockImplementation(() => {
      submitN += 1;
      return Promise.resolve({ workflowId: `wf_${submitN}`, status: 'pending' } as never);
    });
    const pollGate = deferred<never>();
    spies.poll.mockImplementation(() => pollGate.promise); // both stay in flight

    await renderApp(<App />);
    const generate = () =>
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ });

    await userEvent.click(generate());
    await waitFor(() => expect(spies.submit).toHaveBeenCalledTimes(1));
    await userEvent.click(generate());
    await waitFor(() => expect(spies.submit).toHaveBeenCalledTimes(2));

    // Exactly two in-flight cards — one per submit.
    await waitFor(() => expect(screen.getAllByLabelText('Generating')).toHaveLength(2));
  });

  it('each job polls + completes independently (different images land per job)', async () => {
    const spies = getMockSpies();
    let submitN = 0;
    spies.submit.mockImplementation(() => {
      submitN += 1;
      return Promise.resolve({
        workflowId: `wf_${submitN}`,
        status: 'pending',
      } as never);
    });
    // poll(workflowId) returns a succeeded snapshot whose image URL is
    // derived from the workflowId — so we can prove each job's poll loop
    // resolved its OWN workflow.
    spies.poll.mockImplementation((workflowId: string) =>
      Promise.resolve({
        workflowId,
        status: 'succeeded',
        imageUrls: [`https://example.test/${workflowId}.jpg`],
        cost: { total: 34 },
      } as never)
    );

    await renderApp(<App />);
    const generate = () =>
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ });

    await userEvent.click(generate());
    await userEvent.click(generate());

    // Both jobs poll to succeeded independently — two Download cards land,
    // one per workflowId.
    await waitFor(
      () => {
        expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(2);
      },
      { timeout: 2000 }
    );

    const carousel = screen.getByTestId('gfm-results-carousel');
    const urls = Array.from(carousel.querySelectorAll('img')).map((i) => i.src);
    expect(urls).toContain('https://example.test/wf_1.jpg');
    expect(urls).toContain('https://example.test/wf_2.jpg');
  });

  it('the form stays enabled across submits while jobs are in flight (task 2)', async () => {
    const spies = getMockSpies();
    let submitN = 0;
    spies.submit.mockImplementation(() => {
      submitN += 1;
      return Promise.resolve({ workflowId: `wf_${submitN}`, status: 'pending' } as never);
    });
    const pollGate = deferred<never>();
    spies.poll.mockImplementation(() => pollGate.promise);

    await renderApp(<App />);
    await userEvent.click(screen.getByRole('button', { name: /Generate Image|Re-generate Image/ }));
    await waitFor(() => expect(spies.submit).toHaveBeenCalledTimes(1));

    // While the first job polls (gated), every form control stays enabled.
    expect(screen.getByLabelText('Prompt (optional)')).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pick preview 1' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Advanced settings' })).not.toBeDisabled();
  });

  it('a RESOLVED failed snapshot puts OUR words on the card, not the server\'s', async () => {
    // 🔴 THE COMMON CASE. A budget refusal, a velocity limit, a daily cap and a
    // fail-closed deny all RESOLVE with status:'failed' rather than throwing —
    // so fixing only the throwing catches left `snapshot.error` (server-authored
    // and unsanitised; the SDK documents it as carrying raw Prisma/pg column and
    // constraint names) still going straight onto the card.
    const spies = getMockSpies();
    spies.submit.mockResolvedValue({
      workflowId: 'wf_fail',
      status: 'failed',
      error: 'insufficient balance for account 12345',
    } as never);
    await renderApp(<App />);
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      // Our words, not the server's. And NOT a Buzz claim: this snapshot carries
      // no price, so it is not the documented budget refusal — an earlier
      // version of this test asserted "Not enough Buzz" purely because the text
      // contained "insufficient", which is the substring guessing that got
      // removed.
      expect(screen.getByText('This generation failed.')).toBeInTheDocument();
    });
    expect(screen.queryByText(/account 12345/)).toBeNull();
    expect(screen.queryByText(/Buzz spend limit/)).toBeNull();
  });

  it('does NOT guess at the server\'s wording — "generate"/"moderated" are not rate limits', async () => {
    // 🔴 THE REGRESSION THIS EXISTS FOR. A substring classifier matched
    // /rate|too many|velocity|limit/ against server text, and `rate` sits inside
    // "geneRATEd" and "modeRATEd" — the most common words in this domain. A
    // moderation rejection rendered as "Too many generations right now", which
    // tells the user to wait when they need to change their prompt.
    const spies = getMockSpies();
    spies.submit.mockResolvedValue({
      workflowId: 'wf_mod',
      status: 'failed',
      error: 'NSFW prompt was moderated; image could not be generated',
    } as never);
    await renderApp(<App />);
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      expect(screen.getByText('This generation failed.')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Too many generations/)).toBeNull();
    expect(screen.queryByText(/Buzz spend limit/)).toBeNull();
    expect(screen.queryByText(/moderated/)).toBeNull();
  });

  it('does not call an infrastructure failure a Buzz shortfall', async () => {
    // "not enough VRAM" contains "not enough". Only a PRICED refusal is a Buzz
    // problem, and that is a fact about the snapshot's shape, not its prose.
    const spies = getMockSpies();
    spies.submit.mockResolvedValue({
      workflowId: 'wf_vram',
      status: 'failed',
      error: 'not enough VRAM available on the worker',
    } as never);
    await renderApp(<App />);
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      expect(screen.getByText('This generation failed.')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Buzz spend limit/)).toBeNull();
  });

  it('a PRICED refusal on submit the viewer CANNOT afford says so in BOTH places, exactly twice', async () => {
    // 🔴 EXACTLY TWO, not "> 0". The claim this test makes is that the CTA copy
    // and the job card AGREE, and `toBeGreaterThan(0)` cannot tell 2 from 1 —
    // it passes just as happily when one of the two consumers has stopped
    // saying it, which is the exact disagreement the one predicate exists to
    // prevent. Measured: with `> 0`, re-scoping `viewerFailureText` to the
    // submit phase (so the card and the CTA use different rules) left the whole
    // suite green.
    const spies = getMockSpies();
    // Broke: 5 < 42, and 42 is under DEFAULT_TOKEN.buzzBudget (50).
    setMockBuzzBalance({ balance: { blue: 5, green: 0, yellow: 0 } });
    spies.submit.mockResolvedValue({
      workflowId: 'wf_budget',
      status: 'failed',
      error: 'spend cap exceeded',
      cost: { total: 42 },
    } as never);
    await renderApp(<App />);
    // Freeze the post-submit re-quote. A SUCCESSFUL re-estimate publishes its
    // own snapshot over the hook's shared `result` and deliberately clears this
    // CTA (pinned by error-cta's "does not LATCH"), so leaving it live makes the
    // window under assertion a race rather than a state.
    spies.estimate.mockImplementation(() => new Promise(() => {}));
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      expect(
        screen.getAllByText('This generation hit a Buzz spend limit.')
      ).toHaveLength(2);
    });
    // ...and the money surface is the whole surface: Generate is gone.
    expect(
      screen.queryByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeNull();
  });

  it('the POLL site maps too — an async failure never leaks the server text', async () => {
    // The submit-site test reached only one of the two write sites; the poll
    // site is the one an asynchronously-failing job actually takes, and
    // reverting it to raw `snap.error` survived the whole suite.
    const spies = getMockSpies();
    spies.submit.mockResolvedValue({ workflowId: 'wf_async', status: 'pending' } as never);
    spies.poll.mockResolvedValue({
      workflowId: 'wf_async',
      status: 'failed',
      error: 'Unique constraint failed on the fields: (`accountBalance`)',
    } as never);
    await renderApp(<App />);
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      expect(screen.getByText('This generation failed.')).toBeInTheDocument();
    });
    expect(screen.queryByText(/accountBalance/)).toBeNull();
    expect(screen.queryByText(/Buzz spend limit/)).toBeNull();
  });

  it('🔴 a job that was CHARGED and then failed mid-render is NOT a spend limit', async () => {
    // 🔴 THE ROUND-4 DEFECT, pinned behaviourally. `poll()` publishes every
    // resolved reply onto the hook's shared `result`, so an ordinary job that
    // was queued, charged, and then died mid-render arrives as
    // `{status:'failed', cost:{total:42}}` — the same shape as a budget
    // refusal. Under "priced + failed" alone that rendered a "Top up · N"
    // button, REMOVED Generate, SUPPRESSED the real error card, and told the
    // user they had hit a Buzz spend limit. They had not: they had paid.
    //
    // The discriminator is the balance. 500 covers 42, so whatever went wrong,
    // money was not it.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 500, green: 0, yellow: 0 } });
    spies.submit.mockResolvedValue({ workflowId: 'wf_p', status: 'pending' } as never);
    spies.poll.mockResolvedValue({
      workflowId: 'wf_p',
      status: 'failed',
      error: 'NSFW output was moderated after render',
      cost: { total: 42 },
    } as never);
    await renderApp(<App />);
    spies.estimate.mockImplementation(() => new Promise(() => {}));
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    // The user-visible outcome, all four parts of it.
    await waitFor(() => {
      expect(screen.getByText('This generation failed.')).toBeInTheDocument();
    });
    // 1. Generate is still there — nothing about this failure is fixed by money.
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
    // 2. No purchase CTA, and 3. no spend-limit sentence anywhere.
    expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull();
    expect(screen.queryByText(/Buzz spend limit/)).toBeNull();
    // 4. The real error surface is NOT suppressed — that suppression
    //    (`&& !spendLimited`) is what hid the actual failure from the user.
    expect(screen.getByText('Generation failed.')).toBeInTheDocument();
    // ...and the server's unsanitised words still never reach the screen.
    expect(screen.queryByText(/moderated/)).toBeNull();
    expect(getMockSpies().openPurchaseModal).not.toHaveBeenCalled();
  });

  it('a priced refusal with NO server text still fills the job card (submit site)', async () => {
    // 🔴 Both card write sites used to be gated on `snap.error` being truthy.
    // The server is not obliged to send one — `snapshotFromWorkflow` omits the
    // key whenever there is nothing to say — so a priced `failed` reply with no
    // text produced the money CTA above and a card that said nothing about why.
    // The one predicate's two consumers, visibly disagreeing.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 0 } });
    spies.submit.mockResolvedValue({
      workflowId: 'wf_silent',
      status: 'failed',
      cost: { total: 42 },
    } as never);
    await renderApp(<App />);
    spies.estimate.mockImplementation(() => new Promise(() => {}));
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      expect(
        screen.getAllByText('This generation hit a Buzz spend limit.')
      ).toHaveLength(2);
    });
  });

  it('a priced refusal with NO server text still fills the job card (poll site)', async () => {
    // Same gap at the other write site — the one an asynchronously-failing job
    // actually takes: a `failed` reply carrying no `error` string must still
    // produce card copy rather than a silent card.
    //
    // 🔴 ROUND 6 INVERTED THE VERDICT THIS ASSERTS (it demanded the spend-limit
    // sentence, twice). A poll failure only ever reaches this block on a job
    // whose `submit()` already replied non-`failed` — i.e. one the host
    // ACCEPTED and, per the SDK, already charged. It cannot be an affordability
    // refusal at any balance. The claim being kept is the one this test was
    // written for: the card is not silent.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 0 } });
    spies.submit.mockResolvedValue({ workflowId: 'wf_sil2', status: 'pending' } as never);
    spies.poll.mockResolvedValue({
      workflowId: 'wf_sil2',
      status: 'failed',
      cost: { total: 42 },
    } as never);
    await renderApp(<App />);
    spies.estimate.mockImplementation(() => new Promise(() => {}));
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      expect(screen.getByText('This generation failed.')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Buzz spend limit/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull();
  });

  it('🔴 the SAME priced poll failure is STILL not a spend limit at ANY balance', async () => {
    // 🔴 ROUND 6, THE HEART OF F1. This test used to be the POSITIVE CONTROL
    // for the guard above it — same snapshot, only the balance moved, therefore
    // a spend limit. It was asserting the defect. `1+1+1 = 3 < 42` says the
    // viewer cannot afford 42, and that arithmetic is TRUE and IRRELEVANT: this
    // job was accepted and charged, so the 42 is already gone and the reason it
    // died was moderation. Selling this viewer Buzz fixes nothing.
    //
    // The real positive control for the money CTA is the SUBMIT-site refusal
    // ("a PRICED refusal on submit the viewer CANNOT afford…") — a job that was
    // never queued, where a top-up genuinely is the fix. The discriminator is
    // acceptance; the balance is only consulted once acceptance has been ruled
    // out.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 1, green: 1, yellow: 1 } }); // 3 < 42
    spies.submit.mockResolvedValue({ workflowId: 'wf_p2', status: 'pending' } as never);
    spies.poll.mockResolvedValue({
      workflowId: 'wf_p2',
      status: 'failed',
      error: 'NSFW output was moderated after render',
      cost: { total: 42 },
    } as never);
    await renderApp(<App />);
    spies.estimate.mockImplementation(() => new Promise(() => {}));
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      expect(screen.getByText('This generation failed.')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Buzz spend limit/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
    // The real failure surface is not suppressed.
    expect(screen.getByText('Generation failed.')).toBeInTheDocument();
  });

  it('a spy-driven priced refusal reaches the CTA — the mock publishes `result` like the hook', async () => {
    // 🔴 SEAM GUARD. The money CTA is computed from the hook's shared `result`,
    // which blocks-react sets on every resolved reply. The test mock used to
    // return only a statically-configured `result`, so ANY test that drove a
    // failure through the `submit`/`poll` spies left it null — and every
    // assertion about the CTA in those tests passed VACUOUSLY. That seam is
    // where a real defect lived undetected: the helper and the router were each
    // tested alone and the join between them never was.
    //
    // This drives the SPY (not setMockWorkflow) and asserts the surface that
    // only `result` can produce, so reverting the mock to a static value fails
    // here rather than silently un-testing six other cases.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 0 } });
    spies.submit.mockResolvedValue({
      workflowId: 'wf_seam',
      status: 'failed',
      error: 'spend cap exceeded',
      cost: { total: 9 },
    } as never);
    await renderApp(<App />);
    spies.estimate.mockImplementation(() => new Promise(() => {}));
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument();
    });
  });

  it('a terminal workflow REFETCHES the balance — a stale figure misjudges the next refusal', async () => {
    // 🔴 The predicate compares the viewer's balance against the NEXT refusal's
    // price. The generation that just settled is precisely the thing that moved
    // that balance, so without a re-read the next classification is made against
    // a wallet that no longer exists.
    const spies = getMockSpies();
    setMockBuzzBalance({ balance: { blue: 500, green: 0, yellow: 0 } });
    spies.submit.mockResolvedValue({ workflowId: 'wf_rf', status: 'pending' } as never);
    spies.poll.mockResolvedValue({
      workflowId: 'wf_rf',
      status: 'succeeded',
      imageUrls: ['https://example.test/ok.jpg'],
      cost: { total: 12 },
    } as never);
    await renderApp(<App />);
    spies.refetchBuzzBalance.mockClear();
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1)
    );
    expect(spies.refetchBuzzBalance).toHaveBeenCalled();
  });

  it("logs the server's reason even though it never renders it", async () => {
    // 🔴 The SDK's rule is "log it, show it in a developer surface, never render
    // it verbatim". After the render fix this text was reaching NEITHER — the
    // resolved path is the common one and had no log at all, so for most
    // failures nobody could find out what happened.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const spies = getMockSpies();
      spies.submit.mockResolvedValue({
        workflowId: 'wf_log',
        status: 'failed',
        error: 'orchestrator exploded in a very specific way',
      } as never);
      await renderApp(<App />);
      await userEvent.click(
        screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
      );
      await waitFor(() => {
        expect(screen.getByText('This generation failed.')).toBeInTheDocument();
      });
      const logged = warn.mock.calls.some((args) =>
        JSON.stringify(args).includes('orchestrator exploded in a very specific way')
      );
      expect(logged).toBe(true);
      // ...and still not on screen.
      expect(screen.queryByText(/orchestrator exploded/)).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('a THROWN workflow-failed submit says something different from a plain exception', async () => {
    // The SDK is emphatic that the two codes differ on whether money may have
    // moved, so they must not share a sentence.
    const { WorkflowSubmitError } = await import('@civitai/blocks-react');
    const spies = getMockSpies();
    spies.submit.mockRejectedValue(
      new WorkflowSubmitError(
        { workflowId: 'wf', status: 'failed' } as never,
        'workflow-failed'
      )
    );
    await renderApp(<App />);
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      expect(screen.getByText('This generation failed to start.')).toBeInTheDocument();
    });
  });

  it('a job that fails to submit becomes a failed card without affecting siblings', async () => {
    const spies = getMockSpies();
    let submitN = 0;
    spies.submit.mockImplementation(() => {
      submitN += 1;
      if (submitN === 1) {
        return Promise.resolve({
          workflowId: 'wf_ok',
          status: 'succeeded',
          imageUrls: ['https://example.test/ok.jpg'],
          cost: { total: 12 },
        } as never);
      }
      return Promise.reject(new Error('orchestrator unavailable'));
    });

    await renderApp(<App />);
    const generate = () => screen.getByRole('button', { name: /Generate Image|Re-generate Image/ });

    // First submit succeeds synchronously (cached) → Download card.
    await userEvent.click(generate());
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1)
    );

    // Second submit rejects → a failed card appears; the first card stays.
    // 🔴 The card must NOT show the raw error text. This asserted
    // `getByText(/orchestrator unavailable/)` until the blocks-react 0.44 bump
    // made submit() THROW rather than resolve a failed snapshot — at which
    // point the string on the card became the SDK's developer-facing summary
    // ("submit did not return a usable workflow (…) — reason on
    // .snapshot.error"), which the SDK documents must never reach a viewer.
    await userEvent.click(generate());
    await waitFor(() => {
      expect(screen.getByText(/Couldn't submit this generation/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/orchestrator unavailable/)).toBeNull();
    // The successful card is untouched.
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1);
  });
});
