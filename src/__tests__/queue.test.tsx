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
      expect(screen.getByText('Not enough Buzz for this generation.')).toBeInTheDocument();
    });
    expect(screen.queryByText(/account 12345/)).toBeNull();
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
