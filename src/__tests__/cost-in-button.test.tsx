/**
 * Covers Tier-1 deltas #1 and #2 — cost surfaced inside the Generate
 * button (no standalone cost line) and the polling status line removed.
 *
 *   #1: "Estimated cost: N Buzz (budget: M)" line is gone; the button
 *        text is the single source of truth — `Generate Image · 34`.
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
      expect(btn).toHaveTextContent(/Generate Image · 34/);
    });
  });

  it('does NOT render a standalone "Estimated cost" / "budget:" line', async () => {
    await renderApp(<App />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generate Image · 34/ })).toBeInTheDocument();
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
      // No exact cost → fall back to budget cap. "Buzz" word is now
      // the trailing BoltIcon SVG, not text, so just match the
      // verb-phrase + parenthesized number.
      const btn = screen.getByRole('button', { name: /Generate Image/ });
      expect(btn.textContent ?? '').toMatch(/Generate Image \(≤ \d+/);
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

  it('renders the Buzz bolt SVG icon inside the Generate button (Tier-4 Delta C)', async () => {
    await renderApp(<App />);
    // The bolt visually ties the action to the Buzz currency. JSDOM
    // can't verify colors but the SVG + the path data are stable.
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /Generate Image · 34/ });
      const svg = btn.querySelector('svg');
      expect(svg).not.toBeNull();
      const path = svg!.querySelector('path');
      // Tabler Bolt path — a refactor that swaps this icon (e.g. download)
      // would change the d attribute, which this catches.
      expect(path?.getAttribute('d')).toContain('M13 3L4 14');
    });
  });

  it('Generate button has the gfm-primary class so it picks up the amber CTA stylesheet rules', async () => {
    await renderApp(<App />);
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /Generate Image · 34/ });
      expect(btn).toHaveClass('gfm-primary');
      // Inline style base color — the amber (Mantine yellow[6]).
      expect(btn.style.background.toLowerCase()).toMatch(/#fab005|rgb\(250, 176, 5\)/);
    });
  });
});

describe('No standalone polling status line (delta #2)', () => {
  it('shows "Generating · {cost} Buzz" inside the button and NO separate paragraph', async () => {
    // Tier-2 #8 update: the polling label now keeps the cost visible
    // (was just "Generating…"). The "no standalone paragraph" assertion
    // still holds — the button is the single source of truth.
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_1', status: 'processing' } as never,
    });
    await renderApp(<App />);
    // Button picks up the busy label with the sticky cost.
    const btn = screen.getByRole('button', { name: /Generating · \d+/ });
    expect(btn).toBeInTheDocument();
    expect(btn.textContent ?? '').toMatch(/Generating · \d+/);
    // There is no <p>Queued…</p> / <p>Generating…</p> sibling. To verify,
    // make sure the ONLY node containing the "Generating · N Buzz" form
    // is inside the button. (Note: "Generating with:" in the Advanced
    // section is unrelated copy and uses a different shape.)
    const generatingNodes = screen.getAllByText(/Generating · \d+/);
    expect(generatingNodes).toHaveLength(1);
    expect(btn.contains(generatingNodes[0]!)).toBe(true);
  });

  it('shows the pulse element on the button when polling', async () => {
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_1', status: 'pending' } as never,
    });
    await renderApp(<App />);
    const btn = screen.getByRole('button', { name: /Generating/ });
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
