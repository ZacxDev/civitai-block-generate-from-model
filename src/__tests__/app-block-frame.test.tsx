/**
 * Covers the platform chrome strip (app-block frame):
 *   - a subtle top bar with an "App block" badge so the user can tell this
 *     is a Civitai app block, not native page UI,
 *   - clicking the badge opens an in-block context menu with "Manage apps",
 *   - "Manage apps" asks the host to navigate the parent page to
 *     /apps/installed (NAVIGATE bridge message via useCivitaiNavigate),
 *   - the menu closes on Escape and on outside pointer-down.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
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

describe('App-block frame (platform chrome)', () => {
  it('renders the app-block badge and label', async () => {
    await renderApp(<App />);
    const badge = screen.getByRole('button', { name: /App block menu/i });
    expect(badge).toBeInTheDocument();
    expect(screen.getByText('App block')).toBeInTheDocument();
    expect(badge).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not show the menu until the badge is clicked', async () => {
    await renderApp(<App />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens a menu with "Manage apps" when the badge is clicked', async () => {
    await renderApp(<App />);
    await userEvent.click(screen.getByRole('button', { name: /App block menu/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Manage apps/i })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /App block menu/i })
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('navigates the parent to /apps/installed when "Manage apps" is clicked', async () => {
    await renderApp(<App />);
    const spies = getMockSpies();
    await userEvent.click(screen.getByRole('button', { name: /App block menu/i }));
    await userEvent.click(screen.getByRole('menuitem', { name: /Manage apps/i }));
    expect(spies.navigate).toHaveBeenCalledWith('/apps/installed');
    // Menu closes after selecting.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes the menu on Escape', async () => {
    await renderApp(<App />);
    await userEvent.click(screen.getByRole('button', { name: /App block menu/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes the menu on an outside click', async () => {
    await renderApp(<App />);
    await userEvent.click(screen.getByRole('button', { name: /App block menu/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // Click somewhere outside the chrome bar (the block title).
    await userEvent.click(screen.getByText('Quick Sample'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
