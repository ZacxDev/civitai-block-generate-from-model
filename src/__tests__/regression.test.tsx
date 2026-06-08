/**
 * Regression net for behavior that ISN'T part of the Tier-1 deltas but
 * could quietly break if we restructure the JSX too aggressively. Tests
 * here guard:
 *
 *   - Showcase pick auto-fills the prompt input
 *   - Randomize-seed one-shot toggle
 *   - isBusy disables every interactive control
 *   - localStorage persistence of selected showcase id
 *   - Dark-theme container background tracks the theme prop
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  blocksReactMockFactory,
  getMockSpies,
  renderApp,
  resetBlocksReactMock,
  setMockContext,
  setMockSettings,
  setMockTheme,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { App } from '../App';

beforeEach(() => {
  resetBlocksReactMock();
});

describe('Showcase pick → prompt populates', () => {
  it('clicking thumbnail #2 sets the prompt input to that showcase prompt', async () => {
    await renderApp(<App />);
    const input = screen.getByLabelText('Prompt (optional)') as HTMLInputElement;
    expect(input.value).toBe('a serene mountain landscape at sunset, painterly');

    await userEvent.click(screen.getByRole('button', { name: 'Pick preview 2' }));
    expect(input.value).toBe('cyberpunk cityscape, neon reflections, rain');
  });
});

describe('Randomize seed one-shot (advanced editable)', () => {
  beforeEach(() => {
    setMockSettings({ show_advanced: true });
  });

  it('toggles label from "random" to "cancel" when clicked', async () => {
    await renderApp(<App />);
    // Tier-3 #3: Advanced opens via the three-dots header button.
    await userEvent.click(screen.getByRole('button', { name: /Advanced settings/i }));
    const dice = screen.getByRole('button', { name: /🎲/ });
    expect(dice.textContent).toMatch(/random/);
    await userEvent.click(dice);
    expect(dice.textContent).toMatch(/cancel/);
    await userEvent.click(dice);
    expect(dice.textContent).toMatch(/random/);
  });
});

describe('form stays interactive while a generation is in flight (task 2)', () => {
  it('prompt, Generate, and thumbs are NOT disabled while a job polls', async () => {
    // Task 2: the blanket "busy → disabled" is gone. The queue (task 3)
    // makes submission non-blocking, so the user keeps editing + firing
    // off more generations while earlier ones run. Drive a REAL in-flight
    // job (submit pending, poll never resolves) and verify the form stays
    // interactive while that job is in flight.
    const spies = getMockSpies();
    spies.submit.mockResolvedValue({ workflowId: 'wf', status: 'pending' } as never);
    spies.poll.mockImplementation(() => new Promise<never>(() => {})); // stays in flight

    await renderApp(<App />);
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Generating')).toBeInTheDocument()
    );

    expect(screen.getByLabelText('Prompt (optional)')).not.toBeDisabled();
    // The CTA stays a Generate/Re-generate action (no Submitting/Generating
    // takeover) and remains clickable — per-job progress lives in the carousel.
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).not.toBeDisabled();
    // Carousel thumbs stay pickable.
    expect(screen.getByRole('button', { name: 'Pick preview 1' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Pick preview 2' })).not.toBeDisabled();
  });
});

describe('localStorage persistence of selected showcase', () => {
  it('persists the picked showcase id and restores it on remount', async () => {
    const { unmount } = await renderApp(<App />);
    await userEvent.click(screen.getByRole('button', { name: 'Pick preview 3' }));

    // localStorage should now hold the third showcase's id (103).
    const keys = Object.keys(window.localStorage);
    expect(keys.length).toBeGreaterThan(0);
    const stored = window.localStorage.getItem(keys[0]!);
    expect(stored).toContain('103');

    unmount();

    // Remount fresh — third thumb should be pre-selected.
    await act(async () => {
      render(<App />);
      await Promise.resolve();
    });
    const third = screen.getByRole('button', { name: 'Pick preview 3' });
    expect(third).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Dark theme styling', () => {
  it('container picks up the dark surface color when theme=dark', async () => {
    setMockTheme('dark');
    setMockContext({ theme: 'dark' });
    const { container } = await renderApp(<App />);
    const root = container.firstElementChild as HTMLElement;
    // Container style uses #1A1B1E for dark (Mantine dark[7]). JSDOM
    // normalizes hex to rgb() so we accept either form.
    const bg = root.style.background.toLowerCase();
    expect(bg === '#1a1b1e' || bg === 'rgb(26, 27, 30)').toBe(true);
  });

  it('container picks up the light surface color by default', async () => {
    const { container } = await renderApp(<App />);
    const root = container.firstElementChild as HTMLElement;
    const bg = root.style.background.toLowerCase();
    // Light surface is pure white (#ffffff) so the block content reads
    // cleanly inside the host's AppBlockChrome frame (the block draws no
    // border of its own — the host owns the chrome).
    expect(bg === '#ffffff' || bg === 'rgb(255, 255, 255)').toBe(true);
  });

  it('sets data-theme on the root so the [data-theme="dark"] CSS rules apply', async () => {
    // The carousel edge-fade ::after and the button/link/icon hover styles are
    // pseudo-elements / CSS that can't be inline-styled, so they live in the
    // injected <style> behind `[data-theme="dark"]`. The iframe is a separate
    // document — the host can't set that attribute inside it — so the block
    // root MUST set it itself, or those dark rules never match (the carousel
    // showed a light-mode fade smear on the dark block).
    setMockTheme('dark');
    setMockContext({ theme: 'dark' });
    const { container } = await renderApp(<App />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('data-theme')).toBe('dark');
  });

  it('sets data-theme="light" on the root in light mode', async () => {
    const { container } = await renderApp(<App />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('data-theme')).toBe('light');
  });
});
