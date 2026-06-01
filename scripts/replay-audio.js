#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const MEDIA_EXTENSIONS = new Set(['.mp4', '.mov', '.m4a', '.mp3', '.wav', '.webm']);

function parseArgs(argv) {
  const args = {
    manifestPath: null,
    mediaPath: null,
    source: 'auto',
    mediaMode: 'mixed',
    referencePath: null,
    outputDir: null,
    provider: 'parakeet',
    helperPath: null,
    maxSeconds: undefined,
    track: 'both',
    vadThreshold: undefined,
    minSpeechMs: undefined,
    endSilenceMs: undefined,
    maxUtteranceMs: undefined,
    meSpeaker: undefined,
    allowDiarizationDownload: true,
    noDiarization: false,
    utteranceTimeoutMs: undefined,
    writeFixture: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--') continue;
    if (!token.startsWith('--') && !args.manifestPath) {
      if (isMediaPath(token)) args.mediaPath = token;
      else args.manifestPath = token;
      continue;
    }

    const readValue = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${token}`);
      }
      i += 1;
      return value;
    };

    switch (token) {
      case '--media':
        args.mediaPath = readValue();
        break;
      case '--source':
        args.source = readValue();
        break;
      case '--media-mode':
        args.mediaMode = readValue();
        break;
      case '--reference':
        args.referencePath = readValue();
        break;
      case '--output-dir':
        args.outputDir = readValue();
        break;
      case '--provider':
        args.provider = readValue();
        break;
      case '--helper-path':
        args.helperPath = readValue();
        break;
      case '--max-seconds':
        args.maxSeconds = Number(readValue());
        break;
      case '--track':
        args.track = readValue();
        break;
      case '--vad-threshold':
        args.vadThreshold = Number(readValue());
        break;
      case '--min-speech-ms':
        args.minSpeechMs = Number(readValue());
        break;
      case '--end-silence-ms':
        args.endSilenceMs = Number(readValue());
        break;
      case '--max-utterance-ms':
        args.maxUtteranceMs = Number(readValue());
        break;
      case '--me-speaker':
        args.meSpeaker = readValue();
        break;
      case '--no-diarization-download':
        args.allowDiarizationDownload = false;
        break;
      case '--no-diarization':
        args.noDiarization = true;
        break;
      case '--utterance-timeout-ms':
        args.utteranceTimeoutMs = Number(readValue());
        break;
      case '--no-fixture':
        args.writeFixture = false;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  pnpm run meeting:replay:audio -- [manifest.json] [options]
  pnpm run meeting:replay:audio -- [meeting.mp4] [options]

If no input is provided, auto mode prefers a single root MP4/MOV when present,
then falls back to the latest local Natively audio-debug manifest.

Options:
  --media <path>               Replay a media file by extracting audio with ffmpeg
  --source auto|media|debug     Source autodetection mode (default auto)
  --media-mode mixed           Media extraction mode (currently mixed)
  --reference <path>           Reference transcript markdown for recall metrics
  --output-dir <path>          Directory for replay outputs
  --provider parakeet          Audio STT replay provider (currently parakeet)
  --helper-path <path>         Parakeet helper executable path
  --max-seconds <n>            Smoke-test only the first n seconds
  --track both|system|mic      Track(s) to replay
  --vad-threshold <n>          Override RMS VAD threshold (media default: 350)
  --min-speech-ms <n>          Minimum utterance length
  --end-silence-ms <n>         Silence needed to close an utterance
  --max-utterance-ms <n>       Force split long utterances
  --me-speaker <name>          Speaker name in the reference transcript
  --no-diarization             Disable Parakeet diarization during replay
  --utterance-timeout-ms <n>   Timeout per detected utterance (default 35000)
  --no-diarization-download    Do not allow first-time diarization model download
  --no-fixture                 Do not write a generated router fixture

Examples:
  pnpm run meeting:replay:audio -- --reference reference_transcription.md --max-seconds 120
  pnpm run meeting:replay:audio -- ./meeting.mp4 --reference reference_transcription.md
  pnpm run meeting:replay:audio -- "/Users/user/Library/Application Support/natively/audio-debug/audio_x/manifest.json" --reference reference_transcription.md
`);
}

function ensureElectronBuild() {
  const runnerPath = path.join(root, 'dist-electron/electron/replay/AudioReplayRunner.js');
  try {
    fs.accessSync(runnerPath);
    return runnerPath;
  } catch {
    console.log('[audio-replay] dist-electron missing; building Electron sources first...');
    const build = spawnSync('npm', ['run', 'build:electron'], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
    });
    if (build.status !== 0) process.exit(build.status || 1);
    return runnerPath;
  }
}

