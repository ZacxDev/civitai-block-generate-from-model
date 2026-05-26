/**
 * Covers Tier-1 delta #4 — the "Remix from a preview image:" label is
 * removed. The carousel + the first thumbnail's highlighted border + the
 * prompt auto-populating IS the affordance; the label was condescending.
 *
 * Accessibility check: the carousel buttons keep their `aria-label`s and
 * `aria-pressed` toggles so screen reader users still understand the
 * picker semantics — losing the visual label doesn't mean losing the
 * machine-readable affordance.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { blocksReactMockFactory, renderApp, resetBlocksReactMock } from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { App } from '../App';

beforeEach(() => {
  resetBlocksReactMock();
});

describe('Showcase carousel — no remix label (delta #4)', () => {
  it('does not render "Remix from a preview image:" text', async () => {
    await renderApp(<App />);
    expect(screen.queryByText(/Remix from a preview image/i)).not.toBeInTheDocument();
  });

  it('still renders the carousel thumbnails with aria-label per item', async () => {
    await renderApp(<App />);
    expect(screen.getByRole('button', { name: 'Pick preview 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pick preview 2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pick preview 3' })).toBeInTheDocument();
  });

  it('thumbnails expose aria-pressed state (first selected by default)', async () => {
    await renderApp(<App />);
    const first = screen.getByRole('button', { name: 'Pick preview 1' });
    const second = screen.getByRole('button', { name: 'Pick preview 2' });
    expect(first).toHaveAttribute('aria-pressed', 'true');
    expect(second).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking a thumbnail toggles its aria-pressed state', async () => {
    await renderApp(<App />);
    const second = screen.getByRole('button', { name: 'Pick preview 2' });
    await userEvent.click(second);
    expect(second).toHaveAttribute('aria-pressed', 'true');
  });
});
