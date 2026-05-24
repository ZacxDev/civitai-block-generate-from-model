import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';

import {
  useBlockContext,
  useBlockResize,
  useBlockSettings,
  useBuzzPurchase,
  useBuzzWorkflow,
} from '@civitai/blocks-react';
import type {
  BlockContext,
  BlockWorkflowSnapshot,
  ModelSlotContext,
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
  const { submit, status, result, error } = useBuzzWorkflow();
  const { openPurchaseModal } = useBuzzPurchase();
  const rootRef = useRef<HTMLDivElement>(null);
  useBlockResize(rootRef);

  const [prompt, setPrompt] = useState('');

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

  const busy: WorkflowStatus[] = ['estimating', 'confirming', 'submitting', 'polling'];
  const isBusy = busy.includes(status);

  const handleGenerate = async () => {
    const fullPrompt = [prompt, suffix].filter(Boolean).join(', ').trim();
    try {
      await submit({
        kind: 'textToImage',
        modelVersionId: model.modelVersionId,
        prompt: fullPrompt,
        // Platform enforces `cost <= claims.buzzBudget` regardless of what we
        // send here. The block-scoped JWT carries the budget; the requested
        // amount is informational — the host clips and returns the actual cost.
        maxBuzz: budget,
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

        <button
          type="button"
          onClick={handleGenerate}
          disabled={isBusy}
          style={primaryButtonStyle()}
        >
          {labelForStatus(status, budget)}
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

      {result && result.status === 'succeeded' && (
        <Result snapshot={result} />
      )}

      <footer style={footerStyle}>
        Powered by <strong>Civitai App Blocks</strong>
      </footer>
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

function labelForStatus(status: WorkflowStatus, budget: number): string {
  switch (status) {
    case 'estimating':
      return 'Estimating cost…';
    case 'confirming':
      return 'Confirming…';
    case 'submitting':
      return 'Submitting…';
    case 'polling':
      return 'Generating…';
    default:
      return `Generate (≤ ${budget} Buzz)`;
  }
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

const footerStyle: CSSProperties = {
  fontSize: 11,
  opacity: 0.5,
  textAlign: 'center',
  marginTop: 8,
};
