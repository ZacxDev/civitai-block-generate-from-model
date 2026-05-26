/**
 * Covers Tier-1 deltas #1 and #2 — cost surfaced inside the Generate
 * button (no standalone cost line) and the polling status line removed.
 *
 *   #1: "Estimated cost: N Buzz (budget: M)" line is gone; the button
 *        text is the single source of truth — `Generate · 34 Buzz`.
 *   #2: While polling, the button label flips to "Generating…" with a
 *        pulse — there is no separate "<p>Queued…</p>" line.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

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

describe('Cost inside the Generate button (delta #1)', () => {
  it('renders "Generate · {N} Buzz" once estimate lands', async () => {
    await renderApp(<App />);
    // The default mock estimate resolves to cost.total = 34.
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /Generate/ });
      expect(btn).toHaveTextContent(/Generate · 34 Buzz/);
    });
  });

  it('does NOT render a standalone "Estimated cost" / "budget:" line', async () => {
    await renderApp(<App />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generate · 34 Buzz/ })).toBeInTheDocument();
    });
    // The old paragraph form lived OUTSIDE the button and read like
    // "Estimated cost: 34 Buzz (budget: 50)". It is gone.
    expect(screen.queryByText(/Estimated cost:/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/budget:/i)).not.toBeInTheDocument();
  });

  it('falls back to "Generate (≤ {budget} Buzz)" when no cost lands yet', async () => {
    // Configure the workflow mock to reject every estimate call so
    // estimatedCost stays null — the button must still render an
    // actionable label.
    const { getMockSpies } = await import('../test/test-utils');
    getMockSpies().estimate.mockReset();
    getMockSpies().estimate.mockRejectedValue(new Error('boom'));
    await renderApp(<App />);
    await waitFor(() => {
      // No exact cost → fall back to budget cap.
      const btn = screen.getByRole('button', { name: /Generate/ });
      expect(btn.textContent ?? '').toMatch(/Generate \(.+ Buzz\)/);
    });
  });

  it('surfaces estimate errors as a small subtle line below the button', async () => {
    const { getMockSpies } = await import('../test/test-utils');
    getMockSpies().estimate.mockReset();
    getMockSpies().estimate.mockRejectedValue(new Error('network down'));
    await renderApp(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't estimate cost/)).toBeInTheDocument();
    });
    expect(screen.getByText(/network down/)).toBeInTheDocument();
  });
});

describe('No standalone polling status line (delta #2)', () => {
  it('shows "Generating…" inside the button and NO separate paragraph', async () => {
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_1', status: 'processing' } as never,
    });
    await renderApp(<App />);
    // Button picks up the busy label.
    const btn = screen.getByRole('button', { name: /Generating…/ });
    expect(btn).toBeInTheDocument();
    // There is no <p>Queued…</p> / <p>Generating…</p> sibling. To verify,
    // make sure the ONLY node containing "Generating…" is inside the button.
    const generatingNodes = screen.getAllByText(/Generating…/);
    expect(generatingNodes).toHaveLength(1);
    expect(btn.contains(generatingNodes[0]!)).toBe(true);
  });

  it('shows "Generating…" with the pulse element on the button when polling', async () => {
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_1', status: 'pending' } as never,
    });
    await renderApp(<App />);
    const btn = screen.getByRole('button', { name: /Generating…/ });
    // The Pulse renders as an aria-hidden <span> with the gfm-pulse
    // animation. Locate it by attribute — it's the busy-state visual.
    const pulses = btn.querySelectorAll('span[aria-hidden="true"]');
    expect(pulses.length).toBeGreaterThan(0);
    // Confirm it's the animated pulse (style.animation includes gfm-pulse).
    const pulse = pulses[0] as HTMLElement;
    expect(pulse.style.animation).toContain('gfm-pulse');
  });

  it('does NOT show "Queued…" anywhere even when result.status is pending', async () => {
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_1', status: 'pending' } as never,
    });
    await renderApp(<App />);
    expect(screen.queryByText(/Queued/)).not.toBeInTheDocument();
  });
});
