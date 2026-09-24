// The hooks the block calls, rebound onto `@civitai/sdk`.
//
// These keep the SIGNATURES the blocks-react bridge package's hooks had, so the port
// is a change of transport rather than a rewrite of 3,400 lines of block logic:
// `App.tsx` changed at its import block, not throughout. Each one is a thin
// adapter; the interesting code is in `workflows.ts` and `buzz.ts`.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

import type {
  BlockCheckpointInfo,
  BlockContext,
  BlockSettings,
  BlockToken,
  ViewerInfo,
  WorkflowBody,
  BlockWorkflowSnapshot,
  WorkflowStatus,
} from '@civitai/app-sdk/blocks';

import { fetchBuzzBalance, type BuzzBalance } from './buzz.js';
import { getClient, getPlatformTransport, getSnapshot } from './client.js';
import {
  createWorkflowClient,
  TERMINAL_STATUSES,
  type WorkflowClient,
} from './workflows.js';

/* ------------------------------------------------------------------ *
 *  Context
 * ------------------------------------------------------------------ */

export interface BlockContextValue {
  /** `false` until the host handshake lands. Nothing below is meaningful before. */
  ready: boolean;
  /** `null` for an anonymous viewer — a supported state, not an error. */
  viewer: ViewerInfo | null;
  context: BlockContext;
  settings: BlockSettings;
  theme: 'light' | 'dark';
  /** Identifies THIS embed. The block keys its localStorage draft on it. */
  blockInstanceId: string;
  /** `buzzBudget` is the per-call ceiling the server enforces, when claimed. */
  token: BlockToken;
}

/**
 * Read the transport snapshot into the shape the block consumes.
 *
 * Both halves of the handshake are read from the SAME snapshot rather than
 * `BlockAppClient`'s getters plus the transport's: `blockInstanceId` and `token`
 * are not on `BlockAppClient` at all (see `client.ts`), and mixing the two
 * sources would let a mid-flight `TOKEN_REFRESH` produce a value pair that never
 * existed together.
 */
function readSnapshot(): BlockContextValue {
  const s = getSnapshot();
  return {
    ready: s.ready,
    viewer: s.viewer,
    context: s.context as BlockContext,
    settings: s.settings,
    theme: s.theme,
    blockInstanceId: s.blockInstanceId,
    token: s.token,
  };
}

/**
 * The viewer, the slot context, the settings, the theme and whether the host
 * has answered yet.
 *
 * Re-renders on the transport's own change notification, which fires on
 * BLOCK_INIT, on a theme switch and on every token rotation.
 *
 * 🔴 THE PRE-HANDSHAKE `theme` IS A SENTINEL, NOT A READING. Before BLOCK_INIT
 * lands there is no host to ask, so `EMPTY_SNAPSHOT.theme` is `'light'` for
 * EVERY viewer — indistinguishable from a host that really is light. Nothing
 * may paint from it; `bootThemeGuess()` in `App.tsx` exists for exactly that
 * pre-ready window and explains why.
 */
