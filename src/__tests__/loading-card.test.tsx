import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * Loading-state card sits at the front of the results carousel while a
 * generation is in flight (job status 'submitting' / 'pending' /
 * 'processing'). Visually it's a shimmer-animated rectangle in the selected
 * showcase's aspect ratio + a "Generating · {cost} ⚡" footer.
 *
 * The card is driven SOLELY by the real path: click Generate → handleGenerate
 * mints the job and starts its poll loop. A pending submit (or a pending poll)
 * keeps the card on screen. Estimating doesn't render the card — that state
 * means no workflow has been kicked off yet. Idle/done don't either; only the
 * in-flight window.
 */

vi.mock('@civitai/blocks-react', async () => {
  const { blocksReactMockFactory } = await import('../test/test-utils');
  return blocksReactMockFactory();
});

import { App } from '../App';
import {
  generate,
  getMockSpies,
  renderApp,
  resetBlocksReactMock,
  setMockWorkflow,
} from '../test/test-utils';
import { waitFor } from '@testing-library/react';

beforeEach(() => {
  resetBlocksReactMock();
});

describe('In-flight loading card (results carousel)', () => {
  it('renders a loading card with aria-busy while the submit is in flight', async () => {
    const spies = getMockSpies();
    const submitGate = new Promise<never>(() => {}); // never resolves
    spies.submit.mockImplementation(() => submitGate);

    await renderApp(<App />);
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );

    // The 'submitting' card lands synchronously when Generate is clicked
    // (before submit() resolves).
    await waitFor(() => {
      expect(screen.getByLabelText('Generating')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Generating')).toHaveAttribute('aria-busy');
  });

  it('renders a loading card while the per-job poll loop runs', async () => {
    // submit() returns a pending job; poll() never resolves → the card stays
    // 'processing' (in flight) for the duration of the test.
    await renderApp(<App />);
    await generate(
      { workflowId: 'wf_pending', status: 'pending' },
      { poll: 'pending' }
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Generating')).toBeInTheDocument();
    });
  });

  it('does NOT render the loading card when status=estimating', async () => {
    // Estimating is busy but no workflow exists yet — no card.
    setMockWorkflow({ status: 'estimating', result: null });
    await renderApp(<App />);
    expect(screen.queryByLabelText('Generating')).not.toBeInTheDocument();
  });

  it('does NOT render the loading card when status=idle and no prior results', async () => {
    setMockWorkflow({ status: 'idle', result: null });
    await renderApp(<App />);
    expect(screen.queryByTestId('gfm-results-carousel')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Generating')).not.toBeInTheDocument();
  });

  it('renders the card AT THE FRONT of the carousel (prepended to existing results)', async () => {
    await renderApp(<App />);
    // First Generate: a cached-hit succeeded card (terminal submit, no poll).
    await generate({
      workflowId: 'wf_done_1',
      status: 'succeeded',
      imageUrls: ['https://example.test/result.jpg'],
      cost: { total: 25 },
    });
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1)
    );

    // Second Generate: a new in-flight job (poll never resolves) prepends a
    // loading card ahead of the prior Download card.
    await generate(
      { workflowId: 'wf_pending', status: 'pending' },
      { poll: 'pending' }
    );

    // Both visible: 1 loading card + 1 prior Download button. The loading
    // card comes first in DOM order (newest first).
    await waitFor(() =>
      expect(screen.getByLabelText('Generating')).toBeInTheDocument()
    );
    const downloads = screen.getAllByRole('button', { name: 'Download' });
    expect(downloads).toHaveLength(1);

    // Loading card DOM-order check: aria-busy element precedes the
    // first Download button's containing card.
    const loading = screen.getByLabelText('Generating');
    const firstDownloadCard = downloads[0]!.closest('[style]');
    expect(
      loading.compareDocumentPosition(firstDownloadCard!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
