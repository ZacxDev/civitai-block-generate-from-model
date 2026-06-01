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
