/**
 * Covers the cost re-estimate on cost-bearing advanced overrides.
 *
 * The CTA shows the quoted Buzz cost. That cost scales with the
 * orchestrator-priced params: width, height, steps. Editing any of those
 * in Advanced must re-quote (debounced 400ms) so the button doesn't show
 * a stale price. Editing a NON-cost field (cfg scale, sampler, seed,
 * negative prompt, clipSkip) must NOT trigger a needless round-trip.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, act, fireEvent } from '@testing-library/react';
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

beforeEach(() => {
  resetBlocksReactMock();
  // Publisher `show_advanced` gates the editable number inputs (CFG /
  // Steps / Width / Height) — without it the Advanced panel shows
  // read-only chips and there's nothing to type into.
  setMockSettings({ show_advanced: true });
});

async function openAdvanced() {
  await userEvent.click(screen.getByRole('button', { name: /Advanced settings/i }));
}

describe('Cost re-estimate on advanced overrides', () => {
  it('estimates on mount', async () => {
    await renderApp(<App />);
    expect(getMockSpies().estimate).toHaveBeenCalled();
  });

  it('re-estimates when Steps changes (cost-bearing)', async () => {
    await renderApp(<App />);
    const spies = getMockSpies();
    spies.estimate.mockClear();

    await openAdvanced();
    // fireEvent.change sets the controlled value in one event. (clear+type
    // fights the showcase fallback: clearing reverts the field to the
    // showcase steps, so typing would append onto it.)
    fireEvent.change(screen.getByLabelText('Steps'), { target: { value: '45' } });

    await waitFor(
      () => expect(spies.estimate).toHaveBeenCalled(),
      { timeout: 1500 }
    );
    const lastCall = spies.estimate.mock.calls.at(-1)![0] as {
      params: { steps?: number };
    };
    expect(lastCall.params.steps).toBe(45);
  });

  it('re-estimates when a dimension changes (cost-bearing)', async () => {
    await renderApp(<App />);
    const spies = getMockSpies();
    spies.estimate.mockClear();

    await openAdvanced();
    fireEvent.change(screen.getByLabelText('Width'), { target: { value: '512' } });

    await waitFor(
      () => expect(spies.estimate).toHaveBeenCalled(),
      { timeout: 1500 }
    );
  });

  it('does NOT re-estimate when a non-cost field (CFG scale) changes', async () => {
    await renderApp(<App />);
    const spies = getMockSpies();
    spies.estimate.mockClear();

    await openAdvanced();
    fireEvent.change(screen.getByLabelText('CFG scale'), { target: { value: '9' } });

    // Wait past the 400ms debounce window — nothing should fire.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(spies.estimate).not.toHaveBeenCalled();
  });
});
