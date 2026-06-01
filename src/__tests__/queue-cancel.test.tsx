/**
 * v0.2.12 — status-labelled queue slots (Feature 1) + client-side cancel
 * (Feature 2).
 *
 * Feature 1: every queue slot now carries a visible STATUS badge
 *   (Queued / Generating… / Done / Failed / Canceled) so an in-flight job
 *   is no longer an anonymous shimmer.
 *
 * Feature 2: in-flight slots get a Cancel (X) control. As of v0.2.13 cancel
 *   is a REAL server-side cancel — it calls useBuzzWorkflow().cancel(workflowId),
 *   which round-trips through the host to blocks.cancelWorkflow and stops the
 *   workflow on the orchestrator (so it no longer keeps spending Buzz). The
 *   block ALSO stops its per-job poll loop and flips the slot to "Canceled"
 *   immediately, so the card clears regardless of the server round-trip. The
 *   poll loop must stop firing after cancel; cancel must still clear the card
 *   when the poll token is missing (remount edge) and when there's no
 *   workflowId yet (still submitting → client-side clear only, no server call).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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

const generate = () =>
  screen.getByRole('button', { name: /Generate Image|Re-generate Image/ });

beforeEach(() => {
  resetBlocksReactMock();
});

describe('Queue slots — status (Feature 1)', () => {
  it('an in-flight job renders a visible "Queued" status badge AND a cancel control', async () => {
    const spies = getMockSpies();
    spies.submit.mockResolvedValue({
      workflowId: 'wf_1',
      status: 'pending',
    } as never);
    // poll never resolves → the job stays in flight.
    const pollGate = deferred<never>();
    spies.poll.mockImplementation(() => pollGate.promise);

    await renderApp(<App />);
    await userEvent.click(generate());
    await waitFor(() => expect(spies.submit).toHaveBeenCalledTimes(1));

    // The slot reads its status (not an anonymous shimmer): a "Queued"
    // badge is visible (submitting/pending both read "Queued").
    await waitFor(() => {
      expect(screen.getByText('Queued')).toBeInTheDocument();
    });
    // …and the in-flight slot carries a Cancel affordance.
    expect(
      screen.getByRole('button', { name: 'Cancel generation' })
    ).toBeInTheDocument();
  });

  it('a completed job renders its "Done" status + the generated image', async () => {
    const spies = getMockSpies();
    spies.submit.mockResolvedValue({
      workflowId: 'wf_done',
      status: 'pending',
    } as never);
    spies.poll.mockResolvedValue({
      workflowId: 'wf_done',
      status: 'succeeded',
      imageUrls: ['https://example.test/done.jpg'],
      cost: { total: 34 },
    } as never);

    await renderApp(<App />);
    await userEvent.click(generate());

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: 'Download' })
      ).toBeInTheDocument();
    });
    // Status badge reads "Done" and the image rendered.
    expect(screen.getByText('Done')).toBeInTheDocument();
    const carousel = screen.getByTestId('gfm-results-carousel');
    const img = within(carousel).getByRole('img');
    expect(img).toHaveAttribute('src', 'https://example.test/done.jpg');
  });
});

describe('Cancel an in-flight job (Feature 2)', () => {
  it('clicking Cancel flips the slot to "Canceled" AND stops its poll loop', async () => {
    const spies = getMockSpies();
    spies.submit.mockResolvedValue({
      workflowId: 'wf_1',
      status: 'pending',
    } as never);
    // poll() never resolves; we count calls to prove the loop stops after
    // cancel (no further poll once the token is cancelled).
    const pollGate = deferred<never>();
    spies.poll.mockImplementation(() => pollGate.promise);

    await renderApp(<App />);
    await userEvent.click(generate());
    await waitFor(() => expect(spies.submit).toHaveBeenCalledTimes(1));
    // The leading-edge poll fires once.
    await waitFor(() => expect(spies.poll).toHaveBeenCalledTimes(1));

    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel generation' })
    );

    // Slot is now a terminal "Canceled" card — Queued badge gone, Canceled
    // badge present, cancel control replaced by a dismiss control.
    await waitFor(() => {
      expect(screen.getByText('Canceled')).toBeInTheDocument();
    });
    expect(screen.queryByText('Queued')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Cancel generation' })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Dismiss' })
    ).toBeInTheDocument();

    // The poll loop is stopped: even after waiting past a poll tick, poll()
    // is never called again (the token was cancelled before the next tick).
    const callsAtCancel = spies.poll.mock.calls.length;
    await new Promise((r) => setTimeout(r, 60));
    expect(spies.poll.mock.calls.length).toBe(callsAtCancel);

    // Real server-side cancel (v0.2.13): the SDK cancel() was invoked with the
    // job's workflowId so the orchestrator actually STOPS the run — not just
    // the local poll loop. (The host → blocks.cancelWorkflow → orchestrator
    // path is covered server-side; here we assert the block fires it.)
    expect(spies.cancel).toHaveBeenCalledWith('wf_1');
  });

  it('does NOT call server-side cancel for a job with no workflowId yet (still submitting)', async () => {
    const spies = getMockSpies();
    // submit() never resolves → the job stays 'submitting' with workflowId
    // null. Cancelling it must clear the card (client-side) but NOT call the
    // server cancel — there's no orchestrator workflow to stop yet.
    const submitGate = deferred<never>();
    spies.submit.mockImplementation(() => submitGate.promise);

    await renderApp(<App />);
    await userEvent.click(generate());
    // The card is enqueued immediately (submitting) with a Cancel control.
    const cancelBtn = await screen.findByRole('button', { name: 'Cancel generation' });
    await userEvent.click(cancelBtn);

    await waitFor(() => expect(screen.getByText('Canceled')).toBeInTheDocument());
    // No workflowId → no server-side cancel call.
    expect(spies.cancel).not.toHaveBeenCalled();
  });

  it('Dismiss removes a terminal (canceled) slot from the queue', async () => {
    const spies = getMockSpies();
    spies.submit.mockResolvedValue({
      workflowId: 'wf_1',
      status: 'pending',
    } as never);
    const pollGate = deferred<never>();
    spies.poll.mockImplementation(() => pollGate.promise);

    await renderApp(<App />);
    await userEvent.click(generate());
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Cancel generation' })
      ).toBeInTheDocument()
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Cancel generation' })
    );
    await waitFor(() => expect(screen.getByText('Canceled')).toBeInTheDocument());

    // Dismiss clears the card entirely — the queue empties.
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => {
      expect(screen.queryByText('Canceled')).not.toBeInTheDocument();
    });
    expect(screen.queryByTestId('gfm-results-carousel')).not.toBeInTheDocument();
  });

  it('cancel still works on an in-flight job with NO poll token (missing-token / remount edge)', async () => {
    // A job minted by the shared-state bridge (host/test surfaces an
    // in-flight workflow via useBuzzWorkflow's status/result, NOT via the
    // block's own submit) has `workflowId: null` and therefore NEVER calls
    // runJobPollLoop — so it has no entry in pollCancelRef. This is the
    // exact "token is missing" shape (also what a remount produces: the ref
    // is re-created and orphans the running loop's localId).
    //
    // Driving it: status 'polling' + a TERMINAL result is the bridge's
    // "stale snapshot, new workflow in flight" branch → it mints a
    // standalone in-flight card with workflowId null.
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_old', status: 'succeeded' } as never,
    });

    await renderApp(<App />);

    // The bridged in-flight slot shows its status + a cancel control, with
    // no poll token behind it.
    const cancel = await screen.findByRole('button', {
      name: 'Cancel generation',
    });

    // Cancel must not throw on the undefined token lookup and must still
    // flip the slot to Canceled (the status patch runs unconditionally).
    await userEvent.click(cancel);
    await waitFor(() => expect(screen.getByText('Canceled')).toBeInTheDocument());
    expect(
      screen.queryByRole('button', { name: 'Cancel generation' })
    ).not.toBeInTheDocument();
  });
});
