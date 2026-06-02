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
  setMockWorkflow,
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

  it('a single submit makes exactly ONE card — the bridge does not duplicate it', async () => {
    // Regression for the duplicate-card bug: handleGenerate enqueues its job
    // BEFORE submit() resolves (workflowId still null), and the real
    // useBuzzWorkflow.submit updates the hook's SHARED result (carrying the
    // workflowId) in a separate microtask from handleGenerate's patchJob that
    // stamps the job. In that gap the compatibility bridge used to see a
    // workflowId no job "owned" yet and mint a SECOND, bridged card — the extra
    // one showed 0 Buzz and never resolved. The guard must suppress it.
    const spies = getMockSpies();
    const submitGate = deferred<never>();
    spies.submit.mockImplementation(() => submitGate.promise); // stays in flight
    const pollGate = deferred<never>();
    spies.poll.mockImplementation(() => pollGate.promise);

    await renderApp(<App />);
    const generate = () =>
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ });

    await userEvent.click(generate());
    await waitFor(() => expect(spies.submit).toHaveBeenCalledTimes(1));
    // One in-flight card: the non-bridged submit job (workflowId still null).
    expect(screen.getAllByLabelText('Generating')).toHaveLength(1);

    // Now the hook's shared result gains a workflowId mid-flight (mimicking
    // submit's setResult landing before patchJob), then a re-render drives the
    // bridge to re-evaluate. The pending own-submit is about to own wf_race.
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_race', status: 'processing' } as never,
    });
    await userEvent.type(screen.getByLabelText('Prompt (optional)'), 'x'); // force re-render

    // Still exactly ONE in-flight card — no bridged duplicate for wf_race.
    await waitFor(() => {
      expect(screen.getAllByLabelText('Generating')).toHaveLength(1);
    });
    // Allow the in-flight test to settle the hanging promises.
    submitGate.resolve({ workflowId: 'wf_race', status: 'processing' } as never);
  });

  it('an estimate snapshot does NOT mint a phantom loading card (status-gated)', async () => {
    // Regression: the real useBuzzWorkflow leaves the estimate snapshot in the
    // shared `result` after every estimate() (fires on mount + every showcase
    // pick + every cost-bearing override). That snapshot carries a real,
    // UNIQUE orchestrator workflowId (a whatif preview still gets a fresh id),
    // so the compatibility bridge — which keys off result.workflowId — used to
    // mint a brand-new phantom "pending" card on every estimate. The bridge
    // must gate on the hook STATUS ('confirming' = estimate, not a submit),
    // since the workflowId value can't distinguish estimate from submit.
    await renderApp(<App />);

    // Mimic the real SDK after estimate() resolves: result holds the estimate
    // snapshot with a real unique id, status is 'confirming' (NOT in flight).
    setMockWorkflow({
      status: 'confirming' as never,
      result: { workflowId: 'wf_estimate_unique_1', status: 'pending', cost: { total: 34 } } as never,
    });
    await userEvent.type(screen.getByLabelText('Prompt (optional)'), 'x'); // re-render → bridge re-runs

    // A second estimate with a DIFFERENT unique id (next showcase pick) — the
    // pre-fix bug minted a fresh card here precisely because the id was new.
    setMockWorkflow({
      status: 'confirming' as never,
      result: { workflowId: 'wf_estimate_unique_2', status: 'pending', cost: { total: 41 } } as never,
    });
    await userEvent.type(screen.getByLabelText('Prompt (optional)'), 'y');

    // Queue stays empty across both estimates — zero in-flight cards.
    await waitFor(() => {
      expect(screen.queryAllByLabelText('Generating')).toHaveLength(0);
    });
  });

  it('does NOT mint a 2nd card from a stale estimate result while a submitted job polls', async () => {
    // Repro of the post-submit/post-poll duplicate: after submit,
    // handleGenerate calls runEstimateNow(), which lands an estimate snapshot
    // (unique whatif id, status 'pending') in the hook's shared `result`. The
    // SDK poll loop then sets status='polling' BEFORE it overwrites `result`,
    // so there's a render where status='polling' but `result` is the stale
    // estimate — whose unique id no job owns. The bridge's create path used to
    // mint a phantom in-flight card for it (a 2nd "Generating" card appeared
    // after the first poll of every submit). The create path must only fire
    // for TERMINAL results.
    const spies = getMockSpies();
    spies.submit.mockResolvedValue({ workflowId: 'wf_real', status: 'pending' } as never);
    const pollGate = deferred<never>();
    spies.poll.mockImplementation(() => pollGate.promise); // own job stays in flight

    await renderApp(<App />);
    const generate = () =>
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ });
    await userEvent.click(generate());
    await waitFor(() => expect(spies.submit).toHaveBeenCalledTimes(1));
    // Exactly one in-flight card: the submitted job.
    await waitFor(() => expect(screen.getAllByLabelText('Generating')).toHaveLength(1));

    // Stale estimate snapshot lingering in `result` while status is 'polling'
    // (a unique id owned by no job, non-terminal).
    setMockWorkflow({
      status: 'polling' as never,
      result: { workflowId: 'wf_stale_estimate', status: 'pending' } as never,
    });
    await userEvent.type(screen.getByLabelText('Prompt (optional)'), 'x'); // re-render → bridge

    // Still exactly ONE in-flight card — no phantom from the stale estimate id.
    await waitFor(() => expect(screen.getAllByLabelText('Generating')).toHaveLength(1));
    pollGate.resolve({
      workflowId: 'wf_real',
      status: 'succeeded',
      imageUrls: ['https://example.test/done.jpg'],
    } as never);
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
    await userEvent.click(generate());
    await waitFor(() => {
      expect(screen.getByText(/orchestrator unavailable/)).toBeInTheDocument();
    });
    // The successful card is untouched.
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1);
  });
});
