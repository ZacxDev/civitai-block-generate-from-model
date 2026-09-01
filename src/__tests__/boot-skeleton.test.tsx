/**
 * Boot skeleton — the static shimmer that index.html paints BEFORE this
 * bundle exists, and its agreement with the React `!ready` skeleton that
 * replaces it a few hundred ms later.
 *
 * Two independent failure modes are guarded here, because they have
 * different causes and only one of them is visible from inside React:
 *
 *   1. PARITY. index.html and App.tsx each declare the same four bars. They
 *      are different files in different languages, so nothing but a test
 *      keeps them equal — and a drift is not a crash, it is a visible jump
 *      at hydration. Tests below compare the two DECLARATIONS, not one side
 *      against a constant, so editing either file alone goes red.
 *
 *   2. THEME AGREEMENT. `useBlockContext().theme` is `'light'` before
 *      BLOCK_INIT — a sentinel from the SDK transport, not the host's real
 *      theme. index.html guesses from `prefers-color-scheme`, so if App.tsx
 *      honoured that sentinel a dark-mode viewer would get dark -> white ->
 *      dark. `bootThemeGuess()` exists to stop that, and the tests here pin
 *      it against the sentinel explicitly (the mock keeps returning
 *      `theme: 'light'` while the OS says dark — that IS the bug's shape).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { createRoot } from 'react-dom/client';

import {
  blocksReactMockFactory,
  renderApp,
  resetBlocksReactMock,
  setMockReady,
  setMockTheme,
} from '../test/test-utils';

vi.mock('@civitai/blocks-react', () => blocksReactMockFactory());

// Import AFTER the mock is registered so the App picks up the stubs.
import { App } from '../App';

// Vite rewrites `import.meta.url` to a served path, so it cannot locate a
// file on disk here. vitest's cwd is the project root (vite.config.ts's dir).
const repoFile = (rel: string): string => readFileSync(resolve(process.cwd(), rel), 'utf8');

const INDEX_HTML = repoFile('index.html');
const APP_SRC = repoFile('src/App.tsx');

/* ------------------------------------------------------------------ *
 *  matchMedia control — jsdom has no OS theme, so the boot guess has
 *  to be driven explicitly. Returning a MediaQueryList whose `matches`
 *  we choose is the whole lever bootThemeGuess() reads.
 * ------------------------------------------------------------------ */

function setPrefersDark(matches: boolean | 'throw'): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      if (matches === 'throw') throw new Error('matchMedia unavailable');
      return {
        matches: query.includes('prefers-color-scheme: dark') ? matches : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
    })
  );
}

/** Render the App in its pre-BLOCK_INIT boot state. */
async function renderBoot(): Promise<HTMLElement> {
  setMockReady(false);
  const { container } = await renderApp(<App />);
  const skeleton = container.querySelector<HTMLElement>('[aria-hidden="true"]');
  if (!skeleton) throw new Error('boot skeleton did not render');
  return skeleton;
}

type Geometry = { width: string; height: string; marginTop: string };

const geometryOf = (els: ArrayLike<Element>): Geometry[] =>
  Array.from(els, (el) => {
    const s = (el as HTMLElement).style;
    return {
      width: s.width,
      height: s.height,
      // React omits marginTop on the first two bars; the DOM reports ''
      // for an unset property on both sides, so '' is a real value here.
      marginTop: s.marginTop,
    };
  });

/** The four `.gfm-boot-bar` elements as declared inside #root in index.html. */
function staticBars(): Element[] {
  const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
  const root = doc.querySelector('#root');
  if (!root) throw new Error('#root missing from index.html');
  return Array.from(root.querySelectorAll('.gfm-boot-bar'));
}

/** All `linear-gradient(...)` declarations in a blob of source, normalised. */
const gradients = (src: string): string[] =>
  (src.match(/linear-gradient\([^)]*\)/g) ?? []).map((g) =>
    g.toLowerCase().replace(/\s+/g, ' ')
  );

/** The body of `function LoadingSkeleton` in App.tsx. */
function loadingSkeletonSource(): string {
  const start = APP_SRC.indexOf('function LoadingSkeleton');
  expect(start).toBeGreaterThan(-1);
  const end = APP_SRC.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return APP_SRC.slice(start, end);
}

