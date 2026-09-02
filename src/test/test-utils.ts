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
import { useEffect, useState, type ReactElement } from 'react';
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

/**
 * What `useBuzzBalance()` reports. `balance: null` is the SDK's "we do not know"
 * — never fetched, anon viewer, or a host error — and the App's spend predicate
 * must fail toward NOT-a-shortfall on it, so it is the DEFAULT here: a test that
 * wants the money CTA has to opt in with `setMockBuzzBalance`.
 */
type BalanceState = {
  balance: { blue: number; green: number; yellow: number } | null;
  loading: boolean;
  error: Error | null;
};

interface MockState {
  context: ModelSlotContext;
  viewer: ViewerInfo | null;
  settings: BlockSettings;
  theme: 'light' | 'dark';
  ready: boolean;
  workflow: WorkflowState;
  buzzBalance: BalanceState;
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
    refetchBuzzBalance: ReturnType<typeof vi.fn>;
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
    buzzBalance: { balance: null, loading: false, error: null },
    spies: {
      submit: vi.fn(),
      estimate: vi.fn(),
      poll: vi.fn(),
      cancel: vi.fn(),
      openPurchaseModal: vi.fn(),
      checkpointOpen: vi.fn(),
      checkpointPersist: vi.fn(),
      track: vi.fn(),
      refetchBuzzBalance: vi.fn(),
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

/**
 * Shape what `useBuzzBalance()` reports. Defaults to `{ balance: null }` — the
 * SDK's "unknown" — because that is the case the App must fail SAFE on.
 *
 * `setMockBuzzBalance({ balance: { blue: 0, green: 0, yellow: 0 } })` is a
 * viewer who genuinely cannot afford anything; a large balance is a viewer for
 * whom no priced refusal can be an affordability problem.
 */
export function setMockBuzzBalance(patch: Partial<BalanceState>): void {
  state.buzzBalance = { ...state.buzzBalance, ...patch };
  // Notify any mounted `useBuzzBalance()` so a change made MID-TEST re-renders
  // the App. Before this the mock read `state` at render time only, so nothing
  // could move the balance after mount — see `setMockBuzzBalanceRefetch`.
  notifyBalance();
}

/**
 * 🔴 THE HARNESS GAP THIS CLOSES (round 6, F3). `refetchBuzzBalance` used to be
 * a bare `vi.fn()` and the balance was a value fixed before mount, so NO test
 * could express the one thing the money path actually does: settle a workflow,
 * re-read the balance, and render against the NEW figure. Two whole defect
 * families lived in that blind spot (a post-debit balance re-classifying the
 * failure that caused the debit; a refetch's `loading`/`error` blanking a
 * genuine shortfall's top-up CTA), and two guards written in round 5 survived
 * mutation because nothing here could tell a refetch happened.
 *
 * The behaviours mirror the REAL `useBuzzBalance` exactly (see
 * `blocks-react/dist/hooks/useBuzzBalance.js`):
 *   - `refetch()` sets `loading: true` and clears `error` SYNCHRONOUSLY;
 *   - on success it replaces `balance` and clears `loading`;
 *   - on failure it sets `error` and clears `loading`, LEAVING the previous
 *     `balance` in place — the hook never nulls a value it once fetched.
 *
 * `'inert'` is the default (a bare spy, nothing moves) so existing tests are
 * unaffected. The async settle lands on a microtask: flush it with
 * `await act(async () => {})` or a `waitFor`.
 */
export type BuzzRefetchBehaviour =
  | { kind: 'inert' }
  | { kind: 'resolves'; balance: { blue: number; green: number; yellow: number } }
  | { kind: 'fails'; error?: Error }
  | { kind: 'never' };

export function setMockBuzzBalanceRefetch(behaviour: BuzzRefetchBehaviour): void {
  state.spies.refetchBuzzBalance.mockImplementation(() => {
    if (behaviour.kind === 'inert') return;
    // Synchronous half — exactly what the real hook does first.
    state.buzzBalance = { ...state.buzzBalance, loading: true, error: null };
    notifyBalance();
    if (behaviour.kind === 'never') return;
    void Promise.resolve().then(() => {
      if (behaviour.kind === 'resolves') {
        state.buzzBalance = { balance: behaviour.balance, loading: false, error: null };
      } else {
        // Balance RETAINED — the real hook only sets `error` and `loading`.
        state.buzzBalance = {
          ...state.buzzBalance,
          loading: false,
          error: behaviour.error ?? new Error('host refused'),
        };
      }
      notifyBalance();
    });
  });
}

export function getMockSpies(): MockState['spies'] {
  return state.spies;
}

/**
 * Read back what `useBuzzBalance()` currently reports. Exists so a test can
 * PROVE a `refetch()` actually landed (or is still in flight) instead of
 * asserting an outcome that would look identical if the refetch never fired —
 * the reassuring-zero shape that let round 5's refetch guards survive mutation.
 */
export function getMockBuzzBalance(): BalanceState {
  return state.buzzBalance;
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
  // 🔴 PUBLISH `result` THE WAY THE REAL HOOK DOES. blocks-react calls
  // `setResult(snapshot)` on every resolved submit/poll reply, and `result.error`
  // is what the app's Buzz routing reads. This mock returned only the statically
  // configured `state.workflow.result`, so in any test that drives a failure
  // through `submit`/`poll` spies, `result` stayed null and every assertion about
  // that routing passed VACUOUSLY — the isolation seam that hid a real defect:
  // helper and router each tested alone, the seam between them untested.
  const publish = (fn: ReturnType<typeof vi.fn>) =>
    vi.fn(async (...args: unknown[]) => {
      const snap = await (fn as (...a: unknown[]) => Promise<BlockWorkflowSnapshot>)(...args);
      state.workflow.result = snap ?? null;
      return snap;
    });
  // 🔴 `estimate` PUBLISHES TOO, AND IT PUBLISHES BEFORE IT REJECTS. The real
  // hook calls `setResult(snapshot)` on the host's reply and only THEN throws
  // `WorkflowEstimateError` for an unusable one — so a refused estimate leaves a
  // failure snapshot on the shared `result` that the money CTA reads, on FIRST
  // PAINT, before the viewer has clicked anything. Wrapping only `submit`/`poll`
  // left that join untested, which is exactly the gap it hid: no test could
  // reach the CTA through the estimate path at all.
  const publishEstimate = (fn: ReturnType<typeof vi.fn>) =>
    vi.fn(async (...args: unknown[]) => {
      try {
        const snap = await (fn as (...a: unknown[]) => Promise<BlockWorkflowSnapshot>)(...args);
        state.workflow.result = snap ?? null;
        return snap;
      } catch (err) {
        const snap = (err as { snapshot?: BlockWorkflowSnapshot } | null)?.snapshot;
        if (snap) state.workflow.result = snap;
        throw err;
      }
    });
  return {
    estimate: publishEstimate(state.spies.estimate),
    submit: publish(state.spies.submit),
    poll: publish(state.spies.poll),
    cancel: state.spies.cancel,
    status: state.workflow.status,
    result: state.workflow.result,
    error: state.workflow.error,
  };
}

/**
 * Subscribers so a balance change made from OUTSIDE React (a `refetch()`
 * settling, a `setMockBuzzBalance` mid-test) actually re-renders the App. The
 * real hook holds this state internally; the mock reads a module-level record,
 * which React has no way to observe without this.
 */
const balanceListeners = new Set<() => void>();

function notifyBalance(): void {
  balanceListeners.forEach((l) => l());
}

function useBuzzBalance() {
  const [, bump] = useState(0);
  useEffect(() => {
    const listener = () => bump((n) => n + 1);
    balanceListeners.add(listener);
    return () => {
      balanceListeners.delete(listener);
    };
  }, []);
  return {
    balance: state.buzzBalance.balance,
    loading: state.buzzBalance.loading,
    error: state.buzzBalance.error,
    refetch: state.spies.refetchBuzzBalance as unknown as () => void,
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
export async function blocksReactMockFactory() {
  // `vi.importActual` and NOT a plain import: a static import of the module we
  // are mocking is circular and makes the whole test FILE fail to load, which
  // vitest reports as "no tests" rather than as a failure.
  const actual =
    await vi.importActual<typeof import('@civitai/blocks-react')>('@civitai/blocks-react');
  return {
    // 🔴 RE-EXPORT THE REAL ERROR CLASSES. App.tsx branches with
    // `err instanceof WorkflowEstimateError`; a wholesale mock that omits them
    // makes that `instanceof undefined`, which THROWS inside the catch and
    // silently swallows the whole error path — the estimate error simply never
    // renders. This is the stale-wholesale-mock class: the module gained an
    // export and the fake did not. They must be the REAL classes, not stubs,
    // or `instanceof` is false for an error the real SDK threw.
    WorkflowEstimateError: actual.WorkflowEstimateError,
    WorkflowSubmitError: actual.WorkflowSubmitError,
    useBlockContext,
    useBlockSettings,
    useBlockToken,
    useBlockResize,
    useBuzzWorkflow,
    useBuzzBalance,
    useBuzzPurchase,
    useCheckpointPicker,
    useCivitaiNavigate,
    useBlockAnalytics,
  };
}
