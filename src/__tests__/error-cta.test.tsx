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
  setMockBuzzBalance,
  setMockSettings,
  setMockWorkflow,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { WorkflowEstimateError } from '@civitai/blocks-react';

import { App } from '../App';

/** A viewer with nothing to spend — every pool at zero. */
const BROKE = { blue: 0, green: 0, yellow: 0 };

/**
 * A priced refusal. 42 is deliberately UNDER `DEFAULT_TOKEN.buzzBudget` (50):
 * a price ABOVE the token's own per-call ceiling was refused by the host's
 * budget gate, not by the wallet, and the predicate excludes it on purpose.
 */
const REFUSAL = {
  workflowId: 'wf',
  status: 'failed',
  error: 'spend cap exceeded',
  cost: { total: 42 },
};

/**
 * Make the mount-time auto-estimate REFUSE with `snap`.
 *
 * 🔴 REQUIRED, not decoration. The mock publishes an estimate's snapshot onto
 * the hook's shared `result` exactly as blocks-react does (`useBuzzWorkflow.js`
 * — `setResult(snapshot)` runs BEFORE the rejection). So a test that only sets
 * `result` statically describes a state the App leaves immediately: the
 * auto-estimate resolves on mount and overwrites it with its own
 * `{status:'pending'}` reply, and the money CTA vanishes. Refusing the estimate
 * is how this screen is reached for real — and it is the same publish-then-
 * reject join the first-paint CTA defect lives on.
 */
const refuseEstimateWith = (snap: Record<string, unknown>) => {
  getMockSpies().estimate.mockRejectedValue(
    new WorkflowEstimateError(snap as never, 'failed')
  );
};

beforeEach(() => {
  resetBlocksReactMock();
  // 🔴 THIS FILE'S SUBJECT IS THE MONEY CTA, and the CTA now requires a KNOWN
  // balance that does not cover the quoted price — a top-up only fixes an
  // affordability problem, and "we don't know the balance" is not one (the mock
  // defaults to `balance: null` for exactly that reason). So the baseline here
  // is a broke viewer. The tests that assert the CTA is ABSENT do not depend on
  // it (an unpriced failure is not a refusal at any balance); the
  // unknown-balance, covered-balance and over-budget paths get their own
  // describe below.
  setMockBuzzBalance({ balance: BROKE });
});

describe('Insufficient-buzz error → prominent Top-Up CTA (delta #10)', () => {
  it('renders the Top-Up button as the primary action when the error mentions insufficient buzz', async () => {
    setMockSettings({ buzz_budget_per_gen: 50 });
    // 🔴 The STRUCTURAL shape, not wording. A spend-limit refusal is the
    // resolved failed reply that still carries the price it refused to charge.
    // These tests used to drive the CTA with an error MESSAGE containing
    // "insufficient" — which is how "not enough VRAM" and a Prisma constraint
    // named `accountBalance` also reached it.
    refuseEstimateWith(REFUSAL);
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
    refuseEstimateWith(REFUSAL);
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
    refuseEstimateWith(REFUSAL);
    await renderApp(<App />);
    // Old framing surfaced the raw error message inside an alert. New
    // framing replaces it with a short, calmer line + the CTA.
    expect(screen.getByText('This generation hit a Buzz spend limit.')).toBeInTheDocument();
    // The raw server sentence must not leak — the reframing intentionally hides
    // the orchestrator's verbatim language in favor of a user-facing one-liner.
    expect(screen.queryByText(/spend cap exceeded/)).toBeNull();
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
    expect(screen.queryByText('This generation hit a Buzz spend limit.')).not.toBeInTheDocument();
  });

  it('a RESOLVED budget refusal still reaches the top-up CTA, without showing the server text', async () => {
    // 🔴 THE AFFORDABILITY PATH RESOLVES, it does not throw (blocks-react
    // useBuzzWorkflow). So the server's wording arrives on `result.error`, and
    // the routing must read that source FIRST — the hook's `error` is set by any
    // earlier throw and never cleared, which is what shadowed this.
    setMockWorkflow({
      // The HOOK's status is `error`; the SNAPSHOT it carries is the thing with
      // `status: 'failed'`. They are different enums and mixing them silently
      // typechecks nowhere useful.
      status: 'error',
      error: new Error('estimate did not return a usable price (failed)'),
    });
    refuseEstimateWith({ ...REFUSAL, error: 'insufficient balance' });
    await renderApp(<App />);
    expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument();
    // ...and the raw server sentence is not on screen.
    expect(screen.queryByText(/insufficient balance/)).toBeNull();
  });

  it('does not LATCH: a later success clears the top-up CTA and Generate returns', async () => {
    // 🔴 REGRESSION GUARD. An earlier fix held the failure text in state and
    // never cleared it, so ONE budget-worded failure pinned the CTA to "Top up"
    // permanently — measured: after a successful re-estimate the block had NO
    // Generate button at all. The rule must be derived from current state, not
    // remembered.
    refuseEstimateWith(REFUSAL);
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
    refuseEstimateWith(REFUSAL);
    await renderApp(<App />);
    const spies = getMockSpies();
    spies.openPurchaseModal.mockClear();

    await userEvent.click(screen.getByRole('button', { name: /Top up · 250/ }));

    expect(spies.openPurchaseModal).toHaveBeenCalledTimes(1);
    expect(spies.openPurchaseModal).toHaveBeenCalledWith(250);
  });

  it('does NOT trigger the money CTA on budget-sounding WORDS alone', async () => {
    // 🔴 INVERTED DELIBERATELY. This used to assert that "over budget; not
    // enough buzz" reached the Top-Up CTA — i.e. it pinned the substring rule.
    // That rule is why "not enough VRAM available on the worker" and a Prisma
    // constraint named `accountBalance` also reached it, selling Buzz for
    // failures Buzz cannot fix. An UNPRICED failure is not a spend refusal,
    // whatever it says.
    setMockSettings({ buzz_budget_per_gen: 10 });
    refuseEstimateWith({
      workflowId: 'wf_fail',
      status: 'failed',
      error: 'over budget; not enough buzz',
    });
    await renderApp(<App />);
    expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull();
    expect(screen.queryByText('This generation hit a Buzz spend limit.')).toBeNull();
  });

  it('DOES trigger it on the priced shape, whatever the words say', async () => {
    // The other half: nonsense wording, correct shape.
    setMockSettings({ buzz_budget_per_gen: 10 });
    refuseEstimateWith({
      workflowId: 'wf_priced',
      status: 'failed',
      error: 'zzz unrelated server prose zzz',
      cost: { total: 7 },
    });
    await renderApp(<App />);
    expect(screen.getByRole('button', { name: /Top up · 100/ })).toBeInTheDocument();
  });
});

