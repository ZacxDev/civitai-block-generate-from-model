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
  getMockSpies,
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

  it('renders Try again button when the workflow has succeeded', async () => {
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('clicking Try again calls submit() with the seed dropped (Tier-3 #11a — auto-randomize)', async () => {
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);
    const spies = getMockSpies();
    spies.submit.mockClear();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(spies.submit).toHaveBeenCalledTimes(1);
    // Sanity: it passed the kind + model identity.
    expect(spies.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'textToImage',
        modelId: expect.any(Number),
        modelVersionId: expect.any(Number),
      })
    );
    // Tier-3 #11a: the seed must be absent from the params (randomize
    // drops the showcase seed so the orchestrator picks fresh). The
    // first showcase fixture has seed=12345; if that leaked through,
    // Try again would just re-render the same image.
    const callArgs = spies.submit.mock.calls[0]![0] as { params: { seed?: number } };
    expect(callArgs.params.seed).toBeUndefined();
  });

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

  it('does NOT render Download / Try again while status is polling', async () => {
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_1', status: 'pending' } as never,
    });
    await renderApp(<App />);
    expect(screen.queryByRole('button', { name: 'Download' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
  });

  it('disables Download + Try again while a re-submission is in flight', async () => {
    // Status='submitting' represents a mid-Try-again call. Result is
    // still the prior success snapshot.
    setMockWorkflow({ status: 'submitting', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);
    expect(screen.getByRole('button', { name: 'Download' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeDisabled();
  });
});
