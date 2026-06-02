/**
 * Covers Tier-3 delta #3 — the inline `⚙ Advanced (read-only)` toggle
 * below the prompt is replaced by a ⋯ icon button in the header's
 * top-right corner. Clicking toggles the Advanced section.
 *
 * Accessibility:
 *   - aria-label="Advanced settings"
 *   - aria-expanded reflects state
 *   - aria-controls="block-advanced" points at the section
 *   - disabled when isBusy
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { waitFor } from '@testing-library/react';

import {
  blocksReactMockFactory,
  generate,
  renderApp,
  resetBlocksReactMock,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { App } from '../App';

beforeEach(() => {
  resetBlocksReactMock();
});

describe('Three-dots Advanced toggle (Tier-3 #3)', () => {
  it('renders the three-dots button in the header with the correct ARIA attributes', async () => {
    await renderApp(<App />);
    const dots = screen.getByRole('button', { name: 'Advanced settings' });
    expect(dots).toBeInTheDocument();
    expect(dots).toHaveAttribute('aria-expanded', 'false');
    expect(dots).toHaveAttribute('aria-controls', 'block-advanced');
  });

  it('clicking the three-dots toggles aria-expanded to true and reveals the AdvancedSection', async () => {
    await renderApp(<App />);
    const dots = screen.getByRole('button', { name: 'Advanced settings' });
    expect(dots).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(dots);
    expect(dots).toHaveAttribute('aria-expanded', 'true');

    // The Advanced section's wrapper carries id="block-advanced" and is
    // aria-hidden when collapsed. Opening flips both.
    const section = document.getElementById('block-advanced');
    expect(section).not.toBeNull();
    expect(section).toHaveAttribute('aria-hidden', 'false');
  });

  it('pressing the three-dots a second time re-collapses', async () => {
    await renderApp(<App />);
    const dots = screen.getByRole('button', { name: 'Advanced settings' });

    await userEvent.click(dots);
    expect(dots).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(dots);
    expect(dots).toHaveAttribute('aria-expanded', 'false');

    const section = document.getElementById('block-advanced');
    expect(section).toHaveAttribute('aria-hidden', 'true');
  });

  it('keeps the three-dots enabled while a generation is in flight (task 2)', async () => {
    // Task 2: nothing on the form disables during generation anymore —
    // the user can open Advanced and tweak params for the next queued
    // submit while earlier jobs are still polling. Drive a real in-flight
    // job (submit pending, poll never resolves).
    await renderApp(<App />);
    await generate(
      { workflowId: 'wf_1', status: 'pending' },
      { poll: 'pending' }
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Generating')).toBeInTheDocument()
    );
    const dots = screen.getByRole('button', { name: 'Advanced settings' });
    expect(dots).not.toBeDisabled();
  });

  it('does NOT render the old inline "⚙ Advanced" toggle row below the prompt', async () => {
    await renderApp(<App />);
    // Old shape was an inline button with `aria-expanded` and gear emoji
    // copy. The three-dots button is now the only toggle; no inline
    // gear-labeled toggle should exist.
    const inlineGear = screen.queryByText(/⚙/);
    expect(inlineGear).not.toBeInTheDocument();
  });

  it('keyboard activation (Enter) on the three-dots opens the section', async () => {
    await renderApp(<App />);
    const dots = screen.getByRole('button', { name: 'Advanced settings' });
    dots.focus();
    expect(dots).toHaveFocus();
    // Enter is the standard activation for native <button>; userEvent
    // dispatches the click event for us.
    await userEvent.keyboard('{Enter}');
    expect(dots).toHaveAttribute('aria-expanded', 'true');
  });
});
