/**
 * Anonymous conversion.
 *
 * A logged-out viewer (`BLOCK_INIT.viewer === null`) must see the FULL block —
 * showcase carousel + prompt form (both context-driven, no auth needed) — NOT a
 * stub. Clicking Generate while anon must:
 *   - post a `REQUEST_SIGN_IN` envelope to the host (raw window.parent.postMessage,
 *     the shippable path that needs no SDK publish), and
 *   - NOT submit or estimate a workflow (Generate stays server-gated; the click
 *     is converted into a sign-in prompt).
 *
 * The authenticated path is unchanged — Generate still submits.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  blocksReactMockFactory,
  renderApp,
  resetBlocksReactMock,
  setMockViewer,
  getMockSpies,
  generate,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

// Import AFTER the mock is registered so the App picks up the stubs.
import { App, resolveParentOrigin } from '../App';

let postMessageSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  resetBlocksReactMock();
  // The block targets the embedding page's origin (document.referrer) for the
  // REQUEST_SIGN_IN postMessage. jsdom has no referrer by default; stub one so
  // the resolved targetOrigin is a real origin (and assert it's used).
  Object.defineProperty(document, 'referrer', {
    value: 'https://civitai.com/models/555',
    configurable: true,
  });
  postMessageSpy = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  postMessageSpy.mockRestore();
});

describe('anonymous conversion (viewer === null)', () => {
  it('renders the FULL block for anon — showcase carousel + prompt form', async () => {
    setMockViewer(null);
    await renderApp(<App />);

    // Showcase carousel present (BLOCK_INIT context drives it — no auth needed).
    expect(screen.getByTestId('gfm-carousel')).toBeInTheDocument();
    // Prompt textarea present.
    expect(screen.getByLabelText(/Describe Image/i)).toBeInTheDocument();
    // The old stub copy is gone — the full UI is shown, not "Sign in to generate."
    // as the ONLY content.
    expect(screen.getByTestId('gfm-signin-cta')).toBeInTheDocument();
    expect(screen.getByTestId('gfm-signin-cta')).toHaveTextContent(/Sign in to generate/i);
  });

  it('does NOT estimate a cost for an anon viewer', async () => {
    setMockViewer(null);
    await renderApp(<App />);
    expect(getMockSpies().estimate).not.toHaveBeenCalled();
  });

  it('clicking the sign-in CTA posts REQUEST_SIGN_IN and does NOT submit a workflow', async () => {
    setMockViewer(null);
    await renderApp(<App />);

    const cta = screen.getByTestId('gfm-signin-cta');
    await userEvent.click(cta);

    // A REQUEST_SIGN_IN envelope was posted to the parent…
    const call = postMessageSpy.mock.calls.find(
      (c) => (c[0] as { type?: string } | undefined)?.type === 'REQUEST_SIGN_IN'
    );
    expect(call).toBeDefined();
    // …shaped as the SDK envelope (type only — host defaults returnUrl)…
    expect(call![0]).toEqual({ type: 'REQUEST_SIGN_IN' });
    // …and targeted at the embedding page's origin (from document.referrer),
    // never broadcast.
    expect(call![1]).toBe('https://civitai.com');

    // No workflow was submitted or estimated.
    expect(getMockSpies().submit).not.toHaveBeenCalled();
    expect(getMockSpies().estimate).not.toHaveBeenCalled();
  });

  it('authed path unchanged — Generate still submits a workflow (no sign-in prompt)', async () => {
    // Default mock viewer is authenticated. generate() clicks the Generate
    // Image button and waits for submit() to fire.
    await renderApp(<App />);
    await generate({ workflowId: 'wf_submit', status: 'pending' }, { poll: 'pending' });
    await waitFor(() => expect(getMockSpies().submit).toHaveBeenCalled());
    // No sign-in message for an authenticated viewer.
    const signInCall = postMessageSpy.mock.calls.find(
      (c) => (c[0] as { type?: string } | undefined)?.type === 'REQUEST_SIGN_IN'
    );
    expect(signInCall).toBeUndefined();
  });
});

describe('resolveParentOrigin', () => {
  it('returns the origin of a valid referrer', () => {
    expect(resolveParentOrigin('https://civitai.com/models/555?x=1')).toBe('https://civitai.com');
  });

  it('falls back to "*" when the referrer is empty or unparseable', () => {
    expect(resolveParentOrigin(undefined)).toBe('*');
    expect(resolveParentOrigin('')).toBe('*');
    expect(resolveParentOrigin('not a url')).toBe('*');
  });
});
