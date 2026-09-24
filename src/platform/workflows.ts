// The block's generation path, over REST.
//
// This is the port's substance. The block used to reach the orchestrator
// through the host's postMessage bridge (`useBuzzWorkflow()` →
// `ESTIMATE_WORKFLOW`, `SUBMIT_WORKFLOW`, `POLL_WORKFLOW`, `CANCEL_WORKFLOW`).
// It now calls the public routes under `/api/v1/blocks/workflows/*` directly,
// authenticated with the block token `@civitai/sdk` already holds.
//
// Why the behaviour is meant to be unchanged: each REST route is a thin adapter
// over the SAME tRPC procedure its bridge op called — `estimate` →
// `blocks.estimateWorkflow`, `submit` → `blocks.submitWorkflow`, and so on — so
// the budget ceiling, the reservation, the idempotency claim, the maturity
// clamp, the ownership gates and the rate-limit buckets are all the same code.
// What changed is the wire, not the policy. (Read the route files in
// `civitai/civitai` under `src/pages/api/v1/blocks/workflows/` — each one's
// docblock states the request shape, the `{ snapshot }` response and the
// resolve-vs-throw error contract this module is written against.)
//
// 🔴 NOT VERIFIED AGAINST PRODUCTION. Those four routes are merged in
// `civitai/civitai` (2a2eb0fe2f, #5068) but NOT DEPLOYED: as of 2026-09-24
// all four answer `404 text/html` on civitai.com, where a deployed block route
// answers `401 {"error":"Block token required"}` in JSON. Everything here is
// written against the routes' committed contract and covered against a fake
// server in `testing.ts`. See README → "Known gaps on the SDK transport".

import { ApiError } from '@civitai/sdk';
import type { BlockWorkflowSnapshot, WorkflowBody } from '@civitai/app-sdk/blocks';

import { getClient } from './client.js';

/** The four REST routes, under `@civitai/sdk`'s `/api/v1` base. */
const BASE = 'blocks/workflows';

/**
 * Terminal workflow statuses — a workflow in one of these will never move
 * again, so a watcher stops.
 *
 * Spelled here rather than imported because the blocks-react bridge package
 * owned the old copy and this port removes that dependency. The set is the
 * server's: `TERMINAL_BLOCK_WORKFLOW_STATUSES` in `civitai/civitai`.
 */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'succeeded',
  'failed',
  'expired',
  'canceled',
]);

/**
 * The `workflowId` a HOST-SYNTHESISED failure snapshot carries.
 *
 * 🔴 ON THE BRIDGE THIS WAS A WIRE INVARIANT; ON REST IT IS OURS. The host's
 * `failureSnapshot()` stamped this literal on every reply it built itself,
 * because a postMessage reply cannot reject. Over REST a thrown procedure is a
 * non-2xx instead — nothing on the wire carries this id any more — so
 * `snapshotFromApiError()` below stamps it, preserving the ONE observable the
 * app's `WorkflowSubmitError.code` branch turns on. Compare with `===`: every
 * looser comparison reclassifies a server-built reply into the reassuring
 * "nothing was charged" arm.
 */
export const HOST_SYNTHESISED_WORKFLOW_ID = 'failed';

/** Which producer an unusable estimate came from. See {@link WorkflowEstimateError}. */
export type WorkflowEstimateErrorCode = 'failed' | 'no-cost';

/** Which producer an unusable submit came from. See {@link WorkflowSubmitError}. */
export type WorkflowSubmitErrorCode = 'exception' | 'workflow-failed';

/**
 * Thrown by `estimate()` when the reply does not carry a usable price — either
 * because the estimate ERRORED, or because it came back without a numeric
 * `cost.total`.
 *
 * Ported from the blocks-react bridge package unchanged in shape and in
 * meaning, because `App.tsx` branches on `err instanceof WorkflowEstimateError`
 * and on `err.code`. Those two reads are the contract; this class exists to keep them
 * true across the transport swap.
 *
 * - `'failed'`  — the reply's `status` is `'failed'`. Either the procedure threw
 *   server-side (now a non-2xx, translated below) or the orchestrator itself
 *   reported the whatIf as failed, which CAN carry a numeric `cost`. Both are
 *   rejected: a failed estimate is not a quote you may spend against.
 * - `'no-cost'` — a NON-failed reply with no numeric `cost.total`.
 *
 * 🔴 `snapshot.error` IS SERVER-AUTHORED AND UNSANITISED — log it, never render
 * it verbatim. `message` is developer-facing and its wording is not a contract;
 * derive viewer-facing copy from `code`.
 */
export class WorkflowEstimateError extends Error {
  readonly code: WorkflowEstimateErrorCode;
  readonly snapshot: BlockWorkflowSnapshot;

