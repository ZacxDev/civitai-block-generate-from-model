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
  generate,
  getMockSpies,
  renderApp,
  resetBlocksReactMock,
} from '../test/test-utils';
import userEvent from '@testing-library/user-event';

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
    // 🔴 The raw error text must NOT reach the screen. This asserted
    // `getByText(/network down/)` until the blocks-react 0.44 bump, which is
    // the shape that let an SDK-internal developer string ship to viewers.
    expect(screen.queryByText(/network down/)).toBeNull();
  });

  it('surfaces a THROWN estimate failure without rendering the server\'s text', async () => {
    // 🔴 THIS TEST USED TO ENCODE THE OPPOSITE CONTRACT, and stayed green
    // through a bump that inverted it. Up to blocks-react 0.5.x a delivered
    // host failure RESOLVED estimate() with `status:'failed'` and the block
    // rendered `snapshot.error`. From 0.44.x it THROWS WorkflowEstimateError.
    // Because the fixture kept RESOLVING, the suite went on passing while
    // production started rendering the SDK's developer-facing summary
    // ("estimate did not return a usable price (failed) — reason on
    // .snapshot.error") to viewers. The fixture now throws what the real SDK
    // throws, so the fake can no longer be wrong in the same direction as the
    // code.
    const { getMockSpies } = await import('../test/test-utils');
    const { WorkflowEstimateError } = await import('@civitai/blocks-react');
    getMockSpies().estimate.mockReset();
    getMockSpies().estimate.mockRejectedValue(
      new WorkflowEstimateError(
        {
          workflowId: 'failed',
          status: 'failed',
          error: 'orchestrator unavailable',
        } as never,
        'failed'
      )
    );
    await renderApp(<App />);
    await waitFor(() => {
      expect(screen.getByText(/Couldn't estimate cost/)).toBeInTheDocument();
    });
    // The server's unsanitised text stays in the console, never on screen.
    expect(screen.queryByText(/orchestrator unavailable/)).toBeNull();
    // CTA still renders an actionable fallback (≤ budget), not a numeric cost.
    const btn = screen.getByRole('button', { name: /Generate Image/ });
    expect(btn.textContent ?? '').toMatch(/Generate Image \(≤ \d+/);
  });

  it('the estimate error line reads as ONE sentence, not a doubled prefix', async () => {
    // 🔴 The line renders "Couldn't estimate cost: {estimateError}", so the
    // stored string must be a REASON. Storing "Couldn't estimate cost." there
    // produced "Couldn't estimate cost: Couldn't estimate cost." — and the
    // other assertions could not see it, because they match the PREFIX, which
    // is satisfied either way. Pin the whole normalised sentence.
    const { getMockSpies } = await import('../test/test-utils');
    getMockSpies().estimate.mockReset();
    getMockSpies().estimate.mockRejectedValue(new Error('network down'));
    await renderApp(<App />);
    const line = await screen.findByText(/Couldn't estimate cost:/);
    expect((line.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe(
      "Couldn't estimate cost: the estimate service is unavailable — try again in a moment."
    );
  });

  it("the no-cost code gets its OWN sentence, not the generic one", async () => {
    // Two codes, two meanings: 'failed' is the service refusing, 'no-cost' is a
    // reply with no price. Collapsing them loses the only actionable half.
    const { getMockSpies } = await import('../test/test-utils');
    const { WorkflowEstimateError } = await import('@civitai/blocks-react');
    getMockSpies().estimate.mockReset();
    getMockSpies().estimate.mockRejectedValue(
      new WorkflowEstimateError({ workflowId: 'w', status: 'succeeded' } as never, 'no-cost')
    );
    await renderApp(<App />);
    const line = await screen.findByText(/Couldn't estimate cost:/);
    expect((line.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe(
      "Couldn't estimate cost: no price came back for these settings."
    );
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

describe('In-flight progress lives on the carousel card, not the CTA (queue model)', () => {
  it('the CTA stays a Generate action while a job is in flight; the carousel LoadingCard shows "Generating · {cost}"', async () => {
    // Task 2 + 3: the Generate button no longer takes over with a
    // "Generating · N" label during a generation (that would imply the
    // form is blocked). The button stays "Generate/Re-generate Image · N"
    // and clickable so the user can queue more; the per-job progress +
    // sticky cost moves onto the carousel's shimmer LoadingCard.
    await renderApp(<App />);
    // Default estimate resolves cost 34 → estimatedCost=34 at click. submit()
    // returns pending; poll() advances to 'processing' (in flight, non-terminal).
    await generate(
      { workflowId: 'wf_1', status: 'pending' },
      { poll: { workflowId: 'wf_1', status: 'processing' } }
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Generating')).toBeInTheDocument();
    });

    // The CTA is still the actionable Generate/Re-generate button (with cost).
    expect(
      screen.getByRole('button', { name: /(Generate|Re-generate) Image · \d+/ })
    ).toBeInTheDocument();
    // The "Generating · N" sticky-cost copy is on the LoadingCard.
    const loading = screen.getByLabelText('Generating');
    expect(loading.textContent ?? '').toMatch(/Generating · \d+/);
    // And there's exactly one "Generating · N" node (no duplicate on the
    // button + no standalone paragraph).
    const generatingNodes = screen.getAllByText(/Generating/);
    // Exactly one card carries the "Generating · N" sticky cost.
    expect(generatingNodes.some((n) => /Generating · \d+/.test(n.textContent ?? ''))).toBe(true);
  });

  it('shows the pulse element on the carousel LoadingCard when a job is in flight', async () => {
    // submit() hangs so the 'submitting' card stays on screen.
    const spies = getMockSpies();
    spies.submit.mockImplementation(() => new Promise<never>(() => {}));
    await renderApp(<App />);
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Generating')).toBeInTheDocument();
    });
    const loading = screen.getByLabelText('Generating');
    const pulses = loading.querySelectorAll('span[aria-hidden="true"]');
    expect(pulses.length).toBeGreaterThan(0);
    const pulse = pulses[0] as HTMLElement;
    expect(pulse.style.animation).toContain('gfm-pulse');
  });

  it('does NOT show a "Queued…" status line ON THE CTA when a job is queued', async () => {
    // Tier-1 #2 is specifically about the GENERATE BUTTON: it must not get
    // taken over by a polling-status line. The "Queued" badge lives on the
    // QUEUE SLOT (Feature 1 — status-labelled slots) on the carousel card,
    // NOT the CTA. So scope the assertion to the button.
    const spies = getMockSpies();
    spies.submit.mockResolvedValue({ workflowId: 'wf_1', status: 'pending' } as never);
    spies.poll.mockImplementation(() => new Promise<never>(() => {})); // stay queued
    await renderApp(<App />);
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Generating')).toBeInTheDocument();
    });
    const cta = screen.getByRole('button', {
      name: /Generate Image|Re-generate Image/,
    });
    expect(cta.textContent ?? '').not.toMatch(/Queued/);
  });
});
