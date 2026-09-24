import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { Harness } from './dev/Harness.js';
import { installHarnessServer } from './dev/harnessServer.js';
import './index.css';

// VITE_DEV_HARNESS=true wraps the block in a local simulator that posts a
// fake BLOCK_INIT — useful for `pnpm dev:harness`, never for production
// builds. Strip on `pnpm build` by NOT setting it in `.env.production`.
const useHarness = import.meta.env.VITE_DEV_HARNESS === 'true';

// 🔴 INSTALLED AT MODULE SCOPE, NOT INSIDE `Harness`. Since the `@civitai/sdk`
// port the block's data path is `fetch`, so without a local server
// `dev:harness` would fire real, money-shaped POSTs at civitai.com signed with
// the harness's deliberately-invalid mock JWT. `installHarnessServer` calls
// `__configurePlatform`, which drops any client already built — and React runs
// a CHILD's effects before its parent's, so an effect inside `Harness` would
// land AFTER `App` had already started the handshake and issued its first REST
// call. Installing here is what makes the dev loop hermetic rather than nearly
// hermetic.
if (useHarness) installHarnessServer();

const container = document.getElementById('root');
if (!container) throw new Error('#root missing from index.html');

createRoot(container).render(
  <StrictMode>{useHarness ? <Harness><App /></Harness> : <App />}</StrictMode>,
);
