/**
 * Covers Tier-3 deltas #1 + #2 — header simplification.
 *
 *   Before (Tier 1/2): `Generate from this model`
 *                       + subtitle line `{modelName} · {ecosystem} {modelType}`
 *   After (Tier 3):    `Quick Sample` (title only — no subtitle)
 *
 * The model identity is already obvious from the surrounding page context
 * (the block sits on a model page), and the ecosystem chip was a power-
 * user signal that 90% of users ignore. Reclaiming the vertical space
 * makes the prompt + carousel + Generate flow tighter.
 *
 * Tier-1 helpers (`deriveEcosystem`, `formatModelTypeChip`) are gone too
 * — they had no other callers, so we removed them in the same pass.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import {
  blocksReactMockFactory,
  renderApp,
  resetBlocksReactMock,
  setMockContext,
  DEFAULT_CHECKPOINT,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

// Import AFTER the mock is registered so the App picks up the stubs.
// (vi.mock is hoisted, but the explicit ordering keeps reviewers from
// wondering about side-effect ordering.)
import { App } from '../App';

beforeEach(() => {
  resetBlocksReactMock();
});

describe('Header (Tier-3) — title only, no subtitle', () => {
  it('renders the "Quick Sample" title', async () => {
    setMockContext({
      modelName: 'Luna_arianaV3',
      modelType: 'LORA',
      checkpoint: { ...DEFAULT_CHECKPOINT, baseModel: 'Flux.1 D' },
    });
    await renderApp(<App />);
    // h3 with the new title text.
    const title = screen.getByRole('heading', { level: 3 });
    expect(title).toHaveTextContent('Quick Sample');
  });

  it('does NOT render the old "Generate from this model" title', async () => {
    await renderApp(<App />);
    expect(screen.queryByText(/Generate from this model/i)).not.toBeInTheDocument();
  });

  it('does NOT render the model name in the header (subtitle is gone)', async () => {
    setMockContext({
      modelName: 'Luna_arianaV3',
      modelType: 'LORA',
      checkpoint: { ...DEFAULT_CHECKPOINT, baseModel: 'Flux.1 D' },
    });
    await renderApp(<App />);
    // The model name lived inside a <small> in the Tier-1 subtitle. The
    // whole subtitle is deleted; the name should not appear anywhere in
    // the block. (Other places that could legitimately surface it —
    // e.g. download filename, alt text — don't render visible text.)
    expect(screen.queryByText('Luna_arianaV3')).not.toBeInTheDocument();
  });

  it('does NOT render the ecosystem chip ("Flux LoRA", "SDXL Checkpoint", etc.)', async () => {
    setMockContext({
      modelName: 'Luna_arianaV3',
      modelType: 'LORA',
      checkpoint: { ...DEFAULT_CHECKPOINT, baseModel: 'Flux.1 D' },
    });
    await renderApp(<App />);
    expect(screen.queryByText(/Flux LoRA/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/SDXL/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Illustrious/i)).not.toBeInTheDocument();
  });

  it('does NOT render the model version id anywhere on screen', async () => {
    setMockContext({
      modelName: 'Luna_arianaV3',
      modelVersionId: 2835132,
      modelType: 'LORA',
      checkpoint: { ...DEFAULT_CHECKPOINT, baseModel: 'Flux.1 D' },
    });
    await renderApp(<App />);
    expect(screen.queryByText(/v2835132/)).not.toBeInTheDocument();
    expect(screen.queryByText(/2835132/)).not.toBeInTheDocument();
  });
});
