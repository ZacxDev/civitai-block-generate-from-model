/**
 * Test helpers for the block app.
 *
 * Strategy: rather than spin up the real `IframeTransport` + a fake
 * postMessage parent, we stub `@civitai/blocks-react` at the module level
 * via `vi.mock(...)`. Each test file calls `installBlocksReactMock()` from
 * its top-level setup (before `import { App }`) and then shapes individual
 * hook responses through the setter functions below.
 *
 * This keeps tests fast (no async transport wait) and keeps the surface
 * area narrow — we only emulate the hook contract the App actually depends
 * on. If the App grows to use a hook not represented here, add it here
 * rather than fighting the harness.
 */
import type { ReactElement } from 'react';
import { expect, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  BlockCheckpointInfo,
  BlockSettings,
  BlockToken,
  BlockWorkflowSnapshot,
  ModelSlotContext,
  ShowcaseImage,
  ViewerInfo,
  WorkflowStatus,
} from '@civitai/app-sdk/blocks';

/* ------------------------------------------------------------------ *
 *  Default fixtures
 * ------------------------------------------------------------------ */

export const DEFAULT_VIEWER: ViewerInfo = {
  id: 2,
  username: 'test-viewer',
  status: 'active',
};

export const DEFAULT_TOKEN: BlockToken = {
  raw: 'test.jwt',
  scopes: ['models:read:self', 'ai:write:budgeted'],
  expiresAt: new Date(Date.now() + 15 * 60_000),
  buzzBudget: 50,
};

export const DEFAULT_SHOWCASES: ShowcaseImage[] = [
  {
    id: 101,
    url: 'https://example.test/showcase-101.jpg',
    width: 1024,
    height: 1024,
    prompt: 'a serene mountain landscape at sunset, painterly',
    negativePrompt: 'blurry, low quality',
    cfgScale: 7.5,
    steps: 30,
    seed: 12345,
    sampler: 'DPM++ 2M Karras',
    clipSkip: 2,
  },
  {
    id: 102,
    url: 'https://example.test/showcase-102.jpg',
    width: 768,
    height: 1152,
    prompt: 'cyberpunk cityscape, neon reflections, rain',
    negativePrompt: null,
    cfgScale: 6.0,
    steps: 25,
    seed: 67890,
    sampler: 'Euler',
    clipSkip: null,
  },
  {
    id: 103,
    url: 'https://example.test/showcase-103.jpg',
    width: 1024,
    height: 1024,
    prompt: null,
    negativePrompt: null,
    cfgScale: null,
    steps: null,
    seed: null,
    sampler: null,
    clipSkip: null,
  },
];

export const DEFAULT_CHECKPOINT: BlockCheckpointInfo = {
  versionId: 9001,
  modelId: 8001,
  modelName: 'Flux Cinematic',
  versionName: 'v1.0',
  baseModel: 'Flux.1 D',
};

export const DEFAULT_MODEL_CONTEXT: ModelSlotContext = {
  slotId: 'model.sidebar_top',
  modelId: 555,
  modelVersionId: 2835132,
  modelName: 'Luna_arianaV3',
  modelType: 'LORA',
  modelNsfwLevel: 1,
  theme: 'light',
  checkpoint: DEFAULT_CHECKPOINT,
  showcaseImages: DEFAULT_SHOWCASES,
};

/* ------------------------------------------------------------------ *
 *  Mutable hook state — each test file controls these via the
 *  setter helpers below; reset between tests via `resetBlocksReactMock`.
 * ------------------------------------------------------------------ */

type WorkflowState = {
  status: WorkflowStatus;
  result: BlockWorkflowSnapshot | null;
  error: Error | null;
};

interface MockState {
  context: ModelSlotContext;
  viewer: ViewerInfo | null;
  settings: BlockSettings;
  theme: 'light' | 'dark';
  ready: boolean;
  workflow: WorkflowState;
  // Spy hooks exposed so tests can assert calls.
  spies: {
    submit: ReturnType<typeof vi.fn>;
    estimate: ReturnType<typeof vi.fn>;
    poll: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    openPurchaseModal: ReturnType<typeof vi.fn>;
    checkpointOpen: ReturnType<typeof vi.fn>;
    checkpointPersist: ReturnType<typeof vi.fn>;
    track: ReturnType<typeof vi.fn>;
  };
}

