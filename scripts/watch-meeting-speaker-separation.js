#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const userData = path.join(process.env.HOME || "", "Library/Application Support/natively");
const meetingDebugDir = path.join(userData, "meeting-debug");

function usage() {
  console.log(`
Usage:
  npm run meeting:separation:watch -- [options]

Options:
  --run-latest                  Audit the latest completed meeting immediately.
  --timeout-minutes <n>         Stop waiting after n minutes (default 180).
  --poll-ms <n>                 Poll interval in milliseconds (default 5000).
  --min-duration-sec <n>        Passed to separation guard (default 60).
  --require-me                  Require at least one final ME segment.
  --fail-on-suspect-me          Fail on ME finals flagged as echo/overlap suspects.
  --no-echo-gate                Do not run the audio echo-gate replay.
  --no-correlated-drop          Do not require correlated echo drops.

By default this waits for the next completed meeting-debug JSONL created after
the watcher starts, then runs meeting:separation:guard on that exact session.
`);
}

function parseArgs(argv) {
  const args = {
    runLatest: false,
    timeoutMinutes: 180,
    pollMs: 5000,
    minDurationSec: 60,
    requireMe: false,
    failOnSuspectMe: false,
    echoGate: true,
    correlatedDrop: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const readValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
      i += 1;
      return value;
    };

    switch (token) {
      case "--run-latest":
        args.runLatest = true;
        break;
      case "--timeout-minutes":
        args.timeoutMinutes = Number(readValue());
        break;
      case "--poll-ms":
        args.pollMs = Number(readValue());
        break;
      case "--min-duration-sec":
        args.minDurationSec = Number(readValue());
        break;
      case "--require-me":
        args.requireMe = true;
        break;
      case "--fail-on-suspect-me":
        args.failOnSuspectMe = true;
        break;
      case "--no-echo-gate":
        args.echoGate = false;
        break;
      case "--no-correlated-drop":
        args.correlatedDrop = false;
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readMeetingEnd(filePath) {
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const event = JSON.parse(lines[index]);
      if (event.type === "meeting_end") {
        return event;
      }
    }
  } catch {}
  return null;
}

function meetingRecords() {
  if (!fs.existsSync(meetingDebugDir)) return [];

  return fs.readdirSync(meetingDebugDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const filePath = path.join(meetingDebugDir, name);
      const stat = fs.statSync(filePath);
      const endEvent = readMeetingEnd(filePath);
      const manifestPath = endEvent?.payload?.audioDebugManifestPath || null;
      return {
        filePath,
        mtimeMs: stat.mtimeMs,
        meetingId: endEvent?.payload?.meetingId || null,
        manifestPath,
        completed: Boolean(endEvent),
        hasManifest: Boolean(endEvent && manifestPath && fs.existsSync(manifestPath)),
      };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function completedMeetings() {
  return meetingRecords().filter((item) => item.completed && item.hasManifest);
}

async function waitForNextMeeting(startedAtMs, timeoutMinutes, pollMs) {
  const deadline = startedAtMs + timeoutMinutes * 60_000;
  let lastLoggedAt = 0;

  while (Date.now() < deadline) {
    const match = completedMeetings().find((item) => item.mtimeMs >= startedAtMs);
    if (match) return match;

    const completedWithoutManifest = meetingRecords().find((item) => (
      item.mtimeMs >= startedAtMs &&
      item.completed &&
      !item.hasManifest
    ));
    if (completedWithoutManifest) {
      throw new Error(
        "The next meeting completed without an audio debug manifest. " +
        "Enable 'Record debug audio locally' before starting the meeting, or launch Natively with " +
        `NATIVELY_FORCE_AUDIO_DEBUG=1. debug=${completedWithoutManifest.filePath}`,
      );
    }

    const now = Date.now();
    if (now - lastLoggedAt > 30_000) {
      lastLoggedAt = now;
      const elapsedMin = ((now - startedAtMs) / 60_000).toFixed(1);
      console.log(`[separation-watch] waiting for next completed meeting... elapsed=${elapsedMin}m`);
    }
    await sleep(pollMs);
  }

  throw new Error(`No completed meeting appeared within ${timeoutMinutes} minutes.`);
}

function runGuard(meeting, args) {
  const guardArgs = [
    path.join(repoRoot, "scripts/check-meeting-speaker-separation.js"),
    "--debug",
    meeting.filePath,
    "--min-duration-sec",
    String(args.minDurationSec),
  ];

  if (args.requireMe) guardArgs.push("--require-me");
  if (args.failOnSuspectMe) guardArgs.push("--fail-on-suspect-me");
  if (args.echoGate) guardArgs.push("--require-echo-gate");
  if (args.correlatedDrop && args.echoGate) guardArgs.push("--require-correlated-drop");

  console.log(`[separation-watch] auditing meeting=${meeting.meetingId || "(unknown)"} debug=${meeting.filePath}`);
  const result = spawnSync(process.execPath, guardArgs, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  return result.status || 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const startedAtMs = Date.now();

  const meeting = args.runLatest
    ? completedMeetings()[0]
    : await waitForNextMeeting(startedAtMs, args.timeoutMinutes, args.pollMs);

  if (!meeting) {
    throw new Error("No completed meeting-debug JSONL with audio manifest was found.");
  }

  const status = runGuard(meeting, args);
  process.exit(status);
}

main().catch((error) => {
  console.error(`[separation-watch] failed: ${error?.stack || error?.message || String(error)}`);
  process.exit(1);
});