  constructor(snapshot: BlockWorkflowSnapshot, code: WorkflowEstimateErrorCode) {
    super(`estimate did not return a usable price (${code}) — reason on .snapshot.error`);
    this.name = 'WorkflowEstimateError';
    this.code = code;
    this.snapshot = snapshot;
  }
}

/**
 * Thrown by `submit()` when the reply is failure-shaped AND carries no price.
 *
 * 🔴 A BUDGET REJECTION NEVER ARRIVES HERE — it RESOLVES, and the block reads it
 * off the returned snapshot as `status === 'failed'` with a numeric
 * `cost.total`. That is the top-up recovery path and the reason the guard tests
 * `typeof cost.total !== 'number'` rather than `status === 'failed'` alone. The
 * REST route preserves it deliberately: `submit.ts`'s docblock states that a
 * budget rejection is a RESOLVED procedure and therefore a 200, precisely so
 * this distinction survives the wire.
 *
 * - `'exception'` — no workflow to report. USUALLY nothing was queued and
 *   nothing charged, but a lost response or an in-flight idempotency conflict
 *   reaches the same shape, so do not promise the viewer nothing was charged.
 * - `'workflow-failed'` — a server-built reply. A resolved submit is
 *   money-COMMITTED server-side, so Buzz may already be spent. Reuse the same
 *   `idempotencyKey` on any retry.
 */
export class WorkflowSubmitError extends Error {
  readonly code: WorkflowSubmitErrorCode;
  readonly snapshot: BlockWorkflowSnapshot;

  constructor(snapshot: BlockWorkflowSnapshot, code: WorkflowSubmitErrorCode) {
    super(`submit did not return a usable workflow (${code}) — reason on .snapshot.error`);
    this.name = 'WorkflowSubmitError';
    this.code = code;
    this.snapshot = snapshot;
  }
}

/**
 * A stable-charset idempotency key.
 *
 * 🔴 THE CHARSET IS A SERVER CONSTRAINT, NOT A STYLE CHOICE. `submit.ts` bounds
 * the field with `/^[A-Za-z0-9_-]{1,64}$/` and 400s anything else, so both arms
 * below stay inside `[A-Za-z0-9_-]`: a UUID is hex plus hyphens, and the
 * fallback is base36 plus hyphens.
 */
