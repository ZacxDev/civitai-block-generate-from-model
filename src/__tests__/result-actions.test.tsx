/**
 * Covers Tier-2 delta #7 — inline result actions.
 *
 * On a successful generation the block now shows two action buttons on
 * the same row as the spent-Buzz line:
 *   - Download    — fetches the image URL, saves as `{slug}-{ISO date}.jpeg`
 *   - Try again   — re-submits with the current params
 *
 * Buttons must be absent while the workflow is still polling and must be
 * disabled (along with the rest of the surface) when isBusy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
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

  it('clicking Try again calls submit() again with model identity', async () => {
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);
    const spies = getMockSpies();
    spies.submit.mockClear();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(spies.submit).toHaveBeenCalledTimes(1);
    // Sanity: it passed the kind + model identity. We don't pin the full
    // params shape — buildSubmitParams() has its own test surface in the
    // existing test set.
    expect(spies.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'textToImage',
        modelId: expect.any(Number),
        modelVersionId: expect.any(Number),
      })
    );
  });

  it('clicking Download programmatically clicks an anchor with the derived filename', async () => {
    setMockContext({ modelName: 'Luna_arianaV3' });
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);

    // Spy on HTMLAnchorElement.click so we can capture the download attr.
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        // No-op: prevent JSDOM's "Not implemented: navigation" warning.
      });

    await userEvent.click(screen.getByRole('button', { name: 'Download' }));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    // `this` of the spied click is the anchor — pull its attributes off
    // the call's `this`. vitest types the `instances` array loosely, so
    // a two-step cast (unknown → HTMLAnchorElement) keeps TS happy.
    const anchor = clickSpy.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(anchor.href).toBe('https://example.test/result.jpg');
    expect(anchor.getAttribute('download')).toMatch(/^luna_arianav3-\d{4}-\d{2}-\d{2}\.jpeg$/);

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

  it('falls back to opening in a new tab if the anchor click throws', async () => {
    setMockWorkflow({ status: 'idle', result: SUCCEEDED_RESULT as never });
    await renderApp(<App />);

    // Force the primary path to fail so we exercise the fallback.
    const clickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {
        throw new Error('blocked by popup blocker / cross-origin');
      });
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    await userEvent.click(screen.getByRole('button', { name: 'Download' }));

    expect(openSpy).toHaveBeenCalledWith(
      'https://example.test/result.jpg',
      '_blank',
      'noopener,noreferrer'
    );

    clickSpy.mockRestore();
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
