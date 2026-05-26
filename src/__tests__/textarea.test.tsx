/**
 * Covers Tier-3 delta #9 — prompt input is a textarea (was a single-line
 * <input>). Most prompts are multi-line; clipping them at a single visible
 * line was hostile. Auto-grow is capped at ~5 lines (max-height: 120px).
 *
 * Keyboard shortcut: Ctrl/Cmd+Enter submits. Plain Enter inserts a
 * newline (no clobbering multi-line input).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
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

describe('Prompt textarea (Tier-3 #9)', () => {
  it('renders the prompt as a <textarea>, not an <input>', async () => {
    await renderApp(<App />);
    const field = screen.getByLabelText('Prompt (optional)');
    // tagName is upper-case in HTML; the load-bearing assertion is that
    // it's a textarea (multi-line) not an input (single-line).
    expect(field.tagName).toBe('TEXTAREA');
  });

  it('caps growth via max-height (~5 lines)', async () => {
    await renderApp(<App />);
    const field = screen.getByLabelText('Prompt (optional)') as HTMLTextAreaElement;
    // The inline max-height token is 120px — same value the JS effect
    // clamps to so a runaway paste can't push it past.
    expect(field.style.maxHeight).toBe('120px');
    // No drag-resize handle.
    expect(field.style.resize).toBe('none');
  });

  it('Ctrl+Enter submits the form via the Generate flow', async () => {
    await renderApp(<App />);
    const field = screen.getByLabelText('Prompt (optional)') as HTMLTextAreaElement;
    const spies = getMockSpies();
    spies.submit.mockClear();

    // Focus + Ctrl+Enter. fireEvent is the right tool here — userEvent
    // simulates the full keystroke sequence including the character
    // input, which would also append a newline before the keydown fires.
    field.focus();
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });

    await waitFor(() => {
      expect(spies.submit).toHaveBeenCalledTimes(1);
    });
  });

  it('Cmd+Enter (Mac) also submits', async () => {
    await renderApp(<App />);
    const field = screen.getByLabelText('Prompt (optional)') as HTMLTextAreaElement;
    const spies = getMockSpies();
    spies.submit.mockClear();

    field.focus();
    fireEvent.keyDown(field, { key: 'Enter', metaKey: true });

    await waitFor(() => {
      expect(spies.submit).toHaveBeenCalledTimes(1);
    });
  });

  it('plain Enter does NOT submit (it would otherwise block multi-line input)', async () => {
    await renderApp(<App />);
    const field = screen.getByLabelText('Prompt (optional)') as HTMLTextAreaElement;
    const spies = getMockSpies();
    spies.submit.mockClear();

    field.focus();
    fireEvent.keyDown(field, { key: 'Enter' });

    // Drain a microtask just in case the handler was async-deferred.
    await Promise.resolve();
    expect(spies.submit).not.toHaveBeenCalled();
  });

  it('typing multi-line content does NOT trigger submit', async () => {
    await renderApp(<App />);
    const field = screen.getByLabelText('Prompt (optional)') as HTMLTextAreaElement;
    const spies = getMockSpies();
    spies.submit.mockClear();

    // Use userEvent.type to simulate the full keypress including Enter.
    // The handler must only fire submit when Ctrl/Cmd is held.
    await userEvent.click(field);
    await userEvent.keyboard('line 1{Enter}line 2');

    expect(spies.submit).not.toHaveBeenCalled();
    expect(field.value).toContain('\n');
  });

  it('does NOT submit on Ctrl+Enter while disabled (busy state)', async () => {
    const { setMockWorkflow } = await import('../test/test-utils');
    setMockWorkflow({
      status: 'polling',
      result: { workflowId: 'wf_1', status: 'pending' } as never,
    });
    await renderApp(<App />);
    const field = screen.getByLabelText('Prompt (optional)') as HTMLTextAreaElement;
    const spies = getMockSpies();
    spies.submit.mockClear();

    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    await Promise.resolve();

    expect(spies.submit).not.toHaveBeenCalled();
  });
});
