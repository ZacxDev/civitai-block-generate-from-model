/**
 * Sticky cost during an in-flight generation.
 *
 * Queue-model update (task 2 + 3): the primary button NO LONGER takes over
 * with a "Generating/Submitting · {cost}" label while a job runs — it stays
 * "Generate Image · N" and clickable so the user can queue more. The sticky
 * cost now lives on the carousel's LoadingCard:
 *
 *   in-flight job (cost known)   → LoadingCard "Generating · {cost} ⚡"
 *   in-flight job (cost unknown) → LoadingCard "Generating" (no cost)
 *
 * Estimating (a brief cost-quote round-trip) is the one state that still
 * shows on the CTA ("Estimating cost…").
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  blocksReactMockFactory,
  generate,
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

describe('Sticky cost on the in-flight carousel LoadingCard', () => {
  it('shows "Generating · {N}" on the LoadingCard when a job is processing AND estimate landed', async () => {
    // Default estimate mock resolves to cost.total = 34, so estimatedCost is
    // 34 by the time Generate is clicked. submit() returns pending, poll()
    // advances the job to 'processing' (in flight) but never terminal.
    await renderApp(<App />);
    await generate(
      { workflowId: 'wf_1', status: 'pending' },
      { poll: { workflowId: 'wf_1', status: 'processing' } }
    );
    await waitFor(() => {
      const loading = screen.getByLabelText('Generating');
      expect(loading.textContent ?? '').toMatch(/Generating · 34/);
    });
  });

  it('shows "Generating · {N}" on the LoadingCard when a job is submitting AND estimate landed', async () => {
    // The 'submitting' card lands the instant Generate is clicked, snapshotting
    // the live estimatedCost (34) — submit() never resolves, holding it there.
    const spies = getMockSpies();
    spies.submit.mockImplementation(() => new Promise<never>(() => {}));
    await renderApp(<App />);
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      const loading = screen.getByLabelText('Generating');
      expect(loading.textContent ?? '').toMatch(/Generating · 34/);
    });
  });

  it('shows a cost-less "Generating" LoadingCard when no estimate has landed yet', async () => {
    // Make the estimate never resolve BEFORE rendering so estimatedCost stays
    // null → the in-flight job has no cost to snapshot. submit() also hangs so
    // the 'submitting' card persists.
    const spies = getMockSpies();
    spies.estimate.mockReset();
    spies.estimate.mockReturnValue(new Promise(() => {}));
    spies.submit.mockImplementation(() => new Promise<never>(() => {}));
    setMockSettings({ buzz_budget_per_gen: 50 });
    await renderApp(<App />);
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      const loading = screen.getByLabelText('Generating');
      // "Generating" with no "· N" sticky cost.
      expect(loading.textContent ?? '').toMatch(/Generating/);
      expect(loading.textContent ?? '').not.toMatch(/Generating · \d/);
    });
  });

  it('the CTA stays "Generate Image" (not Submitting/Generating) during an in-flight job', async () => {
    const spies = getMockSpies();
    spies.submit.mockImplementation(() => new Promise<never>(() => {}));
    await renderApp(<App />);
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() => {
      expect(screen.getByLabelText('Generating')).toBeInTheDocument();
    });
    // The CTA stays a Generate/Re-generate action (clicking once on the
    // showcase flips it to "Re-generate Image") — it does NOT take over with
    // a "Submitting"/"Generating" label while the job is in flight.
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Submitting/ })).not.toBeInTheDocument();
  });

  it('shows "Estimating cost…" on the FIRST quote (no cost landed yet)', async () => {
    // Make the estimate hang so estimatedCost stays null — the very first
    // quote, before any cost has landed, still shows the "Estimating cost…"
    // copy on the CTA.
    getMockSpies().estimate.mockReset();
    getMockSpies().estimate.mockReturnValue(new Promise(() => {}));
    setMockWorkflow({
      status: 'estimating',
      result: null,
    });
    await renderApp(<App />);
    expect(screen.getByRole('button', { name: /Estimating cost…/ })).toBeInTheDocument();
  });

  it('KEEPS the last-known cost on the CTA during a re-quote (task 1: no stale-blank flicker)', async () => {
    // estimatedCost is already 34 (default mock). A re-estimate in flight
    // (status=estimating) must NOT blank the number to "Estimating cost…";
    // the prior cost stays until the new one lands.
    setMockWorkflow({ status: 'estimating', result: null });
    await renderApp(<App />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generate Image · 34/ })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Estimating cost…/ })).not.toBeInTheDocument();
  });
});
