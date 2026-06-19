#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const DEFAULT_AUDIO_DEBUG_DIR = path.join(
  process.env.HOME || "",
  "Library/Application Support/natively/audio-debug",
);

const MIC_GATE_REOPEN_DELAY_MS = 1200;
const MIC_GATE_RMS_THRESHOLD = 50;
const MIC_GATE_PEAK_THRESHOLD = 150;
const MIC_GATE_OVERRIDE_RMS = 900;
const MIC_GATE_OVERRIDE_PEAK = 3000;
const MIC_GATE_DIRECT_SPEECH_RATIO = 1.35;
const MIC_GATE_DOMINANT_DIRECT_SPEECH_RATIO = 2.2;
const MIC_GATE_ECHO_HISTORY_MS = 1800;
const MIC_GATE_MAX_ECHO_FRAMES = 96;
const MIC_GATE_ECHO_CORRELATION_THRESHOLD = 0.78;

function usage() {
  console.log(`
Usage:
  npm run meeting:echo-gate:guard -- [manifest.json] [options]

Options:
  --manifest <path>             Audio debug manifest. Defaults to latest local manifest.
  --min-system-loud <n>         Minimum loud system chunks required (default 100).
  --min-gated-mic <n>           Minimum gated mic chunks required (default 100).
  --require-correlated-drop     Fail if no correlated echo chunk is detected.

This guard replays raw audio-debug chunks through the same mic/system echo-gate
heuristics used by electron/main.ts. It validates the source-level separation
path before STT text deduplication gets involved.
`);
}

function parseArgs(argv) {
  const args = {
    manifestPath: null,
    minSystemLoud: 100,
    minGatedMic: 100,
    requireCorrelatedDrop: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--") && !args.manifestPath) {
      args.manifestPath = token;
      continue;
    }

    const readValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
      i += 1;
      return value;
    };

    switch (token) {
      case "--manifest":
        args.manifestPath = readValue();
        break;
      case "--min-system-loud":
        args.minSystemLoud = Number(readValue());
        break;
      case "--min-gated-mic":
        args.minGatedMic = Number(readValue());
        break;
      case "--require-correlated-drop":
        args.requireCorrelatedDrop = true;
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

function findLatestManifest() {
  if (!fs.existsSync(DEFAULT_AUDIO_DEBUG_DIR)) return null;

  const manifests = [];
  for (const name of fs.readdirSync(DEFAULT_AUDIO_DEBUG_DIR)) {
    const manifestPath = path.join(DEFAULT_AUDIO_DEBUG_DIR, name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    const stat = fs.statSync(manifestPath);
    manifests.push({ manifestPath, mtimeMs: stat.mtimeMs });
  }

  manifests.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return manifests[0]?.manifestPath || null;
}

function readManifest(filePath) {
  const manifestPath = path.resolve(filePath || findLatestManifest() || "");
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    throw new Error(`Missing audio debug manifest: ${manifestPath || "(latest not found)"}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const track of ["mic", "system"]) {
    const info = manifest.tracks?.[track];
    if (!info?.path || !fs.existsSync(info.path)) {
      throw new Error(`Manifest has no readable ${track} WAV: ${manifestPath}`);
    }
    if (!info?.chunksPath || !fs.existsSync(info.chunksPath)) {
      throw new Error(`Manifest has no readable ${track} chunks jsonl: ${manifestPath}`);
    }
  }

  return { manifestPath, manifest };
}

function readWavData(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Not a WAV file: ${filePath}`);
  }

  let offset = 12;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (id === "data") {
      dataStart = chunkStart;
      dataSize = size;
      break;
    }
    offset = chunkStart + size + (size % 2);
  }

  if (dataStart < 0) throw new Error(`WAV data chunk not found: ${filePath}`);
  return { buffer, dataStart, dataSize };
}

function readChunks(filePath, track) {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => ({ ...JSON.parse(line), track }));
}

function chunkFor(event, wav) {
  const source = wav[event.track];
  const start = source.dataStart + event.offsetBytes;
  return source.buffer.subarray(start, start + event.bytes);
}

function getPcm16Level(chunk) {
  const sampleCount = Math.floor(chunk.length / 2);
  let sumSquares = 0;
  let peak = 0;

  for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
    const value = chunk.readInt16LE(offset);
    sumSquares += value * value;
    peak = Math.max(peak, Math.abs(value));
  }

  return {
    rms: sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0,
    peak,
  };
}

