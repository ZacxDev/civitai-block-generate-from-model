/**
 * Task 1 regression: the CTA Buzz cost must update when a re-estimate
 * resolves with a NEW value.
 *
 * Scenario: mount estimate resolves to 34 (button shows · 34). The user
 * edits a cost-bearing field (Steps), which triggers the debounced
 * re-estimate. That second estimate resolves to 88 — the button MUST now
 * read · 88, not the stale · 34.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  blocksReactMockFactory,
  getMockSpies,
  renderApp,
  resetBlocksReactMock,
  setMockSettings,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { App } from '../App';

function snapWithCost(total: number) {
  return {
    workflowId: 'wf_estimate',
    status: 'pending',
    cost: { total },
  } as never;
}

beforeEach(() => {
  resetBlocksReactMock();
  setMockSettings({ show_advanced: true });
});

describe('CTA cost updates when the re-estimate value changes', () => {
  it('reflects the NEW cost (34 → 88) after a cost-bearing override re-estimate', async () => {
    const spies = getMockSpies();
    // First estimate (mount) → 34.
    spies.estimate.mockResolvedValue(snapWithCost(34));

    await renderApp(<App />);

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Generate Image · 34/ })
      ).toBeInTheDocument();
    });

    // Next estimate (override-driven) → 88.
    spies.estimate.mockResolvedValue(snapWithCost(88));

    await userEvent.click(
      screen.getByRole('button', { name: /Advanced settings/i })
    );
    fireEvent.change(screen.getByLabelText('Steps'), {
      target: { value: '45' },
    });

    await waitFor(
      () => {
        expect(
          screen.getByRole('button', { name: /Generate Image · 88/ })
        ).toBeInTheDocument();
      },
      { timeout: 1500 }
    );
  });
});
