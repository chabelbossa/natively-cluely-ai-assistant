#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'electron/main.ts'), 'utf8');
const ipcSource = fs.readFileSync(path.join(root, 'electron/ipcHandlers.ts'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const activateStart = mainSource.indexOf('app.on("activate"');
const activateEnd = mainSource.indexOf('app.on("window-all-closed"', activateStart);
assert(activateStart >= 0 && activateEnd > activateStart, 'macOS activate handler was not found.');

const activateHandler = mainSource.slice(activateStart, activateEnd);
for (const forbidden of [
  'toggleMainWindow(',
  'showMainWindow(',
  'centerAndShowWindow(',
  'showOverlay(',
  'switchToOverlay(',
  'switchToLauncher(',
]) {
  assert(
    !activateHandler.includes(forbidden),
    `Hidden-window policy regression: app activation calls ${forbidden}`,
  );
}

assert(
  ipcSource.includes('safeHandle("toggle-window"') && ipcSource.includes('appState.toggleMainWindow();'),
  'The explicit visibility shortcut path is missing.',
);
assert(
  mainSource.includes("label: 'Show Natively'") && mainSource.includes('this.centerAndShowWindow()'),
  'The explicit tray Show action is missing.',
);

console.log('Window visibility policy guard passed: activation preserves hidden state; explicit reveal paths remain.');
