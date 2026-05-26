/**
 * Covers Tier-1 delta #3 — checkpoint picker relocated into the Advanced
 * section. 90% of users don't know what a checkpoint is and shouldn't see
 * the row by default. Power users still need access; clicking "Advanced"
 * surfaces it.
 *
 * Gating logic preserved:
 *   - LoRA installs: row hidden when Advanced closed, visible when open.
 *   - Checkpoint installs: row NEVER renders (the model is the anchor).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  blocksReactMockFactory,
  getMockSpies,
  renderApp,
  resetBlocksReactMock,
  setMockContext,
  DEFAULT_CHECKPOINT,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { App } from '../App';

beforeEach(() => {
  resetBlocksReactMock();
});

/**
 * Helper: the "Generating with:" row lives inside the Advanced collapse
 * wrapper, which sets `aria-hidden=true` and `max-height: 0` when closed.
 * Testing-library queries by text don't respect aria-hidden, so we walk
 * up the DOM to confirm the matching node is visually accessible (not
 * inside any aria-hidden ancestor).
 */
function isVisuallyShown(el: Element | null): boolean {
  if (!el) return false;
  let cur: Element | null = el;
  while (cur && cur !== document.body) {
    if (cur.getAttribute('aria-hidden') === 'true') return false;
    cur = cur.parentElement;
  }
  return true;
}

describe('Checkpoint picker inside Advanced (delta #3)', () => {
  it('hides the "Generating with:" row when Advanced is closed (LoRA install)', async () => {
    setMockContext({ modelType: 'LORA', checkpoint: DEFAULT_CHECKPOINT });
    await renderApp(<App />);
    // The toggle is collapsed by default — aria-expanded reads "false".
    // Tier-3 #3: the Advanced toggle is now the three-dots icon button
    // in the header, identified by aria-label="Advanced settings".
    expect(screen.getByRole('button', { name: /Advanced settings/i })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
    // The row is rendered in the DOM for the collapse animation, but its
    // ancestor wrapper sets aria-hidden=true so AT users + sighted users
    // both see it as hidden.
    const row = screen.queryByText(/Generating with:/);
    expect(isVisuallyShown(row)).toBe(false);
  });

  it('shows the "Generating with:" row when Advanced is opened (LoRA install)', async () => {
    setMockContext({ modelType: 'LORA', checkpoint: DEFAULT_CHECKPOINT });
    await renderApp(<App />);
    const toggle = screen.getByRole('button', { name: /Advanced settings/i });
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const row = screen.getByText(/Generating with:/);
    expect(isVisuallyShown(row)).toBe(true);
    // Checkpoint name and version chip both surface inside the row — the
    // <strong> wraps the modelName and the version suffix.
    expect(screen.getByText(/Flux Cinematic/)).toBeInTheDocument();
  });

  it('does NOT render the "Generating with:" row for Checkpoint installs even when Advanced is open', async () => {
    setMockContext({ modelType: 'Checkpoint', checkpoint: DEFAULT_CHECKPOINT });
    await renderApp(<App />);
    const toggle = screen.getByRole('button', { name: /Advanced settings/i });
    await userEvent.click(toggle);
    // For Checkpoint-bound installs the picker block is suppressed
    // entirely (not just hidden) — no "Change" button rendered, no row.
    expect(screen.queryByText(/Generating with:/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Change/ })).not.toBeInTheDocument();
  });

  it('fires checkpointPicker.open when "Change" is clicked from inside Advanced', async () => {
    setMockContext({ modelType: 'LORA', checkpoint: DEFAULT_CHECKPOINT });
    await renderApp(<App />);
    await userEvent.click(screen.getByRole('button', { name: /Advanced settings/i }));
    await userEvent.click(screen.getByRole('button', { name: /Change/ }));
    expect(getMockSpies().checkpointOpen).toHaveBeenCalledTimes(1);
    // Sanity-check the args shape — baseModelGroup should be the
    // checkpoint's baseModel (or modelType as a fallback).
    expect(getMockSpies().checkpointOpen).toHaveBeenCalledWith(
      expect.objectContaining({ baseModelGroup: 'Flux.1 D' })
    );
  });
});
