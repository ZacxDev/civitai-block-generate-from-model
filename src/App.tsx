import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import {
  useBlockContext,
  useBlockResize,
  useBlockSettings,
  useBuzzPurchase,
  useBuzzWorkflow,
  useCheckpointPicker,
} from '@civitai/blocks-react';
import type {
  BlockCheckpointInfo,
  BlockContext,
  BlockWorkflowSnapshot,
  ModelSlotContext,
  ShowcaseImage,
  WorkflowStatus,
} from '@civitai/app-sdk/blocks';

/**
 * Generate from this model.
 *
 * The model on the sidebar context is pre-loaded; the user types an optional
 * short prompt and taps Generate. The block reads the publisher-configured
 * `buzz_budget_per_gen` from settings, calls the orchestrator via
 * `useBuzzWorkflow`, and renders the result inline.
 *
 * Anti-patterns avoided:
 * - No model picker (the whole point — the model IS the page)
 * - No sampler / seed / CFG sliders by default (publisher toggles `show_advanced`)
 * - No prompt-required gate — empty prompt uses the model's trigger phrase
 *   via server-side defaulting
 */
export function App() {
  const { ready, context, viewer, theme } = useBlockContext();
  const settings = useBlockSettings();
  const { submit, estimate, poll, status, result, error } = useBuzzWorkflow();
  const { openPurchaseModal } = useBuzzPurchase();
  const checkpointPicker = useCheckpointPicker();
  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);

  const [prompt, setPrompt] = useState('');
  // Mirror the host-supplied checkpoint locally so the UI updates the
  // instant the user picks a new one. The host re-resolves at submit
  // time anyway — this is just for the label-in-the-header.
  const [localCheckpoint, setLocalCheckpoint] = useState<BlockCheckpointInfo | null>(null);
  const [checkpointError, setCheckpointError] = useState<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Selected showcase image index. Drives the prompt + gen params for
  // submit/estimate. Defaults to 0 in the carousel-mount effect below
  // (deferred because BlockInit might land before showcaseImages does).
  const [selectedShowcaseIdx, setSelectedShowcaseIdx] = useState<number | null>(null);
  // Estimated cost (yellow buzz) for the current params. Pulled from
  // estimate() snapshot, refreshed on mount + when the model identity
  // (checkpoint or selected showcase) changes.
  const [estimatedCost, setEstimatedCost] = useState<number | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);
  const estimateInFlightRef = useRef(0);

  // useBuzzWorkflow().submit() returns the initial snapshot but the hook
  // doesn't auto-poll — it's the caller's job to drive poll(workflowId)
  // until a terminal status. Without this effect the block sits at
  // status='polling' with the initial 'pending' snapshot forever.
  //
  // The hook flips status out of 'polling' itself when a terminal-status
  // snapshot lands, so the dep array catches the transition and the
  // cleanup tears the timer down.
  useEffect(() => {
    if (status !== 'polling') return;
    const workflowId = result?.workflowId;
    if (!workflowId) return;

    // Adaptive backoff. Cached Flux returns in <10s; cold paths take
    // 30-60s. Fast initial polls catch the cached case quickly, then
    // back off so a long-running cold workflow doesn't hammer the host.
    const SCHEDULE_MS = [2000, 2000, 3000, 5000, 8000];
    let attempt = 0;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      // Don't burn poll budget while the tab is hidden — the
      // visibilitychange listener re-arms when the user comes back.
      if (typeof document !== 'undefined' && document.hidden) {
        pollTimerRef.current = null;
        return;
      }
      try {
        await poll(workflowId);
      } catch {
        // Transient host/orchestrator errors during polling — keep going.
        // The hook flips status to 'error' on its own only after the
        // workflow itself reaches a terminal failure; mid-poll
        // network/5xx hiccups are recoverable.
      }
      if (cancelled) return;
      const delay = SCHEDULE_MS[Math.min(attempt, SCHEDULE_MS.length - 1)];
      attempt += 1;
      pollTimerRef.current = setTimeout(tick, delay);
    };

    // Leading edge — fire immediately so a workflow that's already
    // succeeded by the time submit() returns gets its result on the
    // next microtask.
    pollTimerRef.current = setTimeout(tick, 0);

    const onVisibility = () => {
      if (cancelled || document.hidden) return;
      // Resume only when no timer is armed (the tick handler nulled it
      // out when it bailed on the hidden check). Avoids double-firing
      // if the visibilitychange races with a scheduled tick.
      if (pollTimerRef.current == null) {
        pollTimerRef.current = setTimeout(tick, 0);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      if (pollTimerRef.current != null) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [status, result?.workflowId, poll]);

  // Derive showcase/checkpoint via a partial cast so we can run the
  // mount-defaults + auto-estimate effects unconditionally above the
  // early returns. Effects can't sit below them or React will complain
  // about hook order on the !ready re-render.
  const modelCtxRead = context as Partial<ModelSlotContext>;
  const showcaseImages: ShowcaseImage[] = modelCtxRead.showcaseImages ?? [];
  const selectedShowcase =
    selectedShowcaseIdx != null ? showcaseImages[selectedShowcaseIdx] ?? null : null;
  const effectiveCheckpointVersionIdForEstimate =
    (localCheckpoint ?? modelCtxRead.checkpoint ?? null)?.versionId ?? null;

  // Default-select the first showcase image once the host's query lands
  // (showcaseImages may be empty on first render and populate later when
  // BLOCK_INIT delivers them).
  useEffect(() => {
    if (selectedShowcaseIdx != null) return;
    if (showcaseImages.length === 0) return;
    setSelectedShowcaseIdx(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showcaseImages.length]);

  // Populate the prompt input from the selected showcase image's meta.
  // The user can still edit afterward — this only fires on showcase
  // selection change, not every render. Empty meta leaves the input
  // alone so a partial-meta showcase doesn't clobber a typed prompt.
  useEffect(() => {
    if (selectedShowcase?.prompt) {
      setPrompt(selectedShowcase.prompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedShowcaseIdx]);

  // Auto-estimate on mount + whenever the model identity changes
  // (checkpoint swap, or showcase pick — both change cost via the
  // resolved params). NOT debounced on prompt edits: prompt length
  // doesn't move cost enough to be worth a round-trip per keystroke.
  useEffect(() => {
    const modelId = modelCtxRead.modelId;
    const modelVersionId = modelCtxRead.modelVersionId;
    if (!modelId || !modelVersionId) return;
    if (!effectiveCheckpointVersionIdForEstimate) return;
    // Race guard — if a faster query lands while a slower one is in
    // flight, only the latest result wins.
    const myId = ++estimateInFlightRef.current;
    estimate({
      kind: 'textToImage',
      modelId,
      modelVersionId,
      params: buildSubmitParams(prompt, '' /* suffix */, selectedShowcase),
    })
      .then((snap) => {
        if (myId !== estimateInFlightRef.current) return;
        const cost = snap.cost?.total;
        setEstimatedCost(typeof cost === 'number' ? cost : null);
        setEstimateError(null);
      })
      .catch((err) => {
        if (myId !== estimateInFlightRef.current) return;
        setEstimateError(err instanceof Error ? err.message : 'estimate failed');
        setEstimatedCost(null);
      });
    // Intentionally narrow deps: re-estimate on checkpoint OR showcase
    // change, NOT on prompt edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    modelCtxRead.modelId,
    modelCtxRead.modelVersionId,
    effectiveCheckpointVersionIdForEstimate,
    selectedShowcaseIdx,
  ]);

  if (!ready) {
    return (
      <div ref={rootRef} style={loadingStyle}>
        Loading…
      </div>
    );
  }

  const model = asModelContext(context);
  if (!model) {
    return (
      <div ref={rootRef} style={containerStyle(theme)}>
        <p style={errorTextStyle}>
          This block expects a model-page slot. Current slot: <code>{context.slotId}</code>
        </p>
      </div>
    );
  }

  if (!viewer) {
    return (
      <div ref={rootRef} style={containerStyle(theme)}>
        <Header model={model} />
        <p style={subtleStyle}>Sign in to generate.</p>
      </div>
    );
  }

  if (viewer.status === 'banned' || viewer.status === 'muted') {
    return (
      <div ref={rootRef} style={containerStyle(theme)}>
        <Header model={model} />
        <p style={subtleStyle}>
          Account status is <strong>{viewer.status}</strong>. Generation is unavailable.
        </p>
      </div>
    );
  }

  const budget = readNumber(settings.publisherSettings.buzz_budget_per_gen, 10);
  const suffix = readString(settings.publisherSettings.default_prompt_suffix, '');
  const showAdvanced = readBoolean(settings.publisherSettings.show_advanced, false);

  // The host computes the effective checkpoint (publisher default ∪ viewer
  // override) before BLOCK_INIT. localCheckpoint shadows it for instant UI
  // updates after a picker swap; falls back to the BLOCK_INIT value at mount.
  const effectiveCheckpoint: BlockCheckpointInfo | null =
    localCheckpoint ?? model.checkpoint ?? null;
  // For Checkpoint-bound installs the picker is suppressed — the model IS
  // the anchor and there's nothing to change. For LoRA installs we always
  // show the [Change] button next to the current checkpoint label.
  const showCheckpointPicker = model.modelType !== 'Checkpoint';

  const handleChangeCheckpoint = async () => {
    setCheckpointError(null);
    // baseModelGroup: the host expands this into the exact baseModel filter.
    // We pass the LoRA's own baseModel; the host collapses to the ecosystem
    // family so Flux.1 D / Flux.1 S etc. all resolve to 'Flux1'.
    const baseModelGroup =
      effectiveCheckpoint?.baseModel ?? model.modelType /* fallback only */;
    try {
      const { selected } = await checkpointPicker.open({
        baseModelGroup,
        ...(effectiveCheckpoint ? { currentVersionId: effectiveCheckpoint.versionId } : {}),
      });
      if (!selected) return; // user dismissed
      // Optimistic: update the label immediately. Then persist server-side.
      setLocalCheckpoint(selected);
      try {
        await checkpointPicker.persist(selected.versionId);
      } catch (err) {
        // Persist failed (e.g. wrong-ecosystem) — surface to user and roll
        // back the optimistic update.
        setLocalCheckpoint(null);
        setCheckpointError(err instanceof Error ? err.message : 'could not save checkpoint');
      }
    } catch (err) {
      setCheckpointError(err instanceof Error ? err.message : 'picker failed');
    }
  };

  // `confirming` is "estimate landed, user reviewing cost" — Generate must
  // stay clickable in that state, otherwise auto-estimate on mount locks
  // the button forever. SDK transitions confirming → submitting on click.
  const busy: WorkflowStatus[] = ['estimating', 'submitting', 'polling'];
  const isBusy = busy.includes(status);

  const handleGenerate = async () => {
    try {
      await submit({
        kind: 'textToImage',
        modelId: model.modelId,
        modelVersionId: model.modelVersionId,
        // Use the same param-builder as the estimate effect so cost shown
        // pre-click matches cost charged at submit. The host still
        // re-validates everything server-side; this is just for parity.
        params: buildSubmitParams(prompt, suffix, selectedShowcase),
      });
    } catch {
      // Surface via `error` in render; nothing to do here.
    }
  };

  // The platform returns Buzz-budget rejection as a workflow `error` snapshot
  // or via the `error` ref. Sniff for budget/insufficient-funds language to
  // surface the top-up CTA. (No structured error.code field today.)
  const errMessage = (error?.message ?? result?.error ?? '').toLowerCase();
  const isInsufficient =
    errMessage.includes('insufficient') ||
    errMessage.includes('not enough') ||
    errMessage.includes('budget') ||
    errMessage.includes('balance');

  return (
    <div ref={rootRef} style={containerStyle(theme)}>
      <Header model={model} />

      {showCheckpointPicker && (
        <div style={checkpointRowStyle(theme)}>
          <span style={subtleStyle}>
            Generating with:{' '}
            {effectiveCheckpoint ? (
              <strong>
                {effectiveCheckpoint.modelName}
                {effectiveCheckpoint.versionName ? ` (${effectiveCheckpoint.versionName})` : ''}
              </strong>
            ) : (
              <em>no checkpoint configured</em>
            )}
          </span>
          <button
            type="button"
            onClick={handleChangeCheckpoint}
            style={linkButtonStyle()}
            disabled={isBusy}
          >
            Change
          </button>
        </div>
      )}
      {checkpointError && (
        <p style={errorTextStyle}>Checkpoint: {checkpointError}</p>
      )}

      {showcaseImages.length > 0 && (
        <div>
          <p style={{ ...subtleStyle, marginBottom: 6 }}>
            Remix from a preview image:
          </p>
          <div style={carouselStyle}>
            {showcaseImages.map((img, idx) => (
              <button
                key={img.id}
                type="button"
                aria-label={`Pick preview ${idx + 1}`}
                onClick={() => setSelectedShowcaseIdx(idx)}
                disabled={isBusy}
                style={thumbButtonStyle(idx === selectedShowcaseIdx, theme)}
              >
                <img src={img.url} alt="" style={thumbImageStyle} loading="lazy" />
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input
          aria-label="Prompt (optional)"
          placeholder={`Optional prompt — defaults to ${model.modelName}'s style`}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          style={inputStyle(theme)}
          disabled={isBusy}
        />

        {showAdvanced && <p style={subtleStyle}>(advanced controls — TODO)</p>}

        {(estimatedCost != null || estimateError) && (
          <p style={subtleStyle}>
            {estimateError
              ? `Couldn't estimate cost: ${estimateError}`
              : `Estimated cost: ${estimatedCost} Buzz (budget: ${budget})`}
          </p>
        )}

        <button
          type="button"
          onClick={handleGenerate}
          disabled={isBusy}
          style={primaryButtonStyle()}
        >
          {labelForStatus(status, budget, estimatedCost)}
        </button>
      </div>

      {(error || result?.status === 'failed' || result?.status === 'expired' || result?.status === 'canceled') && (
        <div style={errorBoxStyle}>
          <p style={{ margin: 0 }}>
            {error?.message ?? result?.error ?? 'Generation failed.'}
          </p>
          {isInsufficient && (
            <button
              type="button"
              onClick={() => openPurchaseModal(budget * 10)}
              style={linkButtonStyle()}
            >
              Top up Buzz →
            </button>
          )}
        </div>
      )}

      {/* Gate the intermediate-state label on hook status === 'polling',
          not just snapshot status: the SDK leaves `result` populated with
          the estimate's snapshot (status: 'pending') even before submit,
          which would otherwise show "Queued…" with nothing actually
          queued. 'polling' only sets after submit() returns. */}
      {status === 'polling' &&
        result &&
        (result.status === 'pending' || result.status === 'processing') && (
          <p style={subtleStyle}>
            {result.status === 'pending' ? 'Queued…' : 'Generating…'}
          </p>
        )}

      {result && result.status === 'succeeded' && <Result snapshot={result} />}
    </div>
  );
}

// --------- helpers ---------

function Header({ model }: { model: ModelSlotContext }) {
  return (
    <header style={headerStyle}>
      <strong>Generate from this model</strong>
      <small style={subtleStyle}>
        {model.modelName} · v{model.modelVersionId}
      </small>
    </header>
  );
}

function Result({ snapshot }: { snapshot: BlockWorkflowSnapshot }) {
  return (
    <div style={{ marginTop: 8 }}>
      {snapshot.imageUrls?.map((url, i) => (
        <img
          key={url}
          src={url}
          alt={`Generation ${i + 1}`}
          style={imageStyle}
          loading="lazy"
        />
      ))}
      {snapshot.cost?.total != null && (
        <p style={subtleStyle}>
          Spent <strong>{snapshot.cost.total} Buzz</strong>
        </p>
      )}
    </div>
  );
}

function labelForStatus(
  status: WorkflowStatus,
  budget: number,
  estimatedCost: number | null
): string {
  // SDK status semantics:
  //   estimating  — cost lookup in flight (busy)
  //   confirming  — cost computed, awaiting USER click (idle; show Generate)
  //   submitting  — submit() in flight (busy)
  //   polling     — workflow running server-side (busy)
  //   idle / done / error → also idle (show Generate)
  switch (status) {
    case 'estimating':
      return 'Estimating cost…';
    case 'submitting':
      return 'Submitting…';
    case 'polling':
      return 'Generating…';
    default:
      // idle, confirming, done, error: the button is actionable. Show
      // the actual estimated cost when we have one, fall back to the
      // budget cap otherwise.
      return estimatedCost != null
        ? `Generate (${estimatedCost} Buzz)`
        : `Generate (≤ ${budget} Buzz)`;
  }
}

/**
 * Build the params block for submit/estimate. Mirrors the showcase
 * image's gen meta where present, with null fields dropped (the host
 * fills sensible defaults). The user's typed prompt always wins over
 * the showcase's prompt; falls back to the showcase prompt only when
 * the user hasn't typed anything.
 */
function buildSubmitParams(
  userPrompt: string,
  suffix: string,
  selected: ShowcaseImage | null
): {
  prompt: string;
  negativePrompt?: string;
  cfgScale?: number;
  steps?: number;
  seed?: number;
  sampler?: string;
  width?: number;
  height?: number;
  quantity: number;
} {
  const userPart = userPrompt.trim();
  const composed =
    userPart.length > 0
      ? [userPart, suffix].filter(Boolean).join(', ').trim()
      : selected?.prompt ?? '';
  return {
    prompt: composed,
    ...(selected?.negativePrompt ? { negativePrompt: selected.negativePrompt } : {}),
    ...(selected?.cfgScale != null ? { cfgScale: selected.cfgScale } : {}),
    ...(selected?.steps != null ? { steps: selected.steps } : {}),
    ...(selected?.seed != null ? { seed: selected.seed } : {}),
    ...(selected?.sampler ? { sampler: selected.sampler } : {}),
    ...(selected?.width ? { width: selected.width } : {}),
    ...(selected?.height ? { height: selected.height } : {}),
    quantity: 1,
  };
}

function asModelContext(ctx: BlockContext): ModelSlotContext | null {
  if (
    ctx.slotId === 'model.sidebar_top' ||
    ctx.slotId === 'model.below_images' ||
    ctx.slotId === 'model.actions_extra'
  ) {
    return ctx as ModelSlotContext;
  }
  return null;
}

function readNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function readString(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function readBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

// --------- styles (inline; the host injects [data-theme]) ---------

const containerStyle = (theme: string | null): CSSProperties => ({
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  fontFamily: 'system-ui, -apple-system, sans-serif',
  color: theme === 'dark' ? '#e5e7eb' : '#111827',
  background: theme === 'dark' ? '#111827' : '#ffffff',
  borderRadius: 8,
});

const loadingStyle: CSSProperties = {
  padding: 16,
  fontSize: 14,
  color: '#6b7280',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  marginBottom: 4,
};

const checkpointRowStyle = (theme: string | null): CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 8,
  padding: '6px 10px',
  borderRadius: 6,
  background: theme === 'dark' ? '#1f2937' : '#f3f4f6',
  fontSize: 13,
});

const carouselStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
};

const thumbButtonStyle = (selected: boolean, theme: string | null): CSSProperties => ({
  padding: 0,
  border: `2px solid ${selected ? '#3b82f6' : theme === 'dark' ? '#374151' : '#d1d5db'}`,
  borderRadius: 6,
  background: 'transparent',
  cursor: 'pointer',
  overflow: 'hidden',
  // Slightly larger when selected so the highlight is visible without
  // shifting layout — the border itself is the primary indicator.
  outline: selected ? '1px solid #60a5fa' : 'none',
  outlineOffset: 1,
});

const thumbImageStyle: CSSProperties = {
  display: 'block',
  width: 64,
  height: 64,
  objectFit: 'cover',
};

const subtleStyle: CSSProperties = {
  opacity: 0.7,
  fontSize: 13,
  margin: 0,
};

const errorTextStyle: CSSProperties = {
  margin: 0,
  color: '#dc2626',
  fontSize: 14,
};

const inputStyle = (theme: string | null): CSSProperties => ({
  padding: '8px 12px',
  borderRadius: 6,
  border: `1px solid ${theme === 'dark' ? '#374151' : '#d1d5db'}`,
  background: theme === 'dark' ? '#1f2937' : '#ffffff',
  color: 'inherit',
  fontSize: 14,
});

const primaryButtonStyle = (): CSSProperties => ({
  padding: '10px 14px',
  borderRadius: 6,
  background: '#3b82f6',
  color: '#ffffff',
  fontSize: 14,
  fontWeight: 600,
  border: 'none',
  cursor: 'pointer',
});

const linkButtonStyle = (): CSSProperties => ({
  background: 'transparent',
  border: 'none',
  color: '#3b82f6',
  fontSize: 14,
  fontWeight: 500,
  cursor: 'pointer',
  padding: 0,
  marginTop: 8,
});

const errorBoxStyle: CSSProperties = {
  padding: 12,
  borderRadius: 6,
  background: '#fef2f2',
  color: '#991b1b',
  border: '1px solid #fecaca',
  fontSize: 14,
};

const imageStyle: CSSProperties = {
  maxWidth: '100%',
  borderRadius: 6,
  display: 'block',
  marginBottom: 8,
};

