/**
 * Covers the in-block full-size image viewer (lightbox).
 *
 * The iframe sandbox is `allow-scripts allow-forms` (no popups) and the
 * SDK has no host "open image" message, so clicking a result image opens
 * an in-frame overlay rather than a new tab / host viewer. The overlay:
 *   - shows the same image full size,
 *   - closes on backdrop click,
 *   - closes on Escape,
 *   - does NOT close when the image itself is clicked (click-trap).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  blocksReactMockFactory,
  renderApp,
  resetBlocksReactMock,
  setMockWorkflow,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { App } from '../App';

beforeEach(() => {
  resetBlocksReactMock();
});

const SUCCEEDED_RESULT = {
  workflowId: 'wf_done',
  status: 'succeeded' as const,
  imageUrls: ['https://example.test/result.jpg'],
  cost: { total: 34 },
};

describe('Full-size image viewer (lightbox)', () => {
  it('has no dialog until a result image is clicked', async () => {
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the viewer with the full-size image when the result image is clicked', async () => {
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);

    await userEvent.click(
      screen.getByRole('button', { name: /View generation 1 full size/i })
    );

    const dialog = screen.getByRole('dialog', { name: /full size image/i });
    expect(dialog).toBeInTheDocument();
    const full = screen.getByAltText('Generated image, full size') as HTMLImageElement;
    expect(full.src).toBe('https://example.test/result.jpg');
  });

  it('closes the viewer when the backdrop is clicked', async () => {
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);

    await userEvent.click(
      screen.getByRole('button', { name: /View generation 1 full size/i })
    );
    await userEvent.click(screen.getByRole('dialog', { name: /full size image/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the viewer on the explicit close button', async () => {
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);

    await userEvent.click(
      screen.getByRole('button', { name: /View generation 1 full size/i })
    );
    await userEvent.click(screen.getByRole('button', { name: /Close image viewer/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes the viewer when Escape is pressed', async () => {
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);

    await userEvent.click(
      screen.getByRole('button', { name: /View generation 1 full size/i })
    );
    expect(screen.getByRole('dialog', { name: /full size image/i })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('does NOT close when the full-size image itself is clicked', async () => {
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);

    await userEvent.click(
      screen.getByRole('button', { name: /View generation 1 full size/i })
    );
    await userEvent.click(screen.getByAltText('Generated image, full size'));
    expect(screen.getByRole('dialog', { name: /full size image/i })).toBeInTheDocument();
  });
});
