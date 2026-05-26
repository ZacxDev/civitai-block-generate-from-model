/**
 * Covers Tier-2 delta #7 + Tier-3 delta #10/#11a — inline result actions.
 *
 * On a successful generation the block shows two action buttons on the
 * same row as the spent-Buzz line:
 *   - Download    — fetches the image as a Blob, then clicks a hidden
 *                   anchor with `download={slug}-{ISO date}.jpeg` set on
 *                   a blob: URL. The Tier-2 implementation used the
 *                   plain remote URL with `download=...`; most CDNs
 *                   don't honor cross-origin `download` so the browser
 *                   navigated instead. The blob path fixes that.
 *   - Try again   — re-submits, ALWAYS with a randomized seed (Tier-3
 *                   #11a — re-rolling the seed is the obvious "give me
 *                   something different" affordance for this button).
 *
 * Buttons must be absent while the workflow is still polling and must be
 * disabled (along with the rest of the surface) when isBusy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  blocksReactMockFactory,
  renderApp,
  resetBlocksReactMock,
  setMockContext,
  setMockWorkflow,
} from '../test/test-utils';
import { deriveDownloadFilename } from '../App';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { App } from '../App';

beforeEach(() => {
  resetBlocksReactMock();
});

const SUCCEEDED_RESULT = {
  workflowId: 'wf_done',
  status: 'succeeded' as const,
  imageUrls: ['https://example.test/result.jpg'],
  cost: { total: 34 },
};

describe('Inline result actions (delta #7)', () => {
  it('renders Download button when the workflow has succeeded', async () => {
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
  });

  // "Try again" was removed (2026-05-26). The auto-randomize-on-re-generate
  // behavior lives on the main Generate button — clicking it a 2nd time
  // on the same showcase drops the seed. See regenerate-semantics.test.tsx.

it('clicking Download fetches the image as a Blob and clicks an anchor with the derived filename', async () => {
    setMockContext({ modelName: 'Luna_arianaV3' });
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);

    // Tier-3 #10: the new path is fetch → blob → anchor.click on a
    // blob: URL. JSDOM doesn't ship URL.createObjectURL so we stub the
    // methods on the URL constructor before spying on them.
    const URLCtor = URL as unknown as {
      createObjectURL?: (b: Blob) => string;
      revokeObjectURL?: (u: string) => void;
    };
    URLCtor.createObjectURL = () => 'blob:test/abc-123';
    URLCtor.revokeObjectURL = () => {};

    const blob = new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockResolvedValue({ ok: true, blob: () => Promise.resolve(blob) } as any);
    const createUrlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:test/abc-123');
    const revokeUrlSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        // No-op: prevent JSDOM's "Not implemented: navigation" warning.
      });

    await userEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://example.test/result.jpg',
        expect.objectContaining({ mode: 'cors', credentials: 'omit' })
      );
    });
    await waitFor(() => {
      expect(clickSpy).toHaveBeenCalledTimes(1);
    });
    // `this` of the spied click is the anchor — verify its blob href +
    // the filename attached via the download attribute.
    const anchor = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.href).toBe('blob:test/abc-123');
    expect(anchor.getAttribute('download')).toMatch(/^luna_arianav3-\d{4}-\d{2}-\d{2}\.jpeg$/);
    // createObjectURL was used so the anchor could point at the blob;
    // revoke is deferred via setTimeout so we don't assert it here.
    expect(createUrlSpy).toHaveBeenCalledWith(blob);

    fetchSpy.mockRestore();
    createUrlSpy.mockRestore();
    revokeUrlSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it('deriveDownloadFilename produces the expected slug + date format', () => {
    // Pinning the today-helper to a known date keeps the test stable.
    const fixed = new Date('2026-05-26T12:34:56.000Z');
    expect(deriveDownloadFilename('Luna_arianaV3', fixed)).toBe('luna_arianav3-2026-05-26.jpeg');
    // Mixed case + spaces + special chars collapse to dashes.
    expect(deriveDownloadFilename('Some Wild Model!!', fixed)).toBe(
      'some-wild-model-2026-05-26.jpeg'
    );
    // Empty/garbage falls back to a placeholder so the file still
    // downloads with a sensible name.
    expect(deriveDownloadFilename('', fixed)).toBe('generation-2026-05-26.jpeg');
    expect(deriveDownloadFilename('!!!', fixed)).toBe('generation-2026-05-26.jpeg');
  });

  it('falls back to opening in a new tab if the fetch path fails (CORS-blocked, etc.)', async () => {
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);

    // Force fetch to reject so we exercise the catch-block fallback.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('CORS blocked'));
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    await userEvent.click(screen.getByRole('button', { name: 'Download' }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith(
        'https://example.test/result.jpg',
        '_blank',
        'noopener,noreferrer'
      );
    });

    fetchSpy.mockRestore();
    openSpy.mockRestore();
  });

  it('does NOT render the carousel while status is polling (no prior success captured)', async () => {
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_1', status: 'pending' } as never,
    });
    await renderApp(<App />);
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
  });

  it('disables Download while a re-submission is in flight (a prior result is in the carousel)', async () => {
    // Status='submitting' represents a re-generate mid-call. Result is
    // still the prior success snapshot.
    setMockWorkflow({ status: 'submitting', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
  });
});

/**
 * Tier-4 Delta B: re-generate ACCUMULATES results into a horizontal
 * carousel (capped at MAX_RESULTS=8 with FIFO eviction). Each card has a
 * Download button (aria-label "Download"). Switching showcases clears
 * the carousel.
 */
