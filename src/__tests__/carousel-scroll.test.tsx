/**
 * Covers Tier-2 delta #9 — horizontally-scrollable, more compact carousel.
 *
 * Carousel container is `overflow-x: auto; flex-wrap: nowrap` so it stays
 * a single row and scrolls when crowded. Thumbnails shrink to 56×56 to
 * fit more on-screen while still meeting the 44×44 tap-target floor.
 * The selected thumb auto-scrolls into view on mount/restore — JSDOM
 * doesn't implement scrollIntoView so we mock it.
 *
 * Click-to-select behavior must continue to work — guards against the
 * scroll wrapper accidentally swallowing click events.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  blocksReactMockFactory,
  renderApp,
  resetBlocksReactMock,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { App } from '../App';

beforeEach(() => {
  resetBlocksReactMock();
});

describe('Carousel scroll + compact thumbs (delta #9)', () => {
  it('carousel container is overflow-x: auto and flex-wrap: nowrap', async () => {
    await renderApp(<App />);
    const carousel = screen.getByTestId('gfm-carousel');
    expect(carousel.style.overflowX).toBe('auto');
    expect(carousel.style.flexWrap).toBe('nowrap');
  });

  it('thumbnails render at 56×56 (more compact than the old 64×64)', async () => {
    await renderApp(<App />);
    const firstThumb = screen.getByRole('button', { name: 'Pick preview 1' });
    const innerImg = firstThumb.querySelector('img');
    expect(innerImg).not.toBeNull();
    expect((innerImg as HTMLImageElement).style.width).toBe('56px');
    expect((innerImg as HTMLImageElement).style.height).toBe('56px');
  });

  it('thumbs do not flex-shrink (flex: 0 0 auto) so the row stays a fixed pitch', async () => {
    await renderApp(<App />);
    const firstThumb = screen.getByRole('button', { name: 'Pick preview 1' });
    // JSDOM normalizes shorthand to the longhand triplet.
    expect(firstThumb.style.flexShrink).toBe('0');
    expect(firstThumb.style.flexGrow).toBe('0');
  });

  it('calls scrollIntoView on the selected thumb after a localStorage-restored mount', async () => {
    // JSDOM doesn't implement scrollIntoView — installing a mock both
    // covers the missing method AND lets us assert the call.
    const scrollSpy = vi.fn();
    (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollSpy;

    // Pre-seed localStorage with the third showcase's id (103). The
    // restore effect will pick that up on mount and the auto-scroll
    // effect should call scrollIntoView on the third thumb.
    window.localStorage.setItem(
      'civitai-block-generate:test-instance:2835132',
      JSON.stringify({ selectedShowcaseId: 103 })
    );

    await renderApp(<App />);

    // Confirm the third thumb is the one selected post-restore.
    expect(screen.getByRole('button', { name: 'Pick preview 3' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    // And scrollIntoView was called at least once (the effect fires on
    // every selection change, so it runs on initial restore).
    expect(scrollSpy).toHaveBeenCalled();
    // Called with smooth/center/nearest so the thumb lands centered in
    // the scroll viewport.
    expect(scrollSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ behavior: 'smooth', inline: 'center', block: 'nearest' })
    );
  });

  it('does NOT throw if scrollIntoView is missing (JSDOM safety guard)', async () => {
    // Remove the method entirely — the App should swallow the call.
    const prevImpl = (Element.prototype as unknown as { scrollIntoView?: () => void })
      .scrollIntoView;
    // @ts-expect-error: deliberately deleting to simulate missing impl.
    delete Element.prototype.scrollIntoView;
    try {
      await expect(
        act(async () => {
          render(<App />);
          await Promise.resolve();
        })
      ).resolves.not.toThrow();
    } finally {
      if (prevImpl !== undefined) {
        (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
          prevImpl;
      }
    }
  });

  it('clicking a thumbnail still updates selection + prompt (no regression from the scroll wrapper)', async () => {
    await renderApp(<App />);
    const input = screen.getByLabelText('Prompt (optional)') as HTMLInputElement;
    // Default first showcase prompt before the click.
    expect(input.value).toBe('a serene mountain landscape at sunset, painterly');
    await userEvent.click(screen.getByRole('button', { name: 'Pick preview 2' }));
    expect(screen.getByRole('button', { name: 'Pick preview 2' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(input.value).toBe('cyberpunk cityscape, neon reflections, rain');
  });
});
