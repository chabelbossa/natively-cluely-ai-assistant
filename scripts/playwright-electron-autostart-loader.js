#!/usr/bin/env node

// Playwright's Electron loader holds app.whenReady() until electron.launch()
// connects both the Node inspector and Chromium DevTools. With a packaged app,
// Chromium does not publish its DevTools endpoint until ready is released. Make
// the hook idempotent and release it once from the preload to avoid that cycle.
const path = require('node:path');
const playwrightRoot = path.dirname(require.resolve('playwright-core'));
require(path.join(playwrightRoot, 'lib/server/electron/loader.js'));

const runPlaywrightHook = globalThis.__playwright_run;
let runPromise;
globalThis.__playwright_run = () => {
  runPromise ||= Promise.resolve().then(() => runPlaywrightHook());
  return runPromise;
};

setImmediate(() => {
  void globalThis.__playwright_run();
});