export function useBlockContext(): BlockContextValue {
  const [value, setValue] = useState<BlockContextValue>(readSnapshot);

  useEffect(() => {
    let cancelled = false;
    // Subscribe FIRST, then re-read: a handshake that lands between the initial
    // `useState` read and this effect would otherwise be missed entirely, and
    // the block would sit on `ready: false` forever with a host on the line.
    const off = getPlatformTransport().snapshot.subscribe(() => {
      if (!cancelled) setValue(readSnapshot());
    });
    setValue(readSnapshot());
    // `initialize()` is what sends BLOCK_READY, so nothing arrives until some
    // caller starts the handshake. Starting it here makes this hook sufficient
    // on its own rather than dependent on a data call happening to run first.
    void getClient().catch(() => {
      /* no host answered; the block renders its signed-out/empty state */
    });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  return value;
}

/** The publisher + viewer settings the host sent at BLOCK_INIT. */
export function useBlockSettings(): BlockSettings {
  return useBlockContext().settings;
}

/* ------------------------------------------------------------------ *
 *  Iframe height
 * ------------------------------------------------------------------ */

/**
 * Keeps the iframe as tall as `ref`.
 *
 * The host owns the frame's height, so the block has to report its own. The SDK
 * runs the ResizeObserver and the de-duplication (`host.autoResize`); this only
 * binds it to the element and to the component's lifetime.
 */
export function useBlockResize(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let stop: (() => void) | undefined;
    let cancelled = false;

    void getClient()
      .then((app) => {
        if (cancelled) return;
        stop = app.host.autoResize(element);
      })
      .catch(() => {
        /* no host to resize for; the page sizes itself */
      });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [ref]);
}

/* ------------------------------------------------------------------ *
 *  Generation
 * ------------------------------------------------------------------ */

export interface UseBuzzWorkflow {
  estimate: (body: WorkflowBody) => Promise<BlockWorkflowSnapshot>;
  submit: (
    body: WorkflowBody,
    options?: { idempotencyKey?: string },
  ) => Promise<BlockWorkflowSnapshot>;
  poll: (workflowId: string) => Promise<BlockWorkflowSnapshot>;
  cancel: (workflowId: string) => Promise<BlockWorkflowSnapshot>;
  status: WorkflowStatus;
  result: BlockWorkflowSnapshot | null;
  error: Error | null;
}

/**
 * The generation lifecycle, over the `/api/v1/blocks/workflows/*` routes.
 *
 * The state machine is the bridge hook's, unchanged, because the block reads it:
 * `status` drives the CTA's "estimating" copy, and `result` is where the money
 * predicate reads the settled snapshot from.
 *
 * 🔴 EVERY ARM PUBLISHES `result` BEFORE IT REJECTS. `App.tsx` may classify from
 * `result` rather than from the returned value, so a throw that jumped over the
 * assignment would leave the PREVIOUS call's snapshot in place — a live control
 * on a money path quoting the wrong number, which is strictly worse than no
 * control. Assigning first also preserves the fail-CLOSED property: the
 * cost-less snapshot overwrites the priced one.
 */
export function useBuzzWorkflow(): UseBuzzWorkflow {
  const [status, setStatus] = useState<WorkflowStatus>('idle');
  const [result, setResult] = useState<BlockWorkflowSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const client: WorkflowClient = useMemo(() => createWorkflowClient(), []);

  const estimate = useCallback(
    async (body: WorkflowBody) => {
      setError(null);
      setStatus('estimating');
      try {
        const snapshot = await client.estimate(body);
        setResult(snapshot);
        setStatus('confirming');
        return snapshot;
      } catch (err) {
        // The rejection carries the snapshot when there is one — a refused
        // estimate's price is what the top-up CTA is derived from, so it must
        // reach `result` even though this call failed.
        const snapshot = (err as { snapshot?: BlockWorkflowSnapshot } | null)?.snapshot;
        if (snapshot) setResult(snapshot);
        setError(err as Error);
        setStatus('error');
        throw err;
      }
    },
    [client],
  );

  const submit = useCallback(
    async (body: WorkflowBody, options?: { idempotencyKey?: string }) => {
      setError(null);
      setStatus('submitting');
      try {
        const snapshot = await client.submit(body, options);
        setResult(snapshot);
        setStatus(TERMINAL_STATUSES.has(snapshot.status) ? 'done' : 'polling');
        return snapshot;
      } catch (err) {
        const snapshot = (err as { snapshot?: BlockWorkflowSnapshot } | null)?.snapshot;
        if (snapshot) setResult(snapshot);
        setError(err as Error);
        setStatus('error');
        throw err;
      }
    },
    [client],
  );

  const poll = useCallback(
    async (workflowId: string) => {
      setStatus('polling');
      try {
        const snapshot = await client.poll(workflowId);
        setResult(snapshot);
        if (TERMINAL_STATUSES.has(snapshot.status)) setStatus('done');
        return snapshot;
      } catch (err) {
        setError(err as Error);
        setStatus('error');
        throw err;
      }
    },
    [client],
  );

  const cancel = useCallback(
    async (workflowId: string) => {
      try {
        const snapshot = await client.cancel(workflowId);
        setResult(snapshot);
        setStatus('done');
        return snapshot;
      } catch (err) {
        // A cancel that fails (the workflow already finished, a transient
        // server error) is surfaced but must not wedge the hook — the block
        // treats cancel as best-effort and still clears its own card.
        setError(err as Error);
        throw err;
      }
    },
    [client],
  );

  return { estimate, submit, poll, cancel, status, result, error };
}

/* ------------------------------------------------------------------ *
 *  Money
 * ------------------------------------------------------------------ */

export interface UseBuzzBalance {
  /** `null` until the first successful fetch. NEVER cleared by a later failure. */
  balance: BuzzBalance | null;
  loading: boolean;
  error: Error | null;
  refetch: () => void;
}

/**
 * The signed-in viewer's per-pool Buzz balance, from `GET /api/v1/blocks/buzz`.
 *
 * 🔴 A FAILED REFETCH LEAVES THE LAST GOOD FIGURE IN PLACE. `App.tsx` treats
 * `balance === null` as "we have never known", which is the only case its spend
 * predicate fails toward NOT-a-shortfall on; nulling on error would blank a
 * genuine shortfall's top-up CTA for the length of a round trip and put the
 * Generate button back beside a card still reading "spend limit".
 *
 * Latest-wins: a reply superseded by a newer `refetch`, or one landing after
 * unmount, is dropped. A bare mount check would let a slow superseded reply
 * overwrite newer state.
 */
export function useBuzzBalance(): UseBuzzBalance {
  const [balance, setBalance] = useState<BuzzBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const seq = useRef(0);

  useEffect(
    () => () => {
      // Invalidate every in-flight request on unmount.
      seq.current += 1;
    },
    [],
  );

  const refetch = useCallback(() => {
    seq.current += 1;
    const token = seq.current;
    setLoading(true);
    setError(null);
    fetchBuzzBalance()
      .then((next) => {
        if (seq.current !== token) return;
        setBalance(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (seq.current !== token) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setLoading(false);
      });
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return { balance, loading, error, refetch };
}

export interface UseBuzzPurchase {
  openPurchaseModal: (
    suggestedAmount?: number,
  ) => Promise<{ purchased: boolean; newBalance?: number }>;
}

/**
 * Opens civitai's own Buzz purchase modal — genuine host UI, so it stays on the
 * bridge (`OPEN_BUZZ_PURCHASE`, one of the four requests `@civitai/sdk`'s
 * `HostRequests` carries). The insufficient-budget recovery path.
 *
 * ⚠️ `newBalance` IS NO LONGER REPORTED. The bridge reply carried it; the SDK's
 * `host.openBuzzPurchase` projects the reply down to `{ purchased }`. The block
 * refetches the balance after a purchase rather than reading it off the reply,
 * so the field is absent rather than wrong — but a caller that depended on it
 * would now read `undefined`. Documented in README → "Known gaps".
 */
export function useBuzzPurchase(): UseBuzzPurchase {
  const openPurchaseModal = useCallback(async (suggestedAmount?: number) => {
    const app = await getClient();
    const { purchased } = await app.host.openBuzzPurchase(
      suggestedAmount != null ? { suggestedAmount } : {},
    );
    return { purchased };
  }, []);
  return { openPurchaseModal };
}

/* ------------------------------------------------------------------ *
 *  Checkpoint picker
 * ------------------------------------------------------------------ */

export interface UseCheckpointPicker {
  open: (opts: {
    baseModelGroup: string;
    currentVersionId?: number;
  }) => Promise<{ selected?: BlockCheckpointInfo }>;
  persist: (versionId: number | null) => Promise<void>;
}

/**
 * Drives civitai's Checkpoint picker.
 *
 * `open` goes over the bridge — it is host UI, and `OPEN_RESOURCE_PICKER` is one
 * of the four requests `@civitai/sdk` carries. The bridge op it replaces was
 * `OPEN_CHECKPOINT_PICKER`; the resource picker filtered to `'Checkpoint'` in
 * the same ecosystem is the sanctioned equivalent, and `PickedResource` is a
 * superset of `BlockCheckpointInfo`.
 *
 * ⚠️ TWO DELIBERATE, DOCUMENTED LOSSES ON THIS TRANSPORT — both in README →
 * "Known gaps on the SDK transport":
 *
 * 1. `currentVersionId` is accepted and DROPPED. `OPEN_RESOURCE_PICKER`'s params
 *    are `{ resourceType, baseModelGroup? }` only, so the picker can no longer
 *    pre-highlight the current choice. Cosmetic; the parameter is kept in the
 *    signature so the call site (and the day the SDK grows the field) needs no
 *    change.
 *
 * 2. 🔴 `persist` IS A NO-OP. The bridge wrote the viewer's override into
 *    `block_user_settings` via `SET_USER_CHECKPOINT`. `@civitai/sdk` does not
 *    carry that request, and there is NO REST route for block user settings —
 *    the block REST surface under `/api/v1/blocks/` has no user-settings
 *    endpoint at all (enumerated 2026-09-24). Sending the raw message through
 *    `transport.request` is worse than not sending it: the SDK derives a reply
 *    type of `SET_USER_CHECKPOINT_RESULT` while the host answers
 *    `USER_CHECKPOINT_SET`, and the SDK transport imposes no timeout, so the
 *    promise would hang forever and the block's optimistic label would never
 *    settle.
 *
 *    So: a checkpoint swap still applies immediately and lasts the session (the
 *    block's own `localCheckpoint`), and is LOST on remount, falling back to the
 *    publisher default. It resolves rather than rejects deliberately — rejecting
 *    would fire the call site's rollback and show an error banner on every
 *    swap, which is a worse regression than losing cross-session persistence.
 */
export function useCheckpointPicker(): UseCheckpointPicker {
  const open = useCallback(
    async (opts: { baseModelGroup: string; currentVersionId?: number }) => {
      const app = await getClient();
      const selected = await app.host.openResourcePicker({
        resourceType: 'Checkpoint',
        baseModelGroup: opts.baseModelGroup,
      });
      if (!selected) return {};
      return {
        selected: {
          versionId: selected.versionId,
          modelId: selected.modelId,
          modelName: selected.modelName,
          versionName: selected.versionName,
          baseModel: selected.baseModel,
        } satisfies BlockCheckpointInfo,
      };
    },
    [],
  );

  const persist = useCallback(async (versionId: number | null) => {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.debug(
        '[gfm] checkpoint persist is a no-op on the @civitai/sdk transport',
        { versionId },
      );
    }
  }, []);

  return { open, persist };
}