function makeFreshState(): MockState {
  return {
    context: DEFAULT_MODEL_CONTEXT,
    viewer: DEFAULT_VIEWER,
    settings: { publisherSettings: {}, userSettings: {} },
    theme: 'light',
    ready: true,
    workflow: {
      status: 'idle',
      result: null,
      error: null,
    },
    spies: {
      submit: vi.fn(),
      estimate: vi.fn(),
      poll: vi.fn(),
      cancel: vi.fn(),
      openPurchaseModal: vi.fn(),
      checkpointOpen: vi.fn(),
      checkpointPersist: vi.fn(),
      track: vi.fn(),
    },
  };
}

let state: MockState = makeFreshState();

/** Reset all mock state between tests. Call from `beforeEach`. */
export function resetBlocksReactMock(): void {
  state = makeFreshState();
}

/* ------------------------------------------------------------------ *
 *  Setters — call these from test setup to shape what the App sees.
 * ------------------------------------------------------------------ */

export function setMockContext(patch: Partial<ModelSlotContext>): void {
  state.context = { ...state.context, ...patch };
}

export function setMockViewer(viewer: ViewerInfo | null): void {
  state.viewer = viewer;
}

export function setMockSettings(publisherSettings: Record<string, unknown>): void {
  state.settings = { publisherSettings, userSettings: {} };
}

export function setMockTheme(theme: 'light' | 'dark'): void {
  state.theme = theme;
}

/**
 * Flip the pre-BLOCK_INIT gate. `false` puts the App in its boot state (the
 * shimmer skeleton) — the branch index.html's static skeleton has to agree
 * with. Defaults to `true` so every other test file keeps rendering the real
 * UI without opting in.
 */
export function setMockReady(ready: boolean): void {
  state.ready = ready;
}

export function setMockWorkflow(patch: Partial<WorkflowState>): void {
  state.workflow = { ...state.workflow, ...patch };
}

export function getMockSpies(): MockState['spies'] {
  return state.spies;
}

/* ------------------------------------------------------------------ *
 *  Hook implementations the mock returns.
 * ------------------------------------------------------------------ */

function useBlockContext() {
  return {
    ready: state.ready,
    renderMode: 'iframe' as const,
    context: state.context,
    token: DEFAULT_TOKEN,
    settings: state.settings,
    viewer: state.viewer,
    theme: state.theme,
    blockId: 'test-block',
    blockInstanceId: 'test-instance',
    appId: 'test-app',
  };
}

function useBlockSettings(): BlockSettings {
  return state.settings;
}

function useBlockToken(): BlockToken & { refresh: () => Promise<void> } {
  return { ...DEFAULT_TOKEN, refresh: async () => {} };
}

function useBlockResize(): void {
  // No-op — ResizeObserver isn't relevant to UI assertions and the stub
  // in setup.ts already covers the constructor call.
}

function useBuzzWorkflow() {
  // Default estimate returns the fixture's cost so the cost-in-button
  // tests see a numeric label. Override via state.spies.estimate.mockResolvedValue(...).
  if (state.spies.estimate.getMockImplementation() == null) {
    state.spies.estimate.mockResolvedValue({
      workflowId: 'wf_estimate',
      status: 'pending',
      cost: { total: 34 },
    } satisfies Partial<BlockWorkflowSnapshot> as BlockWorkflowSnapshot);
  }
  if (state.spies.submit.getMockImplementation() == null) {
    state.spies.submit.mockResolvedValue({
      workflowId: 'wf_submit',
      status: 'pending',
    } satisfies Partial<BlockWorkflowSnapshot> as BlockWorkflowSnapshot);
  }
  if (state.spies.poll.getMockImplementation() == null) {
    state.spies.poll.mockResolvedValue({
      workflowId: 'wf_submit',
      status: 'succeeded',
      imageUrls: ['https://example.test/result.jpg'],
    } satisfies Partial<BlockWorkflowSnapshot> as BlockWorkflowSnapshot);
  }
  if (state.spies.cancel.getMockImplementation() == null) {
    state.spies.cancel.mockResolvedValue({
      workflowId: 'wf_submit',
      status: 'canceled',
    } satisfies Partial<BlockWorkflowSnapshot> as BlockWorkflowSnapshot);
  }
  return {
    estimate: state.spies.estimate,
    submit: state.spies.submit,
    poll: state.spies.poll,
    cancel: state.spies.cancel,
    status: state.workflow.status,
    result: state.workflow.result,
    error: state.workflow.error,
  };
}