function isMediaPath(filePath) {
  return MEDIA_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function findRootMediaFile() {
  const candidates = fs.readdirSync(root)
    .filter(name => MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .map(name => path.join(root, name))
    .filter(filePath => fs.statSync(filePath).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates.length === 1 ? candidates[0] : null;
}

function makeDefaultMediaOutputDir(mediaPath) {
  const slug = path.basename(mediaPath, path.extname(mediaPath))
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .slice(0, 80);
  return path.join(root, '.audio-replay', `media-${slug}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 20,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stderr || result.stdout || ''}`);
  }
  return result.stdout || '';
}

function hasCommand(command) {
  const result = spawnSync('which', [command], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim();
}

function probeMedia(mediaPath) {
  const stdout = runChecked('ffprobe', [
    '-hide_banner',
    '-show_format',
    '-show_streams',
    '-print_format',
    'json',
    mediaPath,
  ]);
  return JSON.parse(stdout);
}

function extractMediaManifest(mediaPath, outputDir, mediaMode) {
  if (!hasCommand('ffmpeg') || !hasCommand('ffprobe')) {
    throw new Error('ffmpeg/ffprobe are required for media replay.');
  }
  if (mediaMode !== 'mixed') {
    throw new Error(`Unsupported --media-mode ${mediaMode}. Use mixed.`);
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const mediaDir = path.join(outputDir, 'media-source');
  fs.mkdirSync(mediaDir, { recursive: true });

  const absoluteMediaPath = path.resolve(root, mediaPath);
  const probe = probeMedia(absoluteMediaPath);
  const audioStream = (probe.streams || []).find(stream => stream.codec_type === 'audio');
  if (!audioStream) {
    throw new Error(`No audio stream found in media file: ${absoluteMediaPath}`);
  }

  const systemPath = path.join(mediaDir, 'system.wav');
  runChecked('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    absoluteMediaPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-c:a',
    'pcm_s16le',
    systemPath,
  ]);

  const diagnostics = buildMediaDiagnostics(absoluteMediaPath, mediaDir, audioStream);
  const stats = fs.statSync(systemPath);
  const duration = Number(audioStream.duration || probe.format?.duration || 0);
  const sampleRate = 48000;
  const manifest = {
    sessionId: `media_${path.basename(absoluteMediaPath, path.extname(absoluteMediaPath)).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80)}`,
    startedAt: probe.format?.tags?.creation_time || new Date(stats.mtimeMs).toISOString(),
    endedAt: undefined,
    metadata: {
      source: 'media',
      mediaPath: absoluteMediaPath,
      mediaMode,
      mediaDurationSeconds: Number.isFinite(duration) ? duration : undefined,
      mediaAudio: {
        codec: audioStream.codec_name,
        sampleRate: Number(audioStream.sample_rate || 0),
        channels: audioStream.channels,
        channelLayout: audioStream.channel_layout,
      },
      diagnostics,
    },
    tracks: {
      system: {
        path: systemPath,
        sampleRate,
        bytes: Math.max(0, stats.size - 44),
        chunks: 0,
        silent: false,
        durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : undefined,
      },
    },
  };
  const manifestPath = path.join(mediaDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
}

function buildMediaDiagnostics(mediaPath, mediaDir, audioStream) {
  const diagnostics = {
    stereoCorrelation: undefined,
    channelsNearlyIdentical: undefined,
    note: undefined,
  };
  if (Number(audioStream.channels || 0) < 2) {
    diagnostics.note = 'Media audio is mono; no channel separation is possible.';
    return diagnostics;
  }

  const leftPath = path.join(mediaDir, 'probe-left.wav');
  const rightPath = path.join(mediaDir, 'probe-right.wav');
  try {
    runChecked('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-t',
      '180',
      '-i',
      mediaPath,
      '-vn',
      '-af',
      'pan=mono|c0=c0',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s16le',
      leftPath,
    ]);
    runChecked('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-t',
      '180',
      '-i',
      mediaPath,
      '-vn',
      '-af',
      'pan=mono|c0=c1',
      '-ar',
      '48000',
      '-c:a',
      'pcm_s16le',
      rightPath,
    ]);
    const correlation = computeWavCorrelation(leftPath, rightPath);
    diagnostics.stereoCorrelation = Number(correlation.toFixed(6));
    diagnostics.channelsNearlyIdentical = correlation >= 0.98;
    diagnostics.note = diagnostics.channelsNearlyIdentical
      ? 'Stereo channels are almost identical; this media cannot separate local and remote speakers by channel.'
      : 'Stereo channels differ; channel-based experiments may be useful.';
  } catch (error) {
    diagnostics.note = `Unable to compute stereo diagnostics: ${error.message}`;
  }
  return diagnostics;
}

function readWavPcm(filePath) {
  const buffer = fs.readFileSync(filePath);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') return buffer.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  return Buffer.alloc(0);
}

function computeWavCorrelation(leftPath, rightPath) {
  const left = readWavPcm(leftPath);
  const right = readWavPcm(rightPath);
  const samples = Math.floor(Math.min(left.length, right.length) / 2);
  if (!samples) return 0;
  let sumLeftSq = 0;
  let sumRightSq = 0;
  let sumCross = 0;
  for (let i = 0; i < samples; i += 1) {
    const leftSample = left.readInt16LE(i * 2);
    const rightSample = right.readInt16LE(i * 2);
    sumLeftSq += leftSample * leftSample;
    sumRightSq += rightSample * rightSample;
    sumCross += leftSample * rightSample;
  }
  const denominator = Math.sqrt(sumLeftSq * sumRightSq);
  return denominator ? sumCross / denominator : 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runnerPath = ensureElectronBuild();
  const { runAudioReplay, findLatestAudioDebugManifest } = require(runnerPath);

  const rootMediaPath = args.source !== 'debug' ? findRootMediaFile() : null;
  const selectedMediaPath = args.mediaPath
    || (args.source === 'media' ? rootMediaPath : null)
    || (!args.manifestPath && args.source === 'auto' && rootMediaPath ? rootMediaPath : null);
  const selectedOutputDir = args.outputDir
    ? path.resolve(root, args.outputDir)
    : selectedMediaPath
      ? makeDefaultMediaOutputDir(selectedMediaPath)
      : undefined;

  const manifestPath = selectedMediaPath
    ? extractMediaManifest(selectedMediaPath, selectedOutputDir, args.mediaMode)
    : args.manifestPath
      ? path.resolve(root, args.manifestPath)
      : findLatestAudioDebugManifest();

  if (!manifestPath) {
    console.error('[audio-replay] No manifest provided and no local audio-debug manifest found.');
    process.exit(2);
  }

  const referencePath = args.referencePath
    ? path.resolve(root, args.referencePath)
    : (fs.existsSync(path.join(root, 'reference_transcription.md')) ? path.join(root, 'reference_transcription.md') : undefined);

  console.log(`[audio-replay] manifest=${manifestPath}`);
  if (referencePath) console.log(`[audio-replay] reference=${referencePath}`);

  const report = await runAudioReplay({
    ...args,
    manifestPath,
    outputDir: selectedOutputDir || args.outputDir,
    referencePath,
    vadThreshold: args.vadThreshold ?? (selectedMediaPath ? 350 : undefined),
  });

  const compact = {
    name: report.name,
    provider: report.provider,
    meetingId: report.meetingId,
    outputDir: report.outputDir,
    tracks: report.tracks,
    rawEvents: report.rawEvents,
    canonicalSegments: report.canonicalSegments,
    suppressedSegments: report.suppressedSegments,
    finalInterlocutorSegments: report.finalInterlocutorSegments,
    meSegments: report.meSegments,
    duplicateCount: report.duplicateCount,
    falseMeEchoCount: report.falseMeEchoCount,
    reference: report.reference && {
      turns: report.reference.turns,
      meSpeaker: report.reference.meSpeaker,
      overallRecall: Number((report.reference.overallRecall || 0).toFixed(3)),
      meRecall: report.reference.meRecall === undefined ? undefined : Number(report.reference.meRecall.toFixed(3)),
      interlocutorRecall: report.reference.interlocutorRecall === undefined ? undefined : Number(report.reference.interlocutorRecall.toFixed(3)),
    },
    warnings: report.warnings,
    failures: report.failures,
    files: report.files,
  };

  console.log(JSON.stringify(compact, null, 2));
  process.exit(report.failures.length ? 1 : 0);
}

main().catch((error) => {
  console.error('[audio-replay] failed:', error?.stack || error?.message || error);
  process.exit(1);
});
