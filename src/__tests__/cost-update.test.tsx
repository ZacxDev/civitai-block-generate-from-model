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

  // ---- Task 1: the RENDERED CTA cost must track the LATEST resolved
  // estimate, not a stale snapshot. The earlier deltas asserted the
  // re-estimate FIRED; these assert the button's displayed number actually
  // updates to the new value.

  it('the rendered CTA cost updates to the new value after a re-estimate resolves', async () => {
    const spies = getMockSpies();
    spies.estimate.mockResolvedValue({
      workflowId: 'wf',
      status: 'pending',
      cost: { total: 34 },
    } as never);
    await renderApp(<App />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /· 34/ })).toBeInTheDocument()
    );

    spies.estimate.mockResolvedValue({
      workflowId: 'wf',
      status: 'pending',
      cost: { total: 120 },
    } as never);
    await openAdvanced();
    fireEvent.change(screen.getByLabelText('Steps'), { target: { value: '50' } });

    await waitFor(
      () => expect(screen.getByRole('button', { name: /· 120/ })).toBeInTheDocument(),
      { timeout: 1500 }
    );
    // The stale value is gone.
    expect(screen.queryByRole('button', { name: /· 34/ })).not.toBeInTheDocument();
  });

  it('out-of-order resolution: a slow EARLIER estimate cannot clobber the newer one', async () => {
    // The mount estimate resolves AFTER the override estimate. The race
    // guard must keep the newer (override) value on the CTA, not let the
    // late mount estimate overwrite it with a stale number.
    const spies = getMockSpies();
    const mount = (() => {
      let resolve!: (v: unknown) => void;
      const promise = new Promise((r) => (resolve = r));
      return { promise, resolve };
    })();
    let n = 0;
    spies.estimate.mockImplementation(() => {
      n += 1;
      // First call (mount) is slow; subsequent (override) resolve fast.
      return n === 1
        ? (mount.promise as Promise<never>)
        : (Promise.resolve({
            workflowId: 'wf',
            status: 'pending',
            cost: { total: 200 },
          }) as never);
    });

    await renderApp(<App />);
    await openAdvanced();
    fireEvent.change(screen.getByLabelText('Steps'), { target: { value: '48' } });

    // Override estimate resolves → CTA shows 200.
    await waitFor(
      () => expect(screen.getByRole('button', { name: /· 200/ })).toBeInTheDocument(),
      { timeout: 1500 }
    );

    // NOW the slow mount estimate resolves with a stale value — it must be
    // ignored by the race guard.
    await act(async () => {
      mount.resolve({ workflowId: 'wf', status: 'pending', cost: { total: 9 } });
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: /· 200/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /· 9/ })).not.toBeInTheDocument();
  });
});