function useBuzzPurchase() {
  if (state.spies.openPurchaseModal.getMockImplementation() == null) {
    state.spies.openPurchaseModal.mockResolvedValue({ purchased: false });
  }
  return { openPurchaseModal: state.spies.openPurchaseModal };
}

function useCheckpointPicker() {
  if (state.spies.checkpointOpen.getMockImplementation() == null) {
    state.spies.checkpointOpen.mockResolvedValue({ selected: undefined });
  }
  if (state.spies.checkpointPersist.getMockImplementation() == null) {
    state.spies.checkpointPersist.mockResolvedValue(undefined);
  }
  return {
    open: state.spies.checkpointOpen,
    persist: state.spies.checkpointPersist,
  };
}

function useCivitaiNavigate() {
  return { navigate: () => {} };
}

function useBlockAnalytics() {
  return { track: state.spies.track };
}

/**
 * Render the App and flush the microtask queue once so the auto-estimate
 * effect's resolved promise lands inside an `act()` boundary. This keeps
 * React 19 from logging the "update inside test not wrapped in act" warning
 * while still letting individual tests assert on initial render output
 * synchronously (waitFor isn't needed for the post-flush state).
 */
export async function renderApp(ui: ReactElement): Promise<ReturnType<typeof render>> {
  const utils = render(ui);
  // Drain microtasks so promises queued during the initial commit settle
  // (the auto-estimate kicks off in useEffect, resolves on the next tick).
  await act(async () => {
    await Promise.resolve();
  });
  return utils;
}

/**
 * Drive the queue through the REAL production path: shape the `submit` (and
 * optionally `poll`) spy, click Generate, and wait for submit() to fire.
 *
 * This is the canonical way to surface a queue card in tests now that the
 * shared-state compatibility bridge is gone — the block ONLY mints cards via
 * handleGenerate + per-job poll loops.
 *
 * `submitSnapshot` is what submit() resolves to. Return it TERMINAL
 * (status:'succeeded' + imageUrls) for the cached-hit path (no poll needed), or
 * non-terminal (status:'pending') and pass `pollSnapshot` to drive the per-job
 * poll loop. Pass `pollSnapshot: 'pending'` to keep the job in flight forever
 * (a never-resolving poll), e.g. for loading-card assertions.
 */
export async function generate(
  submitSnapshot: Partial<BlockWorkflowSnapshot>,
  opts: { poll?: Partial<BlockWorkflowSnapshot> | 'pending' } = {}
): Promise<void> {
  const spies = getMockSpies();
  spies.submit.mockResolvedValue(submitSnapshot as BlockWorkflowSnapshot);
  if (opts.poll === 'pending') {
    // Never resolves — the job stays in flight (loading card persists).
    spies.poll.mockImplementation(() => new Promise<never>(() => {}));
  } else if (opts.poll) {
    spies.poll.mockResolvedValue(opts.poll as BlockWorkflowSnapshot);
  }
  const button = screen.getByRole('button', {
    name: /Generate Image|Re-generate Image/,
  });
  await userEvent.click(button);
  await waitFor(() => expect(spies.submit).toHaveBeenCalled());
}

/**
 * Single source of truth for the `vi.mock('@civitai/blocks-react', ...)`
 * factory. Test files call `vi.mock('@civitai/blocks-react', () => blocksReactMockFactory())`
 * at the top of the file (must be before any `import { App }`).
 */
export function blocksReactMockFactory() {
  return {
    useBlockContext,
    useBlockSettings,
    useBlockToken,
    useBlockResize,
    useBuzzWorkflow,
    useBuzzPurchase,
    useCheckpointPicker,
    useCivitaiNavigate,
    useBlockAnalytics,
  };
}
