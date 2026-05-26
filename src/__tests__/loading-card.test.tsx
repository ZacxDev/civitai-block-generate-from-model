import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

/**
 * Loading-state card sits at the front of the results carousel while a
 * generation is in flight (status='submitting' or 'polling'). Visually
 * it's a shimmer-animated rectangle in the selected showcase's aspect
 * ratio + a "Generating · {cost} ⚡" footer.
 *
 * Estimating doesn't render the card — that state means no workflow
 * has been kicked off yet. Idle/done don't either; only the in-flight
 * window.
 */

vi.mock('@civitai/blocks-react', async () => {
  const { blocksReactMockFactory } = await import('../test/test-utils');
  return blocksReactMockFactory();
});

import { App } from '../App';
import { renderApp, resetBlocksReactMock, setMockWorkflow } from '../test/test-utils';

beforeEach(() => {
  resetBlocksReactMock();
});

describe('In-flight loading card (results carousel)', () => {
  it('renders a loading card with aria-busy when status=submitting', async () => {
    setMockWorkflow({
      status: 'submitting',
      result: { workflowId: 'wf_pending', status: 'pending' } as never,
    });
    await renderApp(<App />);
    expect(screen.getByLabelText('Generating')).toBeInTheDocument();
    expect(screen.getByLabelText('Generating')).toHaveAttribute('aria-busy');
  });

  it('renders a loading card when status=polling', async () => {
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_pending', status: 'processing' } as never,
    });
    await renderApp(<App />);
    expect(screen.getByLabelText('Generating')).toBeInTheDocument();
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
    // Inject a prior succeeded result, then start a new submission.
    const PRIOR = {
      workflowId: 'wf_done_1',
      status: 'succeeded' as const,
      imageUrls: ['https://example.test/result.jpg'],
      cost: { total: 25 },
    };
    setMockWorkflow({ status: 'idle', result: PRIOR as never });
    const { rerender } = await renderApp(<App />);

    setMockWorkflow({ status: 'polling', result: PRIOR as never });
    const { act } = await import('react');
    await act(async () => {
      rerender(<App />);
      await Promise.resolve();
    });

    // Both visible: 1 loading card + 1 prior Download button. The loading
    // card comes first in DOM order (newest first).
    expect(screen.getByLabelText('Generating')).toBeInTheDocument();
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
