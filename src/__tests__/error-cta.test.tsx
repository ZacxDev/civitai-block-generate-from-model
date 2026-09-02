/**
 * Covers Tier-2 delta #10 — compact error box with a prominent Top-Up
 * CTA for the insufficient-buzz case.
 *
 *   Insufficient buzz  → quiet error copy, big primary "Top up · N"
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
    const topUp = screen.getByRole('button', { name: /Top up · 500/ });
    expect(topUp).toBeInTheDocument();
    // Visual weight: uses the same primary button class as Generate. The
    // class is the load-bearing assertion (it pulls in the hover/active
    // CSS); style.background also fixes the brand color.
    // Tier-4 Delta C: CTA base color is now Mantine yellow[6] (#FAB005) —
    // the Buzz-spend amber so the top-up reads as a currency action and
    // doesn't compete with the host page's brand-blue Create button.
    expect(topUp).toHaveClass('gfm-primary');
    expect(topUp.style.background.toLowerCase()).toMatch(/#fab005|rgb\(250, 176, 5\)/);
  });

  it('renders the Buzz bolt SVG icon inside the Top-Up button (Tier-4 Delta C)', async () => {
    setMockSettings({ buzz_budget_per_gen: 50 });
    setMockWorkflow({
      status: 'idle',
      error: new Error('insufficient buzz balance'),
    });
    await renderApp(<App />);

    // The bolt anchors the Top-Up CTA visually to the Buzz currency. JSDOM
    // doesn't render colors, but the SVG element + the role assertion are
    // enough to verify the icon is present.
    const topUp = screen.getByRole('button', { name: /Top up · 500/ });
    const svg = topUp.querySelector('svg');
    expect(svg).not.toBeNull();
    // Sanity: the path data matches the canonical Tabler Bolt shape so a
    // regression that swaps the icon (e.g. download) gets caught.
    const path = svg!.querySelector('path');
    expect(path?.getAttribute('d')).toContain('M13 3L4 14');
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
    // 🔴 The RAW error must not reach the alert box. This asserted
    // `getByText('orchestrator timeout')` — i.e. it pinned the leak. Both
    // sources behind that line are developer/server text: the hook's message is
    // the SDK's own summary, and `result.error` is server-authored and
    // unsanitised (documented as carrying raw Prisma/pg column names).
    expect(screen.queryByText('orchestrator timeout')).toBeNull();
    expect(screen.getByText('Generation failed.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Top up Buzz/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Not enough Buzz for this generation.')).not.toBeInTheDocument();
  });

  it('a RESOLVED budget refusal still reaches the top-up CTA, without showing the server text', async () => {
    // 🔴 THE AFFORDABILITY PATH RESOLVES, it does not throw (blocks-react
    // useBuzzWorkflow). So the server's wording arrives on `result.error`, and
    // the sniff must read that source FIRST — the hook's `error` is set by any
    // earlier throw and never cleared, which is what shadowed this.
    setMockWorkflow({
      // The HOOK's status is `error`; the SNAPSHOT it carries is the thing with
      // `status: 'failed'`. They are different enums and mixing them silently
      // typechecks nowhere useful.
      status: 'error',
      result: { workflowId: 'wf', status: 'failed', error: 'insufficient balance' } as never,
      error: new Error('estimate did not return a usable price (failed)'),
    });
    await renderApp(<App />);
    expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument();
    // ...and the raw server sentence is not on screen.
    expect(screen.queryByText(/insufficient balance/)).toBeNull();
  });

  it('does not LATCH: a later success clears the top-up CTA and Generate returns', async () => {
    // 🔴 REGRESSION GUARD. An earlier fix held the failure text in state and
    // never cleared it, so ONE budget-worded failure pinned the CTA to "Top up"
    // permanently — measured: after a successful re-estimate the block had NO
    // Generate button at all. The sniff must be derived from current state, not
    // remembered.
    setMockWorkflow({
      status: 'error',
      result: { workflowId: 'wf', status: 'failed', error: 'insufficient balance' } as never,
    });
    const { rerender } = await renderApp(<App />);
    expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument();

    // The user tops up; the next call succeeds.
    setMockWorkflow({ status: 'idle', result: null, error: null });
    rerender(<App />);
    expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
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

    await userEvent.click(screen.getByRole('button', { name: /Top up · 250/ }));

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
    expect(screen.getByRole('button', { name: /Top up · 100/ })).toBeInTheDocument();
  });
});
