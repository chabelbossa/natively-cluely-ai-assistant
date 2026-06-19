#!/usr/bin/env node

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const appArg = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
const appPath = path.resolve(appArg || '/Applications/Natively.app');
const timeoutMs = Number(process.env.NATIVELY_APP_VERIFY_TIMEOUT_MS || 120000);
const leaveRunning = process.argv.includes('--leave-running');

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function assertExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`${label} missing: ${targetPath}`);
  }
}

function verifyCodesign(targetPath, label) {
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', targetPath], { stdio: 'inherit' });
  const details = run('sh', ['-lc', `codesign -dv --verbose=4 "${targetPath.replace(/"/g, '\\"')}" 2>&1`]);
  if (!/Signature=adhoc/.test(details)) {
    throw new Error(`${label} is not ad-hoc signed.`);
  }
  if (!/flags=.*runtime/.test(details)) {
    throw new Error(`${label} is missing hardened runtime flags.`);
  }
}

function findNativelyProcesses() {
  const output = run('ps', ['-axo', 'pid=,command=']);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(`${appPath}/Contents/MacOS/Natively`));
}

function findNativelyRuntimeProcesses() {
  const direct = findNativelyProcesses();
  if (direct.length > 0) return direct;

  const output = run('ps', ['-axo', 'pid=,ppid=,command=']);
  const candidateParents = new Set();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.includes(`${appPath}/Contents/Frameworks/Natively Helper`)) continue;
    const parts = trimmed.split(/\s+/);
    const ppid = Number(parts[1]);
    if (Number.isFinite(ppid) && ppid > 1) candidateParents.add(ppid);
  }

  const matches = [];
  for (const pid of candidateParents) {
    try {
      const lsof = run('lsof', ['-p', String(pid)]);
      if (lsof.includes(`${appPath}/Contents/MacOS/Natively`)) {
        matches.push(`${pid} ${appPath}/Contents/MacOS/Natively`);
      }
    } catch {}
  }

  return matches;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAppProcess() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const matches = findNativelyRuntimeProcesses();
    if (matches.length > 0) return matches;
    await wait(500);
  }
  throw new Error(`Natively did not start from ${appPath}`);
}

async function verifyParakeetHelper(helperPath) {
  await new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NATIVELY_PARAKEET_NO_DOWNLOAD: '1',
        NATIVELY_PARAKEET_ALLOW_DIARIZATION_DOWNLOAD: '1',
      },
    });

    let stderr = '';
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      cleanup();
      child.kill('SIGKILL');
      reject(new Error(`Parakeet helper did not emit ready within ${timeoutMs}ms. stderr=${stderr.slice(-500)}`));
    }, timeoutMs);

    const cleanup = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
    };

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      stdout += `${line}\n`;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'ready') {
        cleanup();
        child.stdin.write('{"type":"shutdown"}\n');
        setTimeout(() => child.kill(), 500);
        resolve();
      }
    });

    child.stderr.on('data', (data) => {
      stderr += String(data);
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      cleanup();
      reject(new Error(`Parakeet helper exited before ready code=${code ?? 'null'} signal=${signal ?? 'null'} stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`));
    });

    child.on('error', (error) => {
      if (settled) return;
      cleanup();
      reject(error);
    });
  });
}

async function main() {
  assertExists(appPath, 'Natively.app');
  const mainExecutable = path.join(appPath, 'Contents', 'MacOS', 'Natively');
  const electronFramework = path.join(appPath, 'Contents', 'Frameworks', 'Electron Framework.framework');
  const parakeetHelper = path.join(appPath, 'Contents', 'Resources', 'helpers', 'parakeet-stt-helper');

  assertExists(mainExecutable, 'main executable');
  assertExists(electronFramework, 'Electron Framework');
  assertExists(parakeetHelper, 'Parakeet helper');

  console.log(`[app-runtime] verifying codesign for ${appPath}`);
  verifyCodesign(appPath, 'Natively.app');
  verifyCodesign(electronFramework, 'Electron Framework');
  verifyCodesign(parakeetHelper, 'Parakeet helper');

  console.log('[app-runtime] verifying Parakeet helper startup');
  await verifyParakeetHelper(parakeetHelper);

  console.log('[app-runtime] launching Natively');
  run('open', ['-na', appPath]);
  const processes = await waitForAppProcess();
  await wait(5000);
  const stillRunning = findNativelyRuntimeProcesses();
  if (stillRunning.length === 0) {
    throw new Error('Natively started and then exited.');
  }

  console.log(JSON.stringify({
    appPath,
    parakeetHelperReady: true,
    runningProcesses: stillRunning,
  }, null, 2));

  if (!leaveRunning) {
    for (const line of stillRunning) {
      const pid = Number(line.split(/\s+/)[0]);
      if (Number.isFinite(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
    }
  }
}

main().catch((error) => {
  console.error(`[app-runtime] failed: ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
