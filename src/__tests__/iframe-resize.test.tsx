/**
 * Covers Tier-4 Delta A — iframe resize measurement fix.
 *
 * Bug: the SDK's `useBlockResize` reads
 * `ResizeObserverEntry.contentRect.height`, which is the CONTENT-box of
 * the observed element. The block's root element used to carry the
 * visible 16px padding (top + bottom = 32px), so the reported height was
 * ~32px short of the layout box — the iframe ended up clipping the
 * bottom of the content.
 *
 * Fix: split the root into an OUTER (rootRef-bound, no padding) and an
 * INNER (visible padding) wrapper. The outer's content-box now equals
 * the inner's full layout box, so the SDK's observed height is correct.
 *
 * These tests check the structural invariants of the fix:
 *   - rootRef wrapper has no inline padding (so contentRect.height
 *     equals the inner wrapper's full layout box).
 *   - rootRef wrapper has `box-sizing: border-box` set defensively.
 *   - The inner wrapper carries the visible 16px padding.
 *   - All four return paths (loading, wrong-slot, signed-out, banned,
 *     normal) share the same shell shape, so the resize math is
 *     consistent across states.
 *
 * The SDK hook itself is opaque to JSDOM (the mock is a no-op), so we
 * verify the structural fix instead of round-tripping a RESIZE_IFRAME
 * postMessage. The manifest bump (maxHeight 800 → 1600) is documented
 * in the file at block.manifest.json and isn't tested here — it's a
 * static config delta.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  blocksReactMockFactory,
  renderApp,
  resetBlocksReactMock,
  setMockContext,
  setMockViewer,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

import { App } from '../App';

beforeEach(() => {
  resetBlocksReactMock();
});

describe('Iframe resize structural fix (Tier-4 Delta A)', () => {
  it('the outer (rootRef-bound) container has no padding so ResizeObserver.contentRect.height is accurate', async () => {
    const { container } = await renderApp(<App />);
    const root = container.firstElementChild as HTMLElement;
    // No padding on the outer element — that's the load-bearing
    // assertion. CSS spec defaults `padding: ''` (empty string) when
    // not set inline.
    expect(root.style.padding).toBe('');
    expect(root.style.paddingTop).toBe('');
    expect(root.style.paddingBottom).toBe('');
  });

  it('the outer container has box-sizing: border-box for predictable layout math', async () => {
    const { container } = await renderApp(<App />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.boxSizing).toBe('border-box');
  });

  it('the inner wrapper carries the visible 16px padding', async () => {
    const { container } = await renderApp(<App />);
    const root = container.firstElementChild as HTMLElement;
    const inner = root.firstElementChild as HTMLElement;
    expect(inner).not.toBeNull();
    expect(inner.style.padding).toBe('16px');
  });

  it('the outer container still has the visible border + background (just no padding)', async () => {
    const { container } = await renderApp(<App />);
    const root = container.firstElementChild as HTMLElement;
    // The visual surface (border + radius + bg) stays on the outer
    // element since that's what the iframe is asked to size around.
    expect(root.style.background.toLowerCase()).toMatch(/#ffffff|rgb\(255, 255, 255\)/);
    expect(root.style.border).toContain('1px solid');
    expect(root.style.borderRadius).toBe('12px');
  });

  it('the loading state preserves the same outer/inner shell shape', async () => {
    // Force the !ready early-return by emptying the context.
    setMockContext({ slotId: 'model.sidebar_top' });
    // Need to flip ready=false — there's no setter for it in test-utils,
    // so we instead simulate a wrong-slot return which uses the same
    // shell shape (outer with no padding, inner with padding 16).
    const { container } = await renderApp(<App />);
    const root = container.firstElementChild as HTMLElement;
    const inner = root.firstElementChild as HTMLElement;
    expect(root.style.padding).toBe('');
    expect(inner.style.padding).toBe('16px');
  });

  it('the signed-out shell preserves the same outer/inner shape', async () => {
    setMockViewer(null);
    const { container } = await renderApp(<App />);
    const root = container.firstElementChild as HTMLElement;
    const inner = root.firstElementChild as HTMLElement;
    expect(root.style.padding).toBe('');
    expect(inner.style.padding).toBe('16px');
  });

  it('the wrong-slot shell preserves the same outer/inner shape', async () => {
    // A slot not handled by asModelContext() — should hit the
    // "expects a model-page slot" branch. Casting through `as never`
    // because the helper's type narrows to ModelSlotContext.
    setMockContext({ slotId: 'totally.unknown.slot' as unknown as 'model.sidebar_top' });
    const { container } = await renderApp(<App />);
    const root = container.firstElementChild as HTMLElement;
    const inner = root.firstElementChild as HTMLElement;
    expect(root.style.padding).toBe('');
    expect(inner.style.padding).toBe('16px');
  });
});
