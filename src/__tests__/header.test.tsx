/**
 * Covers Tier-1 delta #5 — header line reframing.
 *
 *   Before: `Generate from this model` + `${modelName} · v${modelVersionId}`
 *   After:  `Generate from this model` + `${modelName} · ${ecosystem} ${modelType}`
 *
 * The version id is meaningless to non-power users; the chip is the new
 * identity signal. Ecosystem comes from the effective checkpoint's
 * `baseModel`.
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

describe('Header — model line', () => {
  it('renders "{modelName} · Flux LoRA" for a Flux.1 D LoRA install', async () => {
    setMockContext({
      modelName: 'Luna_arianaV3',
      modelType: 'LORA',
      checkpoint: { ...DEFAULT_CHECKPOINT, baseModel: 'Flux.1 D' },
    });
    await renderApp(<App />);
    expect(screen.getByText('Luna_arianaV3')).toBeInTheDocument();
    expect(screen.getByText('Flux LoRA')).toBeInTheDocument();
  });

  it('renders "{modelName} · SDXL Checkpoint" for an SDXL Checkpoint install', async () => {
    setMockContext({
      modelName: 'Luna_arianaV3',
      modelType: 'Checkpoint',
      checkpoint: { ...DEFAULT_CHECKPOINT, baseModel: 'SDXL 1.0' },
    });
    await renderApp(<App />);
    expect(screen.getByText('Luna_arianaV3')).toBeInTheDocument();
    expect(screen.getByText('SDXL Checkpoint')).toBeInTheDocument();
  });

  it('renders "{modelName} · Illustrious LoRA" for an Illustrious LoRA', async () => {
    setMockContext({
      modelName: 'Luna_arianaV3',
      modelType: 'LORA',
      checkpoint: { ...DEFAULT_CHECKPOINT, baseModel: 'Illustrious' },
    });
    await renderApp(<App />);
    expect(screen.getByText('Illustrious LoRA')).toBeInTheDocument();
  });

  it('collapses Flux.1 S / Flux.1 Kontext to "Flux"', async () => {
    setMockContext({
      modelName: 'Luna_arianaV3',
      modelType: 'LORA',
      checkpoint: { ...DEFAULT_CHECKPOINT, baseModel: 'Flux.1 Kontext' },
    });
    await renderApp(<App />);
    expect(screen.getByText('Flux LoRA')).toBeInTheDocument();
  });

  it('renders bare model name (no chip) when no checkpoint info is available', async () => {
    setMockContext({
      modelName: 'Luna_arianaV3',
      modelType: 'LORA',
      checkpoint: null,
    });
    await renderApp(<App />);
    expect(screen.getByText('Luna_arianaV3')).toBeInTheDocument();
    // No ecosystem chip rendered — there's nothing to derive from.
    expect(screen.queryByText(/Flux LoRA|SDXL/i)).not.toBeInTheDocument();
  });

  it('does NOT render the model version id anywhere on screen', async () => {
    setMockContext({
      modelName: 'Luna_arianaV3',
      modelVersionId: 2835132,
      modelType: 'LORA',
      checkpoint: { ...DEFAULT_CHECKPOINT, baseModel: 'Flux.1 D' },
    });
    await renderApp(<App />);
    // The old "v2835132" form was the legacy header — must be gone.
    expect(screen.queryByText(/v2835132/)).not.toBeInTheDocument();
    expect(screen.queryByText(/2835132/)).not.toBeInTheDocument();
  });
});