export function generateIdempotencyKey(): string {
  const c: Crypto | undefined =
    typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

/**
 * Turn a transport/server failure into the failure SNAPSHOT the bridge used to
 * deliver.
 *
 * 🔴 THIS IS THE ONE PLACE THE TWO TRANSPORTS GENUINELY DIFFER, AND THE WHOLE
 * REASON IT EXISTS IS TO HIDE THAT DIFFERENCE FROM `App.tsx`. On the bridge a
 * server-side throw could not reject across `postMessage`, so the host posted a
 * well-formed reply carrying `failureSnapshot(err)` — `{ workflowId: 'failed',
 * status: 'failed', error: '<server message>' }`, with no `cost`. Over REST the
 * same throw is a NON-2xx and the SDK's http client raises `ApiError`. Left
 * alone, that would reach `App.tsx` as a plain `Error`, `instanceof
 * WorkflowEstimateError` would be false, and every estimate/submit failure
 * would fall out of the block's classified error handling into its generic
 * catch — losing the top-up CTA and the retry copy. So a non-2xx is rebuilt
 * into the snapshot shape the block already knows how to read.
 *
 * The `error` string is the server's own message, which `@civitai/sdk`'s http
 * client already extracts from both the `{ error }` and `{ message }` envelopes
 * these routes use.
 */
function snapshotFromApiError(err: unknown): BlockWorkflowSnapshot {
  const message =
    err instanceof ApiError
      ? err.message
      : err instanceof Error
        ? err.message
        : String(err);
  return {
    workflowId: HOST_SYNTHESISED_WORKFLOW_ID,
    status: 'failed',
    error: message,
  };
}

/**
 * Reject a malformed 2xx.
 *
 * A 200 whose body carries no `snapshot.status` is not a result: returning it
 * would make a caller's terminal test (`TERMINAL_STATUSES.has(status)`) read
 * `undefined` and loop forever against a server answering with nothing.
 */
function requireSnapshot(reply: { snapshot?: BlockWorkflowSnapshot }, what: string): BlockWorkflowSnapshot {
  const snapshot = reply?.snapshot;
  if (!snapshot || typeof snapshot.status !== 'string') {
    throw new Error(`${what}: malformed response (no snapshot)`);
  }
  return snapshot;
}

/** The subset of the workflow surface this block uses. No `watch` — it owns its own loop. */
export interface WorkflowClient {
  estimate(body: WorkflowBody): Promise<BlockWorkflowSnapshot>;
  submit(body: WorkflowBody, opts?: { idempotencyKey?: string }): Promise<BlockWorkflowSnapshot>;
  poll(workflowId: string, opts?: { waitSeconds?: number }): Promise<BlockWorkflowSnapshot>;
  cancel(workflowId: string): Promise<BlockWorkflowSnapshot>;
}

/** Stateless; every method awaits the client singleton, so the handshake happens once. */
export function createWorkflowClient(): WorkflowClient {
  return {
    async estimate(body) {
      const app = await getClient();
      let snapshot: BlockWorkflowSnapshot;
      try {
        snapshot = requireSnapshot(
          await app.site.post<{ snapshot: BlockWorkflowSnapshot }>(`${BASE}/estimate`, { body }),
          'estimate',
        );
      } catch (err) {
        // A non-2xx is the REST twin of the host's `failureSnapshot` reply — see
        // `snapshotFromApiError`. A malformed 2xx is NOT: it has no server
        // message to carry and no failure the block can classify, so it
        // propagates as itself.
        if (!(err instanceof ApiError)) throw err;
        throw new WorkflowEstimateError(snapshotFromApiError(err), 'failed');
      }
      // 🔴 TWO PRODUCERS OF "resolved, but no usable price", and keying on
      // `status` alone would leave the second resolving:
      //   (a) `status:'failed'` — the estimate did not succeed. Rejected whether
      //       or not a number came back with it: a failed estimate is not a
      //       quote you may spend against.
      //   (b) a non-failed reply whose `cost.total` is not a number — the
      //       server's `snapshotFromWorkflow` OMITS `cost` entirely when the
      //       whatIf reply has no numeric total.
      // `typeof … === 'number'`, never truthiness: `0` is a real price (a cache
      // hit) and is falsy.
      if (snapshot.status === 'failed') throw new WorkflowEstimateError(snapshot, 'failed');
      if (typeof snapshot.cost?.total !== 'number') {
        throw new WorkflowEstimateError(snapshot, 'no-cost');
      }
      return snapshot;
    },

    async submit(body, opts) {
      const app = await getClient();
      // Reuse a caller-supplied stable key across a retry (→ one Buzz charge),
      // or mint a fresh one per call (each call is a new logical submit).
      // REQUIRED by the route, unlike the bridge input it forwards to.
      const idempotencyKey = opts?.idempotencyKey ?? generateIdempotencyKey();
      let snapshot: BlockWorkflowSnapshot;
      try {
        snapshot = requireSnapshot(
          await app.site.post<{ snapshot: BlockWorkflowSnapshot }>(`${BASE}/submit`, {
            body,
            idempotencyKey,
          }),
          'submit',
        );
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        // `'exception'` — the block has no workflow to report. That is NOT the
        // same as "nothing happened": a lost response can carry a workflow that
        // was created and charged, which is why the app must reuse the key on
        // retry rather than mint a new one.
        throw new WorkflowSubmitError(snapshotFromApiError(err), 'exception');
      }
      // 🔴 BOTH CLAUSES ARE LOAD-BEARING. Dropping `status === 'failed'` would
      // reject every ordinary in-flight reply (`{status:'pending'}` is cost-less
      // too); dropping the cost test would reject the BUDGET REJECTION, which is
      // the one outcome the top-up flow recovers from. And `status === 'failed'`
      // rather than `TERMINAL_STATUSES.has(status)`: cost-less
      // `succeeded`/`canceled`/`expired` replies are legitimate outcomes.
      if (snapshot.status === 'failed' && typeof snapshot.cost?.total !== 'number') {
        throw new WorkflowSubmitError(
          snapshot,
          snapshot.workflowId === HOST_SYNTHESISED_WORKFLOW_ID ? 'exception' : 'workflow-failed',
        );
      }
      return snapshot;
    },

    async poll(workflowId, opts) {
      const app = await getClient();
      const waitSeconds = opts?.waitSeconds;
      return requireSnapshot(
        await app.site.post<{ snapshot: BlockWorkflowSnapshot }>(`${BASE}/poll`, {
          workflowId,
          // Omitted rather than sent as 0 when long polling is off: the route's
          // `resolveBlockPollWaitSeconds` floors first, so `0` and any fraction
          // below 1 mean "no hold" anyway, and omitting keeps the body the same
          // shape a pre-long-poll block sent.
          ...(waitSeconds !== undefined && waitSeconds > 0 ? { waitSeconds } : {}),
        }),
        `poll(${workflowId})`,
      );
    },

    async cancel(workflowId) {
      const app = await getClient();
      return requireSnapshot(
        await app.site.post<{ snapshot: BlockWorkflowSnapshot }>(`${BASE}/cancel`, { workflowId }),
        `cancel(${workflowId})`,
      );
    },
  };
}
