/**
 * Covers Tier-1 delta #6 — prompt placeholder rewording.
 *
 * Old:  "Optional prompt — defaults to {model}'s style"
 * New:  "Describe what you want (or hit Generate to use the preview)"
 *
 * The word "Optional" read as "you don't need to do anything," which made
 * new users think the input was non-functional. The new copy is explicit
 * about both paths (type something, or skip and use the preview).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import { blocksReactMockFactory, renderApp, resetBlocksReactMock } from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { App } from '../App';

beforeEach(() => {
  resetBlocksReactMock();
});

describe('Prompt placeholder', () => {
  it('uses the new explicit copy', async () => {
    await renderApp(<App />);
    const input = screen.getByLabelText('Prompt (optional)') as HTMLInputElement;
    expect(input.placeholder).toContain('Describe what you want');
  });

  it('does NOT use the old "Optional prompt" phrasing', async () => {
    await renderApp(<App />);
    const input = screen.getByLabelText('Prompt (optional)') as HTMLInputElement;
    expect(input.placeholder).not.toContain('Optional prompt');
  });

  it('hints that hitting Generate without typing still works', async () => {
    await renderApp(<App />);
    const input = screen.getByLabelText('Prompt (optional)') as HTMLInputElement;
    // Looser match — the copy could trim further, but the "or hit Generate"
    // affordance must survive any wordsmithing.
    expect(input.placeholder.toLowerCase()).toMatch(/generate|preview/);
  });
});
