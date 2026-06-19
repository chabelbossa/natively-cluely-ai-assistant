#!/usr/bin/env node

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const userData = path.join(process.env.HOME || "", "Library/Application Support/natively");
const meetingDebugDir = path.join(userData, "meeting-debug");

function usage() {
  console.log(`
Usage:
  npm run meeting:separation:guard -- [options]

Options:
  --debug <path>                 meeting-debug JSONL. Defaults to latest local meeting-debug.
  --manifest <path>              audio-debug manifest. Defaults to meeting_end payload.
  --min-duration-sec <n>         Minimum call duration required (default 60).
  --max-duplicates <n>           Max allowed cross-role duplicate finals (default 0).
  --max-false-me-echoes <n>      Max allowed ME finals that echo system finals (default 0).
  --min-system-finals <n>        Minimum interlocutor/system final segments (default 1).
  --min-diarized-finals <n>      Minimum diarized system finals (default 1).
  --require-me                   Fail if no final ME segment is accepted.
  --require-fresh-minutes <n>    Fail if meeting-debug is older than n minutes.
  --fail-on-suspect-me           Fail on final ME segments flagged as echo suspects.
  --require-echo-gate            Fail if the audio echo-gate replay cannot pass.
  --require-correlated-drop      Require correlated echo drops in the echo-gate replay.
  --no-echo-gate                 Skip audio echo-gate replay.
`);
}

