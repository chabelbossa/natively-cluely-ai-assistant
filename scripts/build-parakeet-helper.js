const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const packageDir = path.join(root, 'native-helpers', 'parakeet-stt-helper');
const scratchDir = path.join(packageDir, '.build');
const distDir = path.join(packageDir, 'dist');
const builtBinary = path.join(scratchDir, 'release', 'parakeet-stt-helper');
const distBinary = path.join(distDir, 'parakeet-stt-helper');

if (process.platform !== 'darwin') {
  console.log('[Parakeet Helper] Skipping build: helper is macOS-only.');
  process.exit(0);
}

fs.mkdirSync(distDir, { recursive: true });

console.log('[Parakeet Helper] Building Swift helper...');
execFileSync('swift', [
  'build',
  '-c',
  'release',
  '--package-path',
  packageDir,
  '--scratch-path',
  scratchDir,
], {
  cwd: root,
  stdio: 'inherit',
});

if (!fs.existsSync(builtBinary)) {
  throw new Error(`Swift build completed but helper was not found: ${builtBinary}`);
}

fs.copyFileSync(builtBinary, distBinary);
fs.chmodSync(distBinary, 0o755);

console.log(`[Parakeet Helper] Built: ${distBinary}`);

