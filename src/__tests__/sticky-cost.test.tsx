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

describe('Sticky cost on the in-flight carousel LoadingCard', () => {
  it('shows "Generating · {N}" on the LoadingCard when a job is polling AND estimate landed', async () => {
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_1', status: 'pending' } as never,
    });
    await renderApp(<App />);
    // Default estimate mock resolves to cost.total = 34. The bridged job's
    // cost snapshots from the live estimate.
    await waitFor(() => {
      const loading = screen.getByLabelText('Generating');
      expect(loading.textContent ?? '').toMatch(/Generating · 34/);
    });
  });

  it('shows "Generating · {N}" on the LoadingCard when a job is submitting AND estimate landed', async () => {
    setMockWorkflow({
      status: 'submitting',
      result: { workflowId: 'wf_1', status: 'pending' } as never,
    });
    await renderApp(<App />);
    await waitFor(() => {
      const loading = screen.getByLabelText('Generating');
      expect(loading.textContent ?? '').toMatch(/Generating · 34/);
    });
  });

  it('shows a cost-less "Generating" LoadingCard when no estimate has landed yet', async () => {
    // Force the estimate to reject so estimatedCost stays null → the
    // bridged job has no cost to snapshot.
    getMockSpies().estimate.mockReset();
    getMockSpies().estimate.mockRejectedValue(new Error('estimate offline'));
    setMockSettings({ buzz_budget_per_gen: 50 });
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_1', status: 'pending' } as never,
    });
    await renderApp(<App />);
    await waitFor(() => {
      const loading = screen.getByLabelText('Generating');
      // "Generating" with no "· N" sticky cost.
      expect(loading.textContent ?? '').toMatch(/Generating/);
      expect(loading.textContent ?? '').not.toMatch(/Generating · \d/);
    });
  });

  it('the CTA stays "Generate Image" (not Submitting/Generating) during an in-flight job', async () => {
    setMockWorkflow({
      status: 'submitting',
      result: { workflowId: 'wf_1', status: 'pending' } as never,
    });
    await renderApp(<App />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Generate Image/ })
      ).toBeInTheDocument();
    });
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