function parseArgs(argv) {
  const args = {
    debugPath: null,
    manifestPath: null,
    minDurationSec: 60,
    maxDuplicates: 0,
    maxFalseMeEchoes: 0,
    minSystemFinals: 1,
    minDiarizedFinals: 1,
    requireMe: false,
    requireFreshMinutes: null,
    failOnSuspectMe: false,
    requireEchoGate: false,
    requireCorrelatedDrop: false,
    runEchoGate: true,
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
      case "--debug":
        args.debugPath = readValue();
        break;
      case "--manifest":
        args.manifestPath = readValue();
        break;
      case "--min-duration-sec":
        args.minDurationSec = Number(readValue());
        break;
      case "--max-duplicates":
        args.maxDuplicates = Number(readValue());
        break;
      case "--max-false-me-echoes":
        args.maxFalseMeEchoes = Number(readValue());
        break;
      case "--min-system-finals":
        args.minSystemFinals = Number(readValue());
        break;
      case "--min-diarized-finals":
        args.minDiarizedFinals = Number(readValue());
        break;
      case "--require-me":
        args.requireMe = true;
        break;
      case "--require-fresh-minutes":
        args.requireFreshMinutes = Number(readValue());
        break;
      case "--fail-on-suspect-me":
        args.failOnSuspectMe = true;
        break;
      case "--require-echo-gate":
        args.requireEchoGate = true;
        break;
      case "--require-correlated-drop":
        args.requireCorrelatedDrop = true;
        args.requireEchoGate = true;
        break;
      case "--no-echo-gate":
        args.runEchoGate = false;
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

function findLatestMeetingDebug() {
  if (!fs.existsSync(meetingDebugDir)) return null;
  const files = fs.readdirSync(meetingDebugDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const filePath = path.join(meetingDebugDir, name);
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of files) {
    const manifestPath = readMeetingEndManifestPath(file.filePath);
    if (manifestPath && fs.existsSync(manifestPath)) return file.filePath;
  }

  return files[0]?.filePath || null;
}

function readMeetingEndManifestPath(filePath) {
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const event = JSON.parse(lines[index]);
      if (event.type === "meeting_end" && event.payload?.audioDebugManifestPath) {
        return event.payload.audioDebugManifestPath;
      }
    }
  } catch {}
  return null;
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid JSONL at ${filePath}:${index + 1}: ${error.message}`);
      }
    });
}

function readManifest(manifestPath, failures) {
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    failures.push("audio_manifest_missing");
    return null;
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const track of ["mic", "system"]) {
    const info = manifest.tracks?.[track];
    if (!info) {
      failures.push(`audio_track_missing:${track}`);
      continue;
    }
    if (!info.path || !fs.existsSync(info.path)) failures.push(`audio_track_file_missing:${track}`);
    if (!info.chunksPath || !fs.existsSync(info.chunksPath)) failures.push(`audio_track_chunks_missing:${track}`);
    if (info.silent === true) failures.push(`audio_track_silent:${track}`);
    if (!Number.isFinite(info.bytes) || info.bytes <= 0) failures.push(`audio_track_empty:${track}`);
  }
  return manifest;
}

function countBy(items, getKey) {
  const counts = {};
  for (const item of items) {
    const key = getKey(item);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textSimilarity(a, b) {
  const aWords = normalizeText(a).split(" ").filter(Boolean);
  const bWords = normalizeText(b).split(" ").filter(Boolean);
  if (!aWords.length || !bWords.length) return 0;
  const aSet = new Set(aWords);
  const bSet = new Set(bWords);
  let intersection = 0;
  for (const word of aSet) {
    if (bSet.has(word)) intersection += 1;
  }
  return intersection / new Set([...aSet, ...bSet]).size;
}

function countCrossRoleDuplicates(finals) {
  let duplicates = 0;
  const samples = [];
  for (let i = 0; i < finals.length; i += 1) {
    for (let j = 0; j < i; j += 1) {
      if (finals[i].role === finals[j].role) continue;
      if (Math.abs(finals[i].timestamp - finals[j].timestamp) > 15000) continue;
      const similarity = textSimilarity(finals[i].text, finals[j].text);
      if (similarity >= 0.72) {
        duplicates += 1;
        if (samples.length < 5) {
          samples.push({
            similarity: Number(similarity.toFixed(3)),
            a: summarizeSegment(finals[i]),
            b: summarizeSegment(finals[j]),
          });
        }
        break;
      }
    }
  }
  return { count: duplicates, samples };
}

function countFalseMeEchoes(finals) {
  const system = finals.filter((segment) => segment.source === "system" || (segment.role !== "me" && segment.role !== "assistant"));
  const samples = [];
  let count = 0;
  for (const segment of finals) {
    if (segment.role !== "me") continue;
    const match = system.find((candidate) => (
      Math.abs(segment.timestamp - candidate.timestamp) <= 15000 &&
      textSimilarity(segment.text, candidate.text) >= 0.55
    ));
    if (!match) continue;
    count += 1;
    if (samples.length < 5) {
      samples.push({
        me: summarizeSegment(segment),
        matchedSystem: summarizeSegment(match),
        similarity: Number(textSimilarity(segment.text, match.text).toFixed(3)),
      });
    }
  }
  return { count, samples };
}

function summarizeSegment(segment) {
  return {
    role: segment.role,
    source: segment.source,
    timestamp: segment.timestamp,
    flags: segment.qualityFlags || [],
    text: String(segment.text || "").slice(0, 180),
  };
}

function runEchoGate(manifestPath, args, failures, warnings) {
  if (!args.runEchoGate || !manifestPath) return null;
  const commandArgs = [path.join(repoRoot, "scripts/check-audio-echo-gate.js"), manifestPath];
  if (args.requireCorrelatedDrop) commandArgs.push("--require-correlated-drop");

  try {
    const output = execFileSync(process.execPath, commandArgs, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 20,
    });
    return JSON.parse(output);
  } catch (error) {
    const message = error.stdout || error.stderr || error.message;
    if (args.requireEchoGate) failures.push(`echo_gate_failed:${String(message).slice(0, 240)}`);
    else warnings.push(`echo_gate_skipped_or_failed:${String(message).slice(0, 240)}`);
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const debugPath = path.resolve(args.debugPath || findLatestMeetingDebug() || "");
  const failures = [];
  const warnings = [];

  if (!debugPath || !fs.existsSync(debugPath)) {
    failures.push("meeting_debug_missing");
    console.log(JSON.stringify({ debugPath: debugPath || null, failures, warnings }, null, 2));
    process.exit(1);
  }

  if (args.requireFreshMinutes !== null) {
    const ageMinutes = (Date.now() - fs.statSync(debugPath).mtimeMs) / 60000;
    if (ageMinutes > args.requireFreshMinutes) {
      failures.push(`meeting_debug_not_fresh:${ageMinutes.toFixed(1)}min>${args.requireFreshMinutes}min`);
    }
  }

  const events = readJsonl(debugPath);
  const meetingStart = events.find((event) => event.type === "meeting_start");
  const meetingEnd = [...events].reverse().find((event) => event.type === "meeting_end");
  const manifestCandidate = args.manifestPath || meetingEnd?.payload?.audioDebugManifestPath || "";
  const manifestPath = manifestCandidate ? path.resolve(manifestCandidate) : null;
  const manifest = readManifest(manifestPath, failures);

  const startedAt = meetingStart?.payload?.metadata?.startedAt || manifest?.startedAt;
  const endedAt = meetingEnd?.payload?.endedAt || manifest?.endedAt;
  const durationSec = startedAt && endedAt
    ? Math.max(0, (Date.parse(endedAt) - Date.parse(startedAt)) / 1000)
    : Math.max(0, Number(manifest?.tracks?.mic?.durationMs || 0) / 1000);
  if (durationSec < args.minDurationSec) {
    failures.push(`meeting_too_short:${durationSec.toFixed(1)}s<${args.minDurationSec}s`);
  }

  const rawTranscripts = events
    .filter((event) => event.type === "raw_transcript" && event.payload?.text)
    .map((event) => event.payload);
  const canonicalSegments = events
    .filter((event) => event.type === "canonical_transcript" && event.payload?.text)
    .map((event) => ({
      ...event.payload,
      timestamp: event.payload.timestamp || event.timestamp,
    }));
  const finalCanonicals = canonicalSegments.filter((segment) => segment.final === true);
  const finalMe = finalCanonicals.filter((segment) => segment.role === "me");
  const finalSystem = finalCanonicals.filter((segment) => segment.role !== "me" && segment.role !== "assistant");
  const rawFinalSystem = rawTranscripts.filter((event) => event.channel === "system" && event.final === true);
  const diarizedSystemFinals = rawFinalSystem.filter((event) => event.diarized === true && Number.isFinite(event.speakerId));
  const genericSystemFinals = rawFinalSystem.filter((event) => !(event.diarized === true && Number.isFinite(event.speakerId)));
  const rawByChannel = countBy(rawTranscripts, (event) => event.channel || "unknown");
  const canonicalFinalsByRole = countBy(finalCanonicals, (segment) => segment.role || "unknown");
  const suppressionReasons = countBy(
    events.filter((event) => event.type === "route_result" && event.payload?.suppressed),
    (event) => event.payload.reason || "unknown",
  );

  if (finalSystem.length < args.minSystemFinals) {
    failures.push(`too_few_system_finals:${finalSystem.length}<${args.minSystemFinals}`);
  }
  if (diarizedSystemFinals.length < args.minDiarizedFinals) {
    failures.push(`too_few_diarized_system_finals:${diarizedSystemFinals.length}<${args.minDiarizedFinals}`);
  }
  if (rawFinalSystem.length > 0 && genericSystemFinals.length > diarizedSystemFinals.length) {
    failures.push(`generic_system_finals_exceed_diarized:${genericSystemFinals.length}>${diarizedSystemFinals.length}`);
  }
  if (args.requireMe && finalMe.length === 0) {
    failures.push("no_final_me_segments");
  } else if (finalMe.length === 0) {
    warnings.push("no_final_me_segments_observed");
  }

  const duplicates = countCrossRoleDuplicates(finalCanonicals);
  const falseMeEchoes = countFalseMeEchoes(finalCanonicals);
  if (duplicates.count > args.maxDuplicates) {
    failures.push(`cross_role_duplicates:${duplicates.count}>${args.maxDuplicates}`);
  }
  if (falseMeEchoes.count > args.maxFalseMeEchoes) {
    failures.push(`false_me_echoes:${falseMeEchoes.count}>${args.maxFalseMeEchoes}`);
  }

  const suspectMeFinals = finalMe.filter((segment) => {
    const flags = new Set(segment.qualityFlags || []);
    return flags.has("echo_suspect") || flags.has("mic_rejected");
  });
  if (suspectMeFinals.length > 0) {
    const message = `suspect_me_finals:${suspectMeFinals.length}`;
    if (args.failOnSuspectMe) failures.push(message);
    else warnings.push(message);
  }

  const echoGate = runEchoGate(manifestPath, args, failures, warnings);

  const report = {
    debugPath,
    manifestPath: manifestPath || null,
    meetingId: meetingEnd?.payload?.meetingId || manifest?.meetingId || null,
    startedAt,
    endedAt,
    durationSec: Number(durationSec.toFixed(1)),
    rawTranscripts: {
      total: rawTranscripts.length,
      byChannel: rawByChannel,
      systemFinals: rawFinalSystem.length,
      diarizedSystemFinals: diarizedSystemFinals.length,
      genericSystemFinals: genericSystemFinals.length,
      distinctSystemSpeakerIds: [...new Set(diarizedSystemFinals.map((event) => event.speakerId))].sort(),
    },
    canonical: {
      total: canonicalSegments.length,
      finalTotal: finalCanonicals.length,
      finalMe: finalMe.length,
      finalSystem: finalSystem.length,
      finalsByRole: canonicalFinalsByRole,
      suppressionReasons,
    },
    separation: {
      crossRoleDuplicates: duplicates.count,
      duplicateSamples: duplicates.samples,
      falseMeEchoes: falseMeEchoes.count,
      falseMeEchoSamples: falseMeEchoes.samples,
      suspectMeFinals: suspectMeFinals.slice(0, 5).map(summarizeSegment),
    },
    audio: manifest ? {
      mic: {
        durationMs: manifest.tracks?.mic?.durationMs,
        chunks: manifest.tracks?.mic?.chunks,
        silent: manifest.tracks?.mic?.silent,
      },
      system: {
        durationMs: manifest.tracks?.system?.durationMs,
        chunks: manifest.tracks?.system?.chunks,
        silent: manifest.tracks?.system?.silent,
      },
      echoGate: echoGate ? {
        totalDroppedMicChunks: echoGate.stats?.totalDroppedMicChunks,
        droppedCorrelatedEchoChunks: echoGate.stats?.droppedCorrelatedEchoChunks,
        maxCorrelation: echoGate.stats?.maxCorrelation,
        dropRateAmongGatedMic: echoGate.stats?.dropRateAmongGatedMic,
      } : null,
    } : null,
    failures,
    warnings,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

main();
