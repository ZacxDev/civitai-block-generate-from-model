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
    expect(screen.queryByText(/Not enough Buzz/)).toBeNull();
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
    expect(screen.queryByText(/Not enough Buzz/)).toBeNull();
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
    expect(screen.queryByText(/Not enough Buzz/)).toBeNull();
  });

  it('a PRICED refusal on submit IS reported as a Buzz shortfall', async () => {
    // The one structural case: the SDK documents the budget refusal as the
    // resolved-failed reply that still carries the price it refused to charge.
    const spies = getMockSpies();
    spies.submit.mockResolvedValue({
      workflowId: 'wf_budget',
      status: 'failed',
      error: 'spend cap exceeded',
      cost: { total: 42 },
    } as never);
    await renderApp(<App />);
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      expect(screen.getByText('Not enough Buzz for this generation.')).toBeInTheDocument();
    });
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
    expect(screen.queryByText(/Not enough Buzz/)).toBeNull();
  });

  it('a PRICED poll failure is still NOT a Buzz shortfall (phase scoping)', async () => {
    // The price-carries-the-refusal rule is documented for the SUBMIT reply. A
    // job that already started and later failed is not a budget refusal however
    // it is priced — without the `phase === 'submit'` term this renders a Buzz
    // shortfall for, say, a worker crash on a priced job.
    const spies = getMockSpies();
    spies.submit.mockResolvedValue({ workflowId: 'wf_p', status: 'pending' } as never);
    spies.poll.mockResolvedValue({
      workflowId: 'wf_p',
      status: 'failed',
      error: 'worker crashed mid-render',
      cost: { total: 42 },
    } as never);
    await renderApp(<App />);
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      expect(screen.getByText('This generation failed.')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Not enough Buzz/)).toBeNull();
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
