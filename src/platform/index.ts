// The block's platform seam.
//
// Everything this block needs from the Civitai platform comes through here, and
// only this directory imports `@civitai/sdk`. That is the point: `App.tsx` is
// written against these names, so moving transports again means changing this
// directory, not the block.
//
// What lives behind it:
//   - `hooks.ts`     the hooks `App.tsx` calls, with their old signatures
//   - `workflows.ts` the generation path, over `/api/v1/blocks/workflows/*`
//   - `buzz.ts`      the balance read, over `/api/v1/blocks/buzz`
//   - `client.ts`    the one `initialize()` handshake, shared
//   - `testing.ts`   a fake host + fake server, for this directory's own tests

export {
  getClient,
  getPlatformTransport,
  getSnapshot,
  __configurePlatform,
  type PlatformOverrides,
} from './client.js';

export { fetchBuzzBalance, type BuzzBalance } from './buzz.js';

export {
  createWorkflowClient,
  generateIdempotencyKey,
  HOST_SYNTHESISED_WORKFLOW_ID,
  TERMINAL_STATUSES,
  WorkflowEstimateError,
  WorkflowSubmitError,
  type WorkflowClient,
  type WorkflowEstimateErrorCode,
  type WorkflowSubmitErrorCode,
} from './workflows.js';

export {
  useBlockContext,
  useBlockResize,
  useBlockSettings,
  useBuzzBalance,
  useBuzzPurchase,
  useBuzzWorkflow,
  useCheckpointPicker,
  type BlockContextValue,
  type UseBuzzBalance,
  type UseBuzzPurchase,
  type UseBuzzWorkflow,
  type UseCheckpointPicker,
} from './hooks.js';
