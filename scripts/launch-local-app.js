#!/usr/bin/env node

const { spawnSync } = require("child_process");

const APP_PATH = "/Applications/Natively.app";
const FORCE_AUDIO_DEBUG_ENV = "NATIVELY_FORCE_AUDIO_DEBUG";

function usage() {
  console.log(`
Usage:
  node scripts/launch-local-app.js --audio-debug
  node scripts/launch-local-app.js --normal

Options:
  --audio-debug   Launch Natively with forced local mic/speaker audio debug capture.
  --normal        Clear forced audio debug capture and relaunch Natively normally.
`);
}

function parseArgs(argv) {
  const mode = argv.includes("--normal") ? "normal" : argv.includes("--audio-debug") ? "audio-debug" : null;
  if (argv.includes("--help") || argv.includes("-h")) {
    usage();
    process.exit(0);
  }
  if (!mode) {
    usage();
    throw new Error("Expected --audio-debug or --normal.");
  }
  return { mode };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs || 15000,
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function runRequired(command, args, options = {}) {
  const result = run(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout || result.status}`);
  }
  return result.stdout || "";
}

function setLaunchEnv(mode) {
  if (mode === "audio-debug") {
    runRequired("launchctl", ["setenv", FORCE_AUDIO_DEBUG_ENV, "1"]);
  } else {
    runRequired("launchctl", ["unsetenv", FORCE_AUDIO_DEBUG_ENV]);
  }
}

function getLaunchEnv() {
  const result = run("launchctl", ["getenv", FORCE_AUDIO_DEBUG_ENV], { timeoutMs: 5000 });
  return String(result.stdout || "").trim();
}

function processOwnsApp(pid) {
  const result = run("lsof", ["-p", String(pid)], { timeoutMs: 5000 });
  return `${result.stdout || ""}${result.stderr || ""}`.includes(APP_PATH);
}

function findNativelyPids() {
  const result = runRequired("ps", ["-axo", "pid=,ppid=,command="], { timeoutMs: 5000 });
  const pids = new Set();
  const parentCandidates = new Set();

  for (const line of result.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const command = match[3];
    if (!Number.isFinite(pid) || pid <= 1 || pid === process.pid) continue;

    if (command.includes(`${APP_PATH}/Contents/MacOS/Natively`)) {
      pids.add(pid);
    }
    if (command.includes(`${APP_PATH}/Contents/Frameworks/Natively Helper`)) {
      pids.add(pid);
      if (Number.isFinite(ppid) && ppid > 1) parentCandidates.add(ppid);
    }
  }

  for (const pid of parentCandidates) {
    if (pid !== process.pid && processOwnsApp(pid)) pids.add(pid);
  }

  return [...pids].sort((a, b) => b - a);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function quitNatively() {
  run("osascript", ["-e", 'tell application "Natively" to quit'], { timeoutMs: 5000 });
  sleep(1500);

  let pids = findNativelyPids();
  if (pids.length === 0) return;

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    pids = findNativelyPids().filter(isAlive);
    if (pids.length === 0) return;
    sleep(250);
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

function launchNatively() {
  runRequired("open", ["-na", APP_PATH], { timeoutMs: 10000 });
}

function waitForNatively() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const pids = findNativelyPids();
    if (pids.length > 0) return pids;
    sleep(500);
  }
  throw new Error(`Natively did not start from ${APP_PATH}.`);
}

function main() {
  const { mode } = parseArgs(process.argv.slice(2));
  setLaunchEnv(mode);
  quitNatively();
  launchNatively();
  const pids = waitForNatively();

  console.log(JSON.stringify({
    appPath: APP_PATH,
    mode,
    [FORCE_AUDIO_DEBUG_ENV]: getLaunchEnv() || null,
    pids,
  }, null, 2));
}

main();