/**
 * Round 5. "Priced + failed" is NOT a shortfall on its own — the SDK enumerates
 * a whole family of priced, resolving refusals a top-up cannot fix (per-app
 * velocity, the aggregate daily cap, a fail-closed deny, a missing quote), and
 * a charged job that dies mid-render lands on the same shape. The discriminator
 * is arithmetic: does the viewer's spendable balance cover the quoted price?
 *
 * Every case below fixes the SNAPSHOT and varies only the money context, so
 * nothing here can be passing on wording.
 */
describe('a priced refusal is only a SHORTFALL when the balance cannot cover it', () => {
  const expectNoMoneyCta = () => {
    expect(screen.queryByRole('button', { name: /Top up/ })).toBeNull();
    expect(screen.queryByText('This generation hit a Buzz spend limit.')).toBeNull();
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
  };

  it('COVERED balance → no purchase CTA, Generate stays, the neutral reason shows', async () => {
    // 100 > 42. Whatever refused this generation, money was not the obstacle —
    // so selling Buzz for it would be selling a fix that cannot work.
    setMockBuzzBalance({ balance: { blue: 40, green: 30, yellow: 30 } });
    refuseEstimateWith(REFUSAL);
    await renderApp(<App />);
    expectNoMoneyCta();
    expect(screen.getByText('Generation failed.')).toBeInTheDocument();
  });

  it('UNKNOWN balance (null) → no purchase CTA — unknown must never read as short', async () => {
    // The default. Anon viewer, missing scope, host error, first paint before
    // the balance lands: all of them arrive as `null`, and the safe direction is
    // to under-offer.
    setMockBuzzBalance({ balance: null });
    refuseEstimateWith(REFUSAL);
    await renderApp(<App />);
    expectNoMoneyCta();
  });

  it('balance LOADING over a stale figure → no purchase CTA', async () => {
    // A refetch in flight is a figure being replaced. Reasoning about the old
    // one is how a debit from the job that just failed misclassifies the next
    // refusal.
    setMockBuzzBalance({ balance: BROKE, loading: true });
    refuseEstimateWith(REFUSAL);
    await renderApp(<App />);
    expectNoMoneyCta();
  });

  it('balance fetch ERRORED → no purchase CTA', async () => {
    setMockBuzzBalance({ balance: BROKE, error: new Error('host refused') });
    refuseEstimateWith(REFUSAL);
    await renderApp(<App />);
    expectNoMoneyCta();
  });

  it('price ABOVE the token budget cap → no purchase CTA, even for a broke viewer', async () => {
    // `DEFAULT_TOKEN.buzzBudget` is 50 and the host gates
    // `cost_estimate <= token.buzzBudget` before it forwards anything, so a
    // refusal quoting 900 was stopped by the TOKEN's per-call ceiling. Buzz
    // bought today does not raise a claim minted at block load.
    setMockBuzzBalance({ balance: BROKE });
    refuseEstimateWith({ ...REFUSAL, cost: { total: 900 } });
    await renderApp(<App />);
    expectNoMoneyCta();
  });

  it('SHORT balance under the cap → the purchase CTA, and Generate is replaced', async () => {
    // The positive control for all five negatives above: same snapshot, same
    // token, only the balance moved. Without it the block could be refusing to
    // sell Buzz for every reason and every negative would still pass.
    setMockBuzzBalance({ balance: { blue: 10, green: 10, yellow: 10 } }); // 30 < 42
    refuseEstimateWith(REFUSAL);
    await renderApp(<App />);
    expect(screen.getByRole('button', { name: /Top up/ })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeNull();
    expect(screen.getByText('This generation hit a Buzz spend limit.')).toBeInTheDocument();
  });

  it('the boundary: spendable EXACTLY equal to the price is not a shortfall', async () => {
    // 42 === 42. `<`, not `<=` — a viewer who can afford it to the Buzz was not
    // refused for affordability.
    setMockBuzzBalance({ balance: { blue: 42, green: 0, yellow: 0 } });
    refuseEstimateWith(REFUSAL);
    await renderApp(<App />);
    expectNoMoneyCta();
  });

  it('all three pools count toward what the viewer can spend', async () => {
    // 20 + 20 + 20 = 60 ≥ 42, but no single pool covers it. Reading only one
    // (e.g. `yellow`) would call this viewer broke and sell them Buzz they hold.
    setMockBuzzBalance({ balance: { blue: 20, green: 20, yellow: 20 } });
    refuseEstimateWith(REFUSAL);
    await renderApp(<App />);
    expectNoMoneyCta();
  });
});
