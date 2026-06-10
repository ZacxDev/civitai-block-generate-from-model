/**
 * Lazy consent.
 *
 * A logged-in viewer who hasn't granted the money/AI scope yet
 * (`useBlockToken().scopes` is missing `ai:write:budgeted` because the host
 * withheld it at mint) must see the FULL block — showcase carousel + prompt
 * form — NOT a consent wall on load. Clicking Generate must:
 *   - post a `REQUEST_CONSENT` envelope to the host (raw window.parent.postMessage,
 *     the shippable path that needs no SDK publish), and
 *   - NOT submit or estimate a workflow (Generate stays server-gated; the click
 *     is converted into a consent prompt).
 *
 * Once consent lands (the host re-mints and the token gains the scope), the
 * deferred Generate auto-fires so the user's single click "just works."
 *
 * Anon (viewer === null) is unaffected — that path posts REQUEST_SIGN_IN
 * (anon-conversion.test.tsx); fully-consented viewers submit directly.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  blocksReactMockFactory,
  renderApp,
  resetBlocksReactMock,
  setMockScopes,
  setMockReady,
  getMockSpies,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

// Import AFTER the mock is registered so the App picks up the stubs.
import { App } from '../App';

let postMessageSpy: ReturnType<typeof vi.spyOn>;

// A logged-in viewer who has only the consent-exempt read scope — no
// ai:write:budgeted. The default mock viewer is authenticated, so leaving
// setMockViewer at its default + trimming scopes is exactly the unconsented case.
const UNCONSENTED_SCOPES = ['models:read:self'];
const CONSENTED_SCOPES = ['models:read:self', 'ai:write:budgeted'];

beforeEach(() => {
  resetBlocksReactMock();
  Object.defineProperty(document, 'referrer', {
    value: 'https://civitai.com/models/555',
    configurable: true,
  });
  postMessageSpy = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
});

afterEach(() => {
  postMessageSpy.mockRestore();
});

describe('lazy consent (logged-in viewer without ai:write:budgeted)', () => {
  it('renders the FULL block — showcase carousel + prompt form, no consent wall', async () => {
    setMockScopes(UNCONSENTED_SCOPES);
    await renderApp(<App />);

    expect(screen.getByTestId('gfm-carousel')).toBeInTheDocument();
    expect(screen.getByLabelText(/Describe Image/i)).toBeInTheDocument();
    // A real Generate button (NOT the anon sign-in CTA) — consent is requested
    // on click, not on load.
    expect(screen.queryByTestId('gfm-signin-cta')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    ).toBeInTheDocument();
  });

  it('does NOT estimate a cost before consent (no ai:write:budgeted scope)', async () => {
    setMockScopes(UNCONSENTED_SCOPES);
    await renderApp(<App />);
    expect(getMockSpies().estimate).not.toHaveBeenCalled();
  });

  it('clicking Generate posts REQUEST_CONSENT and does NOT submit or sign-in', async () => {
    setMockScopes(UNCONSENTED_SCOPES);
    await renderApp(<App />);

    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );

    // A REQUEST_CONSENT envelope was posted to the parent…
    const call = postMessageSpy.mock.calls.find(
      (c) => (c[0] as { type?: string } | undefined)?.type === 'REQUEST_CONSENT'
    );
    expect(call).toBeDefined();
    // …carrying the advisory scope hint…
    expect(call![0]).toEqual({
      type: 'REQUEST_CONSENT',
      payload: { scopes: ['ai:write:budgeted', 'buzz:read:self'] },
    });
    // …targeted at the embedding page's origin (from document.referrer).
    expect(call![1]).toBe('https://civitai.com');

    // Neither a workflow submit nor a sign-in prompt (the viewer IS logged in).
    expect(getMockSpies().submit).not.toHaveBeenCalled();
    expect(getMockSpies().estimate).not.toHaveBeenCalled();
    const signInCall = postMessageSpy.mock.calls.find(
      (c) => (c[0] as { type?: string } | undefined)?.type === 'REQUEST_SIGN_IN'
    );
    expect(signInCall).toBeUndefined();
  });

  // Regression: the consent-retry useRef + useEffect must sit ABOVE the App's
  // early returns (e.g. the `!ready` loading return) so hook order is stable.
  // Placing them after an early return throws React #310 ("rendered more hooks
  // than during the previous render") on the not-ready → ready transition —
  // which is exactly what happened live before this fix. Rendering not-ready
  // first then ready must not crash.
  it('does not violate rules-of-hooks across the not-ready → ready transition', async () => {
    setMockScopes(UNCONSENTED_SCOPES);
    setMockReady(false);
    const { rerender } = await renderApp(<App />);
    setMockReady(true);
    rerender(<App />);
    // If hook order were unstable this throws before reaching here; reaching the
    // assertion (block renders its Generate button) proves stable hook order.
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
      ).toBeInTheDocument()
    );
  });

  it('after consent lands (token gains the scope), the deferred Generate auto-fires submit', async () => {
    setMockScopes(UNCONSENTED_SCOPES);
    getMockSpies().submit.mockResolvedValue({ workflowId: 'wf_after_consent', status: 'pending' });
    getMockSpies().poll.mockImplementation(() => new Promise(() => {})); // stay in-flight

    const { rerender } = await renderApp(<App />);

    // Deferred click — posts REQUEST_CONSENT, no submit yet.
    await userEvent.click(
      screen.getByRole('button', { name: /Generate Image|Re-generate Image/ })
    );
    expect(getMockSpies().submit).not.toHaveBeenCalled();

    // Host grants consent + re-mints → the token now carries ai:write:budgeted.
    setMockScopes(CONSENTED_SCOPES);
    rerender(<App />);

    // The pending generate fires on its own — single click, no re-click needed.
    await waitFor(() => expect(getMockSpies().submit).toHaveBeenCalledTimes(1));
  });
});