function createPcmEnvelope(chunk) {
  const sampleCount = Math.floor(chunk.length / 2);
  if (sampleCount < 32) return null;

  const bucketCount = 32;
  const sums = new Float64Array(bucketCount);
  const counts = new Uint16Array(bucketCount);

  for (let i = 0; i < sampleCount; i += 1) {
    const value = chunk.readInt16LE(i * 2);
    const bucket = Math.min(bucketCount - 1, Math.floor((i * bucketCount) / sampleCount));
    sums[bucket] += value * value;
    counts[bucket] += 1;
  }

  const envelope = new Float32Array(bucketCount);
  for (let i = 0; i < bucketCount; i += 1) {
    envelope[i] = counts[i] > 0 ? Math.sqrt(sums[i] / counts[i]) : 0;
  }
  return envelope;
}

function getEnvelopeCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 8) return 0;

  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;

  let numerator = 0;
  let energyA = 0;
  let energyB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    numerator += da * db;
    energyA += da * da;
    energyB += db * db;
  }

  const denominator = Math.sqrt(energyA * energyB);
  return denominator > 1e-6 ? Math.abs(numerator / denominator) : 0;
}

function simulateEchoGate(manifest) {
  const wav = {
    mic: readWavData(manifest.tracks.mic.path),
    system: readWavData(manifest.tracks.system.path),
  };

  const events = [
    ...readChunks(manifest.tracks.system.chunksPath, "system"),
    ...readChunks(manifest.tracks.mic.chunksPath, "mic"),
  ].sort((a, b) => a.timestamp - b.timestamp || (a.track === "system" ? -1 : 1));

  let micGated = false;
  let lastLoudAt = -Infinity;
  let lastSystemLevel = { rms: 0, peak: 0 };
  let history = [];

  const stats = {
    systemChunks: 0,
    systemLoudChunks: 0,
    micChunks: 0,
    micGatedChunks: 0,
    passedStrongMicChunks: 0,
    droppedQuietEchoChunks: 0,
    droppedRelativeEchoChunks: 0,
    droppedCorrelatedEchoChunks: 0,
    correlatedStrongMicVetoChunks: 0,
    maxCorrelation: 0,
    sampleCorrelatedDrops: [],
  };

  const prune = (now) => {
    history = history
      .filter((frame) => frame.timestamp >= now - MIC_GATE_ECHO_HISTORY_MS)
      .slice(-MIC_GATE_MAX_ECHO_FRAMES);
  };

  const rememberSystemFrame = (chunk, level, timestamp) => {
    prune(timestamp);
    const isAudible = level.rms > MIC_GATE_RMS_THRESHOLD || level.peak > MIC_GATE_PEAK_THRESHOLD;
    if (!isAudible) return;
    const envelope = createPcmEnvelope(chunk);
    if (!envelope) return;
    history.push({ timestamp, envelope, rms: level.rms, peak: level.peak });
    if (history.length > MIC_GATE_MAX_ECHO_FRAMES) {
      history = history.slice(-MIC_GATE_MAX_ECHO_FRAMES);
    }
  };

  const findCorrelatedSystemEcho = (chunk, timestamp) => {
    prune(timestamp);
    if (history.length === 0) return null;
    const micEnvelope = createPcmEnvelope(chunk);
    if (!micEnvelope) return null;

    let best = null;
    for (const frame of history) {
      const correlation = getEnvelopeCorrelation(micEnvelope, frame.envelope);
      if (!best || correlation > best.correlation) {
        best = {
          correlation,
          ageMs: timestamp - frame.timestamp,
          rms: frame.rms,
          peak: frame.peak,
        };
      }
    }

    if (best) stats.maxCorrelation = Math.max(stats.maxCorrelation, best.correlation);
    return best && best.correlation >= MIC_GATE_ECHO_CORRELATION_THRESHOLD ? best : null;
  };

  for (const event of events) {
    const chunk = chunkFor(event, wav);
    const level = getPcm16Level(chunk);

    if (event.track === "system") {
      stats.systemChunks += 1;
      lastSystemLevel = level;
      rememberSystemFrame(chunk, level, event.timestamp);
      const isLoud = level.rms > MIC_GATE_RMS_THRESHOLD || level.peak > MIC_GATE_PEAK_THRESHOLD;
      if (isLoud) {
        stats.systemLoudChunks += 1;
        micGated = true;
        lastLoudAt = event.timestamp;
      } else if (micGated && event.timestamp - lastLoudAt > MIC_GATE_REOPEN_DELAY_MS) {
        micGated = false;
      }
      continue;
    }

    stats.micChunks += 1;
    if (micGated && event.timestamp - lastLoudAt > MIC_GATE_REOPEN_DELAY_MS) micGated = false;
    if (!micGated) continue;

    stats.micGatedChunks += 1;
    const systemRms = lastSystemLevel.rms || 0;
    const systemPeak = lastSystemLevel.peak || 0;
    const looksLikeDirectSpeech =
      (level.rms >= MIC_GATE_OVERRIDE_RMS && level.rms >= systemRms * MIC_GATE_DIRECT_SPEECH_RATIO) ||
      (level.peak >= MIC_GATE_OVERRIDE_PEAK && level.peak >= systemPeak * MIC_GATE_DIRECT_SPEECH_RATIO);
    const looksLikeDominantDirectSpeech =
      (systemRms <= 0 || level.rms >= systemRms * MIC_GATE_DOMINANT_DIRECT_SPEECH_RATIO) ||
      (systemPeak <= 0 || level.peak >= systemPeak * MIC_GATE_DOMINANT_DIRECT_SPEECH_RATIO);
    const correlatedEcho = findCorrelatedSystemEcho(chunk, event.timestamp);

    if (correlatedEcho && !looksLikeDominantDirectSpeech) {
      stats.droppedCorrelatedEchoChunks += 1;
      if (looksLikeDirectSpeech) stats.correlatedStrongMicVetoChunks += 1;
      if (stats.sampleCorrelatedDrops.length < 8) {
        stats.sampleCorrelatedDrops.push({
          timestamp: event.timestamp,
          correlation: Number(correlatedEcho.correlation.toFixed(3)),
          ageMs: correlatedEcho.ageMs,
          micRms: Number(level.rms.toFixed(1)),
          systemRms: Number(systemRms.toFixed(1)),
        });
      }
      continue;
    }

    if (looksLikeDirectSpeech) {
      stats.passedStrongMicChunks += 1;
      continue;
    }

    if (level.rms >= MIC_GATE_OVERRIDE_RMS || level.peak >= MIC_GATE_OVERRIDE_PEAK) {
      stats.droppedRelativeEchoChunks += 1;
    } else {
      stats.droppedQuietEchoChunks += 1;
    }
  }

  const totalDropped = stats.droppedQuietEchoChunks +
    stats.droppedRelativeEchoChunks +
    stats.droppedCorrelatedEchoChunks;

  return {
    ...stats,
    totalDroppedMicChunks: totalDropped,
    dropRateAmongGatedMic: Number((totalDropped / Math.max(1, stats.micGatedChunks)).toFixed(3)),
    correlatedDropRateAmongGatedMic: Number((stats.droppedCorrelatedEchoChunks / Math.max(1, stats.micGatedChunks)).toFixed(3)),
    maxCorrelation: Number(stats.maxCorrelation.toFixed(3)),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const { manifestPath, manifest } = readManifest(args.manifestPath);
  const stats = simulateEchoGate(manifest);
  const durationMs = manifest.tracks?.mic?.durationMs || manifest.tracks?.system?.durationMs || 0;

  const report = {
    manifestPath,
    sessionId: manifest.sessionId,
    durationMin: Number((durationMs / 60000).toFixed(1)),
    thresholds: {
      minSystemLoud: args.minSystemLoud,
      minGatedMic: args.minGatedMic,
      requireCorrelatedDrop: args.requireCorrelatedDrop,
    },
    stats,
  };

  console.log(JSON.stringify(report, null, 2));

  if (stats.systemLoudChunks < args.minSystemLoud) {
    throw new Error(`Not enough loud system chunks to exercise mic gate: ${stats.systemLoudChunks} < ${args.minSystemLoud}`);
  }
  if (stats.micGatedChunks < args.minGatedMic) {
    throw new Error(`Not enough gated mic chunks to exercise mic gate: ${stats.micGatedChunks} < ${args.minGatedMic}`);
  }
  if (args.requireCorrelatedDrop && stats.droppedCorrelatedEchoChunks <= 0) {
    throw new Error("Expected at least one correlated echo drop, found none");
  }
}

try {
  main();
} catch (error) {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
}
