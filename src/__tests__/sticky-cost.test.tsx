/**
 * Covers Tier-2 delta #8 — sticky cost in the primary button during
 * submit + poll. The user should never lose sight of what they're paying
 * for what they see.
 *
 *   status='submitting'   → "Submitting · {cost} Buzz"
 *   status='polling'      → "Generating · {cost} Buzz"
 *   estimatedCost == null → "Generating (≤ {budget} Buzz)" / "Submitting (≤ {budget} Buzz)"
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

describe('Sticky cost in primary button (delta #8)', () => {
  it('shows "Generating · {N} Buzz" when status=polling AND estimate landed', async () => {
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_1', status: 'pending' } as never,
    });
    await renderApp(<App />);
    // Default estimate mock resolves to cost.total = 34.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generating · 34/ })).toBeInTheDocument();
    });
  });

  it('shows "Submitting · {N} Buzz" when status=submitting AND estimate landed', async () => {
    setMockWorkflow({
      status: 'submitting',
      result: { workflowId: 'wf_1', status: 'pending' } as never,
    });
    await renderApp(<App />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Submitting · 34/ })).toBeInTheDocument();
    });
  });

  it('falls back to "Generating (≤ {budget} Buzz)" when estimate has not landed yet', async () => {
    // Force the estimate to reject so estimatedCost stays null.
    getMockSpies().estimate.mockReset();
    getMockSpies().estimate.mockRejectedValue(new Error('estimate offline'));
    setMockSettings({ buzz_budget_per_gen: 50 });
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_1', status: 'pending' } as never,
    });
    await renderApp(<App />);
    await waitFor(() => {
      // No exact cost → fallback uses the publisher budget as the cap.
      const btn = screen.getByRole('button', { name: /Generating \(≤ 50 / });
      expect(btn).toBeInTheDocument();
    });
  });

  it('falls back to "Submitting (≤ {budget} Buzz)" when estimate has not landed yet', async () => {
    getMockSpies().estimate.mockReset();
    getMockSpies().estimate.mockRejectedValue(new Error('estimate offline'));
    setMockSettings({ buzz_budget_per_gen: 50 });
    setMockWorkflow({
      status: 'submitting',
      result: { workflowId: 'wf_1', status: 'pending' } as never,
    });
    await renderApp(<App />);
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Submitting \(≤ 50 / })
      ).toBeInTheDocument();
    });
  });

  it('keeps "Estimating cost…" copy unchanged (no sticky cost while cost is being fetched)', async () => {
    setMockWorkflow({
      status: 'estimating',
      result: null,
    });
    await renderApp(<App />);
    expect(screen.getByRole('button', { name: /Estimating cost…/ })).toBeInTheDocument();
  });
});
