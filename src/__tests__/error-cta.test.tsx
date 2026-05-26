/**
 * Covers Tier-2 delta #10 — compact error box with a prominent Top-Up
 * CTA for the insufficient-buzz case.
 *
 *   Insufficient buzz  → quiet error copy, big primary "Top up Buzz · N"
 *                        button using the same primaryButtonStyle as Generate
 *   Any other error    → unchanged: error text inside the alert box, no CTA
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  blocksReactMockFactory,
  getMockSpies,
  renderApp,
  resetBlocksReactMock,
  setMockSettings,
  setMockWorkflow,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { App } from '../App';

beforeEach(() => {
  resetBlocksReactMock();
});

describe('Insufficient-buzz error → prominent Top-Up CTA (delta #10)', () => {
  it('renders the Top-Up button as the primary action when the error mentions insufficient buzz', async () => {
    setMockSettings({ buzz_budget_per_gen: 50 });
    setMockWorkflow({
      status: 'idle',
      error: new Error('insufficient buzz balance'),
    });
    await renderApp(<App />);

    // The CTA labels itself with the suggested top-up amount (budget × 10).
    const topUp = screen.getByRole('button', { name: /Top up Buzz · 500/ });
    expect(topUp).toBeInTheDocument();
    // Visual weight: uses the same primary button class as Generate. The
    // class is the load-bearing assertion (it pulls in the hover/active
    // CSS); style.background also fixes the brand color.
    // Tier-3 #5: CTA base color is now Mantine blue[6] (#228BE6) — the
    // brighter shade that "pops" against the surface.
    expect(topUp).toHaveClass('gfm-primary');
    expect(topUp.style.background.toLowerCase()).toMatch(/#228be6|rgb\(34, 139, 230\)/);
  });

  it('demotes the error message to supporting copy in the insufficient case', async () => {
    setMockWorkflow({
      status: 'idle',
      error: new Error('not enough buzz to run this'),
    });
    await renderApp(<App />);
    // Old framing surfaced the raw error message inside an alert. New
    // framing replaces it with a short, calmer line + the CTA.
    expect(screen.getByText('Not enough Buzz for this generation.')).toBeInTheDocument();
    // The raw 'not enough buzz to run this' substring should NOT leak —
    // the reframing intentionally hides the orchestrator's verbatim
    // language in favor of a user-facing one-liner.
    expect(screen.queryByText('not enough buzz to run this')).not.toBeInTheDocument();
  });

  it('does NOT render the Top-Up button for non-insufficient errors', async () => {
    setMockWorkflow({
      status: 'idle',
      error: new Error('orchestrator timeout'),
    });
    await renderApp(<App />);
    // Plain error text in the alert box, no Top-Up CTA, no reframed copy.
    expect(screen.getByText('orchestrator timeout')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Top up Buzz/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Not enough Buzz for this generation.')).not.toBeInTheDocument();
  });

  it('clicking Top-Up calls openPurchaseModal with budget * 10', async () => {
    setMockSettings({ buzz_budget_per_gen: 25 });
    setMockWorkflow({
      status: 'idle',
      error: new Error('insufficient funds'),
    });
    await renderApp(<App />);
    const spies = getMockSpies();
    spies.openPurchaseModal.mockClear();

    await userEvent.click(screen.getByRole('button', { name: /Top up Buzz · 250/ }));

    expect(spies.openPurchaseModal).toHaveBeenCalledTimes(1);
    expect(spies.openPurchaseModal).toHaveBeenCalledWith(250);
  });

  it('also triggers the insufficient path when the workflow result.status is failed with budget language', async () => {
    setMockSettings({ buzz_budget_per_gen: 10 });
    setMockWorkflow({
      status: 'idle',
      result: {
        workflowId: 'wf_fail',
        status: 'failed',
        error: 'over budget; not enough buzz',
      } as never,
    });
    await renderApp(<App />);
    expect(screen.getByRole('button', { name: /Top up Buzz · 100/ })).toBeInTheDocument();
  });
});
