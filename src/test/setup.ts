// Wires `@testing-library/jest-dom` matchers (.toBeInTheDocument, etc.) into
// every test file automatically. Loaded via vite.config.ts → test.setupFiles.
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// React Testing Library unmounts between tests automatically when `globals`
// is on, but the cleanup hook is explicit + portable across config changes.
afterEach(() => {
  cleanup();
});

// Reset localStorage between tests so persistence tests stay isolated. JSDOM
// gives every test the same in-memory store unless we clear it ourselves.
beforeEach(() => {
  if (typeof window !== 'undefined') {
    window.localStorage.clear();
  }
});

// ResizeObserver is referenced by `useBlockResize` (which the App calls on
// mount). JSDOM doesn't ship a polyfill, so we stub it — the actual resize
// flow is out of scope for these tests.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ResizeObserver ?? ResizeObserverStub;
