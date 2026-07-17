#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const Module = require("module");

const repoRoot = path.resolve(__dirname, "..");
const audioDebugRoot = path.join(
  process.env.HOME || "",
  "Library/Application Support/natively/audio-debug",
);

function findLatestAudioManifest() {
  if (!fs.existsSync(audioDebugRoot)) return "";
  return fs.readdirSync(audioDebugRoot)
    .sort()
    .reverse()
    .map((entry) => path.join(audioDebugRoot, entry, "manifest.json"))
    .find((candidate) => {
      if (!fs.existsSync(candidate)) return false;
      try {
        const candidateManifest = JSON.parse(fs.readFileSync(candidate, "utf8"));
        return Boolean(candidateManifest.tracks?.system?.path && fs.existsSync(candidateManifest.tracks.system.path));
      } catch {
        return false;
      }
    }) || "";
}

const defaultManifest = findLatestAudioManifest();

const manifestPath = path.resolve(process.argv[2] || defaultManifest || path.join(audioDebugRoot, "manifest.json"));
const helperPath =
  process.env.NATIVELY_PARAKEET_HELPER_PATH ||
  path.join(repoRoot, "native-helpers/parakeet-stt-helper/dist/parakeet-stt-helper");

if (!fs.existsSync(manifestPath)) {
  console.error(`Missing audio debug manifest: ${manifestPath}`);
  process.exit(1);
}

if (!fs.existsSync(helperPath)) {
  console.error(`Missing Parakeet helper: ${helperPath}`);
  process.exit(1);
}

process.env.NATIVELY_PARAKEET_HELPER_PATH = helperPath;

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      app: {
        getAppPath: () => repoRoot,
        getPath: (name) => {
          if (name === "home") return process.env.HOME || repoRoot;
          if (name === "userData") {
            return path.join(process.env.HOME || repoRoot, "Library/Application Support/natively");
          }
          return repoRoot;
        },
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const { ParakeetStreamingSTT } = require("../dist-electron/electron/audio/ParakeetStreamingSTT.js");
const { ParakeetBridge } = require("../dist-electron/electron/audio/ParakeetBridge.js");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const systemTrack = manifest.tracks?.system;
if (!systemTrack?.path || !fs.existsSync(systemTrack.path)) {
  console.error(`Manifest has no readable system track: ${manifestPath}`);
  process.exit(1);
}

function readWavPcm(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Not a WAV file: ${filePath}`);
  }

  let offset = 12;
  let sampleRate = 48000;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (id === "fmt ") {
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
    } else if (id === "data") {
      dataStart = chunkStart;
      dataSize = size;
      break;
    }
    offset = chunkStart + size + (size % 2);
  }

  if (dataStart < 0) throw new Error(`WAV data chunk not found: ${filePath}`);
  return { sampleRate, pcm: buffer.subarray(dataStart, dataStart + dataSize) };
}

function rms(pcm) {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2);
    sum += value * value;
  }
  return Math.sqrt(sum / samples);
}

function chooseAudibleWindow(pcm, sampleRate) {
  const chunkBytes = Math.max(2, Math.floor(sampleRate * 0.5) * 2);
  const windowBytes = Math.min(pcm.length, sampleRate * 2 * 45);
  const stepBytes = Math.max(chunkBytes, sampleRate * 2 * 2);
  let best = {
    start: 0,
    score: -1,
    audibleChunks: 0,
    avgRms: 0,
  };

  for (let start = 0; start < pcm.length; start += stepBytes) {
    const end = Math.min(pcm.length, start + windowBytes);
    let score = 0;
    let audibleChunks = 0;
    let totalRms = 0;
    let chunks = 0;

    for (let offset = start; offset + chunkBytes <= end; offset += chunkBytes) {
      const value = rms(pcm.subarray(offset, offset + chunkBytes));
      chunks++;
      totalRms += value;
      if (value >= 120) {
        audibleChunks++;
        score += Math.min(value, 2000);
      } else {
        score += value * 0.1;
      }
    }

    if (
      audibleChunks > best.audibleChunks ||
      (audibleChunks === best.audibleChunks && score > best.score)
    ) {
      best = {
        start,
        score,
        audibleChunks,
        avgRms: chunks > 0 ? totalRms / chunks : 0,
      };
    }
  }

  if (best.audibleChunks > 0) {
    const start = Math.max(0, best.start - sampleRate * 2);
    const end = Math.min(pcm.length, start + windowBytes);
    console.log(
      `[ParakeetGuard] selected window start=${Math.round(start / 2 / sampleRate)}s duration=${Math.round((end - start) / 2 / sampleRate)}s audibleChunks=${best.audibleChunks} avgRms=${best.avgRms.toFixed(1)}`,
    );
    return pcm.subarray(start, end);
  }

  return pcm.subarray(0, windowBytes);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { sampleRate, pcm } = readWavPcm(systemTrack.path);
  const audio = chooseAudibleWindow(pcm, sampleRate);
  const provider = new ParakeetStreamingSTT({
    channel: "system",
    partialCommitIntervalMs: 6000,
    speechEndDebounceMs: 900,
  });
  provider.setSampleRate(sampleRate);

  const events = [];
  const errors = [];
  provider.on("transcript", (event) => {
    events.push({
      final: Boolean(event.isFinal),
      speakerId: event.speakerId,
      text: String(event.text || ""),
    });
  });
  provider.on("error", (error) => errors.push(error?.message || String(error)));

  provider.start();
  // The helper emits "ready" before diarization has necessarily finished
  // loading. Give the streaming provider enough time to receive
  // diarization_ready so this guard tests the intended local path instead of
  // the startup buffer path.
  await sleep(12_000);

  const chunkBytes = Math.max(2, Math.floor(sampleRate * 0.1) * 2);
  for (let offset = 0; offset < audio.length; offset += chunkBytes) {
    provider.write(audio.subarray(offset, Math.min(audio.length, offset + chunkBytes)));
    await sleep(25);
  }

  provider.finalize();
  await sleep(60_000);
  provider.stop();
  ParakeetBridge.getInstance().shutdown();

  const finalEvents = events.filter((event) => event.final);
  const diarizedFinals = finalEvents.filter((event) => Number.isFinite(event.speakerId));
  const genericFinals = finalEvents.filter((event) => !Number.isFinite(event.speakerId));

  const report = {
    manifestPath,
    sampleRate,
    streamedSeconds: Math.round(audio.length / 2 / sampleRate),
    events: events.length,
    finalEvents: finalEvents.length,
    diarizedFinals: diarizedFinals.length,
    genericFinals: genericFinals.length,
    speakers: [...new Set(diarizedFinals.map((event) => event.speakerId))].sort(),
    errors,
    sampleFinals: finalEvents.slice(-5).map((event) => ({
      speakerId: event.speakerId,
      text: event.text.slice(0, 120),
    })),
  };

  console.log(JSON.stringify(report, null, 2));

  if (errors.length > 0) {
    console.error(`Parakeet live diarization emitted errors: ${errors.join(" | ")}`);
    process.exit(1);
  }
  if (diarizedFinals.length === 0) {
    console.error("Parakeet live diarization produced no final transcript with speakerId.");
    process.exit(1);
  }
  if (genericFinals.length > diarizedFinals.length) {
    console.error("Parakeet live diarization produced more generic finals than diarized finals.");
    process.exit(1);
  }
}

main().catch((error) => {
  try {
    ParakeetBridge.getInstance().shutdown();
  } catch {}
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