describe('Results carousel — accumulation + eviction (Tier-4 Delta B)', () => {
  it('a single succeeded result renders exactly one card', async () => {
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);
    // Each card has its own Download button (aria-label).
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1);
  });

  it('two successive succeeded results render TWO cards, newest first', async () => {
    // First result lands at mount.
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    const { rerender } = await renderApp(<App />);
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1);

    // Second result lands (simulate a new workflow completing).
    const SECOND_RESULT = {
      workflowId: 'wf_done_2',
      status: 'succeeded' as const,
      imageUrls: ['https://example.test/result-2.jpg'],
      cost: { total: 22 },
    };
    setMockWorkflow({ status: 'idle', result: SECOND_RESULT as never });
    await import('react').then(async ({ act }) => {
      await act(async () => {
        rerender(<App />);
        await Promise.resolve();
      });
    });

    // Two cards now — both with Download buttons.
    const downloads = screen.getAllByRole('button', { name: 'Download' });
    expect(downloads).toHaveLength(2);

    // Newest at the front: the carousel's first <img> is the second
    // result's URL. The result image cards have alt text like
    // "Generation N" descending from newest (N) to oldest (1).
    const carousel = screen.getByTestId('gfm-results-carousel');
    const imgs = carousel.querySelectorAll('img');
    expect(imgs[0]!.src).toBe('https://example.test/result-2.jpg');
    expect(imgs[1]!.src).toBe('https://example.test/result.jpg');
  });

  it('switching to a different showcase PRESERVES the results carousel (gallery is session-long)', async () => {
    // Tier-4 Delta B was originally "reset on showcase swap"; user
    // feedback (2026-05-26) reversed that — picking a different starter
    // should just change what the NEXT generation looks like, not erase
    // what's already been made. The carousel is the user's session-long
    // exploration record.
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1);

    // Switch showcase — the prior result must remain visible.
    await userEvent.click(screen.getByRole('button', { name: 'Pick preview 2' }));

    expect(screen.getByTestId('gfm-results-carousel')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1);
  });

  it('caps the carousel at MAX_RESULTS=8 with FIFO eviction (oldest goes first)', async () => {
    // Start with one result, then push 8 more — total 9 unique
    // workflowIds. After eviction the array must hold 8 with the
    // oldest (workflowId 'wf_done_0') gone.
    const makeResult = (i: number) => ({
      workflowId: `wf_done_${i}`,
      status: 'succeeded' as const,
      imageUrls: [`https://example.test/result-${i}.jpg`],
      cost: { total: i },
    });

    setMockWorkflow({ status: 'idle', result: makeResult(0) as never });
    const { rerender } = await renderApp(<App />);

    const { act } = await import('react');
    for (let i = 1; i <= 8; i += 1) {
      setMockWorkflow({ status: 'idle', result: makeResult(i) as never });
      await act(async () => {
        rerender(<App />);
        await Promise.resolve();
      });
    }

    // Exactly 8 cards (cap), oldest (`result-0.jpg`) evicted.
    const downloads = screen.getAllByRole('button', { name: 'Download' });
    expect(downloads).toHaveLength(8);

    const carousel = screen.getByTestId('gfm-results-carousel');
    const imgs = Array.from(carousel.querySelectorAll('img'));
    const urls = imgs.map((img) => img.src);
    // The oldest (#0) must be absent.
    expect(urls).not.toContain('https://example.test/result-0.jpg');
    // The newest (#8) must be at the front.
    expect(urls[0]).toBe('https://example.test/result-8.jpg');
    // Card count matches Download-button count.
    expect(urls).toHaveLength(8);
  });

  it('accumulated cards stay visible while a new submission is in flight', async () => {
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    const { rerender } = await renderApp(<App />);

    const SECOND_RESULT = {
      workflowId: 'wf_done_2',
      status: 'succeeded' as const,
      imageUrls: ['https://example.test/result-2.jpg'],
      cost: { total: 22 },
    };
    setMockWorkflow({ status: 'idle', result: SECOND_RESULT as never });
    const { act } = await import('react');
    await act(async () => {
      rerender(<App />);
      await Promise.resolve();
    });

    // Start a third submission (mid-flight) — the 2 prior cards stay.
    setMockWorkflow({ status: 'submitting', result: SECOND_RESULT as never });
    await act(async () => {
      rerender(<App />);
      await Promise.resolve();
    });

    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(2);
  });
});
