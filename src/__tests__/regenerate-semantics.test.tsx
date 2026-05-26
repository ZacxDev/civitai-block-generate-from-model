/**
 * Covers Tier-3 delta #11 — Re-generate semantics on sequential Generate
 * clicks against the SAME showcase.
 *
 *   First click on showcase #N   → submit with N's seed (deterministic)
 *   2nd+ click on the same #N    → submit with seed dropped (random)
 *   Click switches to showcase #M → counter resets; first click on M is
 *                                   deterministic again
 *
 * The visible affordance: the button copy flips from
 *   `Generate · {N} Buzz` → `Re-generate · {N} Buzz`
 * after the first submit so the user knows what's about to happen.
 *
 * The manual 🎲 button (in editable Advanced) is unchanged; this is an
 * auto-arm path layered on top of it. Try-again has its own one-shot
 * randomize path (covered in result-actions.test.tsx).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  blocksReactMockFactory,
  getMockSpies,
  renderApp,
  resetBlocksReactMock,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { App } from '../App';

beforeEach(() => {
  resetBlocksReactMock();
});

describe('Re-generate semantics (Tier-3 #11)', () => {
  it('first Generate click on showcase #1 submits with that showcase\'s seed', async () => {
    await renderApp(<App />);
    const spies = getMockSpies();
    spies.submit.mockClear();

    // Initial selection is showcase #1 (default first item). Fire Generate.
    await userEvent.click(screen.getByRole('button', { name: /Generate Image · 34/ }));

    expect(spies.submit).toHaveBeenCalledTimes(1);
    const params = spies.submit.mock.calls[0]![0] as { params: { seed?: number } };
    // Fixture seed for showcase #1 is 12345. The first submit should
    // forward it verbatim (not randomize).
    expect(params.params.seed).toBe(12345);
  });

  it('second Generate click on the SAME showcase submits with seed dropped (random)', async () => {
    await renderApp(<App />);
    const spies = getMockSpies();
    spies.submit.mockClear();

    // Click Generate twice on the same showcase without switching.
    await userEvent.click(screen.getByRole('button', { name: /Generate Image · 34/ }));
    // After the first submit, the button copy flips to Re-generate. Wait
    // for that state to settle before the second click.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Re-generate/ })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /Re-generate Image · 34/ }));

    expect(spies.submit).toHaveBeenCalledTimes(2);
    const firstParams = spies.submit.mock.calls[0]![0] as { params: { seed?: number } };
    const secondParams = spies.submit.mock.calls[1]![0] as { params: { seed?: number } };
    expect(firstParams.params.seed).toBe(12345); // first → seed forwarded
    expect(secondParams.params.seed).toBeUndefined(); // second → randomized
  });

  it('switching to a different showcase resets the counter — first click on the new one is deterministic', async () => {
    await renderApp(<App />);
    const spies = getMockSpies();
    spies.submit.mockClear();

    // Generate on showcase #1, then SWITCH to showcase #2 (which has
    // its own seed=67890), then Generate again.
    await userEvent.click(screen.getByRole('button', { name: /Generate Image · 34/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Pick preview 2' }));
    await waitFor(() => {
      // After switching showcases the verb should be back to Generate
      // (the counter reset means the next click is a "first" click for
      // showcase #2).
      expect(screen.getByRole('button', { name: /Generate Image · 34/ })).toBeInTheDocument();
    });
    await userEvent.click(screen.getByRole('button', { name: /Generate Image · 34/ }));

    expect(spies.submit).toHaveBeenCalledTimes(2);
    const firstParams = spies.submit.mock.calls[0]![0] as { params: { seed?: number } };
    const secondParams = spies.submit.mock.calls[1]![0] as { params: { seed?: number } };
    expect(firstParams.params.seed).toBe(12345); // showcase #1's seed
    expect(secondParams.params.seed).toBe(67890); // showcase #2's seed — NOT randomized
  });

  it('button label flips from "Generate" to "Re-generate" after the first submit on the same showcase', async () => {
    await renderApp(<App />);

    // Before any submit: idle "Generate Image · 34".
    expect(
      screen.getByRole('button', { name: /Generate Image · 34/ })
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Generate Image · 34/ }));

    // After: same showcase + idle state → "Re-generate".
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Re-generate Image · 34/ })
      ).toBeInTheDocument();
    });
  });

  it('switching showcases resets the verb back to "Generate"', async () => {
    await renderApp(<App />);

    await userEvent.click(screen.getByRole('button', { name: /Generate Image · 34/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Re-generate/ })).toBeInTheDocument();
    });

    // Switch showcase → next click on the new showcase is a "first" again.
    await userEvent.click(screen.getByRole('button', { name: 'Pick preview 3' }));
    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Generate Image · 34/ })
      ).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /Re-generate/ })).not.toBeInTheDocument();
  });
});