beforeEach(() => {
  resetBlocksReactMock();
  setPrefersDark(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('index.html ships a skeleton that paints before the bundle', () => {
  it('renders markup inside #root (not an empty mount point)', () => {
    const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
    const root = doc.querySelector('#root');
    expect(root).not.toBeNull();
    // The entire point: something is on screen before /src/main.tsx runs.
    expect(root!.children.length).toBeGreaterThan(0);
    expect(staticBars()).toHaveLength(4);
  });

  it('is parser-rendered markup, not inert or paint-blocked content', () => {
    // NOTE the invariant this does NOT assert: where the skeleton sits
    // relative to the bundle's <script>. `vite build` hoists that script
    // into <head>, ABOVE #root — which is harmless, because a
    // `type="module"` script is deferred by default and blocks neither the
    // parser nor first paint. Asserting document order would therefore
    // pin a property the real artifact does not have. What must hold is
    // that the markup is live in the parsed document and nothing ahead of
    // it stops the parser reaching it.
    const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');

    // <template>/<noscript> contents are not in the element tree, so a
    // skeleton hidden in either is simply not found here.
    expect(doc.querySelector('#root .gfm-boot')).not.toBeNull();

    const blocking = Array.from(doc.querySelectorAll('script')).filter(
      (s) =>
        s.getAttribute('type') !== 'module' &&
        !s.hasAttribute('defer') &&
        !s.hasAttribute('async')
    );
    expect(blocking.map((s) => s.outerHTML)).toEqual([]);
  });

  it('is REMOVED by React on mount — createRoot clears the container', async () => {
    // The whole design rests on this: the skeleton lives inside #root and
    // React deletes it, so nothing has to clean it up and there is no
    // moment where both are on screen. That is real react-dom behaviour
    // (`createRoot` clears the container before its first commit), not
    // something this repo controls — so it is worth pinning against a
    // react-dom bump rather than assumed.
    const doc = new DOMParser().parseFromString(INDEX_HTML, 'text/html');
    const container = document.createElement('div');
    container.id = 'root';
    container.innerHTML = doc.querySelector('#root')!.innerHTML;
    document.body.appendChild(container);
    expect(container.querySelectorAll('.gfm-boot-bar')).toHaveLength(4);

    setMockReady(false);
    const root = createRoot(container);
    await act(async () => {
      root.render(<App />);
    });

    expect(container.querySelectorAll('.gfm-boot-bar')).toHaveLength(0);
    // ...and React's own skeleton took its place, so the swap is not a gap.
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();

    await act(async () => root.unmount());
    container.remove();
  });

  it('inlines its own resets rather than leaning on src/index.css', () => {
    // index.css arrives WITH the bundle, so anything it provides is absent
    // during the gap. The UA's default 8px body margin would otherwise
    // offset the skeleton and snap when the real stylesheet lands.
    const inlineCss = /<style>([\s\S]*?)<\/style>/.exec(INDEX_HTML)?.[1] ?? '';
    expect(inlineCss).toMatch(/body\s*\{[^}]*margin:\s*0/);
  });

  it('declares a prefers-color-scheme: dark variant', () => {
    // Positive control for the parity test below — if this block ever
    // disappears, the dark-gradient comparison would compare nothing to
    // nothing and pass vacuously.
    expect(INDEX_HTML).toContain('@media (prefers-color-scheme: dark)');
  });
});

describe('static skeleton matches the React skeleton it hands off to', () => {
  it('declares the same four bar geometries', async () => {
    const rendered = await renderBoot();
    expect(geometryOf(rendered.children)).toEqual(geometryOf(staticBars()));
  });

  it('declares the same shimmer gradients, light and dark', () => {
    const fromApp = gradients(loadingSkeletonSource());
    const fromHtml = gradients(INDEX_HTML);
    expect(fromApp).toHaveLength(2); // light + dark, per LoadingSkeleton
    expect(new Set(fromHtml)).toEqual(new Set(fromApp));
  });

  it('declares the same container backgrounds, light and dark', () => {
    // outerContainerStyle()'s two values, quoted out of App.tsx source.
    const outer = APP_SRC.slice(APP_SRC.indexOf('const outerContainerStyle'));
    const bg = /background:\s*theme === 'dark' \? '(#[0-9a-f]+)' : '(#[0-9a-f]+)'/i.exec(outer);
    expect(bg).not.toBeNull();
    const [, dark = '', light = ''] = bg ?? [];
    expect(dark).not.toBe('');
    expect(light).not.toBe('');
    const css = INDEX_HTML.toLowerCase();
    expect(css).toContain(`background: ${light.toLowerCase()}`);
    expect(css).toContain(`background: ${dark.toLowerCase()}`);
  });

  it('uses the same inner padding and bar gap', async () => {
    const rendered = await renderBoot();
    const inner = rendered.parentElement as HTMLElement;
    const inlineCss = /<style>([\s\S]*?)<\/style>/.exec(INDEX_HTML)?.[1] ?? '';
    const bootInner = /\.gfm-boot-inner\s*\{([^}]*)\}/.exec(inlineCss)?.[1] ?? '';

    expect(bootInner).toContain(`padding: ${inner.style.padding}`);
    // The React inner's own `gap` is inert (its only visible child is the
    // skeleton), so the gap that shows is the skeleton div's.
    expect(bootInner).toContain(`gap: ${rendered.style.gap}`);
  });
});

describe('boot theme is guessed from the OS, not from the SDK sentinel', () => {
  it('paints dark for a dark-mode viewer while theme is still the sentinel', async () => {
    // This is the regression: the mock reports the SDK's pre-init
    // `theme: 'light'` exactly as the real transport does. Reading it here
    // is what produced dark -> white -> dark at hydration.
    setMockTheme('light');
    setPrefersDark(true);

    const skeleton = await renderBoot();
    const outer = skeleton.closest('[data-theme]') as HTMLElement;
    expect(outer.dataset.theme).toBe('dark');
    expect(outer.style.background).toBe('rgb(26, 27, 30)'); // #1a1b1e
  });

  it('paints light for a light-mode viewer', async () => {
    setMockTheme('light');
    setPrefersDark(false);

    const skeleton = await renderBoot();
    const outer = skeleton.closest('[data-theme]') as HTMLElement;
    expect(outer.dataset.theme).toBe('light');
    expect(outer.style.background).toBe('rgb(255, 255, 255)'); // #ffffff
  });

  it('falls back to light where matchMedia is unavailable', async () => {
    setPrefersDark('throw');
    const skeleton = await renderBoot();
    expect((skeleton.closest('[data-theme]') as HTMLElement).dataset.theme).toBe('light');
  });

  it('still lets the host theme win once BLOCK_INIT has landed', async () => {
    // The guess is boot-only. A dark OS must not override a light host.
    setPrefersDark(true);
    setMockTheme('light');
    setMockReady(true);

    const { container } = await renderApp(<App />);
    const outer = container.querySelector('[data-theme]') as HTMLElement;
    expect(outer.dataset.theme).toBe('light');
  });
});
