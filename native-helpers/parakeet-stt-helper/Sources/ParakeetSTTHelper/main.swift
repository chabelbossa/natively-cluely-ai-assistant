import Foundation
import FluidAudio

struct HelperEvent: Encodable {
    let type: String
    let session_id: String?
    let text: String?
    let confidence: Float?
    let error: String?
    let state: String?
    let processing_ms: Double?
    let rtfx: Float?
    let speaker_id: String?
    let diarization_segments: [DiarizationSegmentEvent]?

    init(
        type: String,
        sessionId: String? = nil,
        text: String? = nil,
        confidence: Float? = nil,
        error: String? = nil,
        state: String? = nil,
        processingMs: Double? = nil,
        rtfx: Float? = nil,
        speakerId: String? = nil,
        diarizationSegments: [DiarizationSegmentEvent]? = nil
    ) {
        self.type = type
        self.session_id = sessionId
        self.text = text
        self.confidence = confidence
        self.error = error
        self.state = state
        self.processing_ms = processingMs
        self.rtfx = rtfx
        self.speaker_id = speakerId
        self.diarization_segments = diarizationSegments
    }
}

struct DiarizationSegmentEvent: Encodable {
    let speaker_id: String
    let start_time: Float
    let end_time: Float
    let quality: Float
}

struct SessionState {
    var channel: String = "unknown"
    var samples: [Float] = []
    var lastPartialSampleCount = 0
    var lastPartialText = ""
    var isPartialRunning = false
    var generation = 0
    /// Cumulative offset in seconds for samples already diarized and discarded
    var diarizedTimeOffset: Double = 0

    init(channel: String = "unknown", diarizedTimeOffset: Double = 0) {
        self.channel = channel
        self.diarizedTimeOffset = diarizedTimeOffset
    }
}

actor ParakeetEngine {
    private let encoder = JSONEncoder()
    private var asrManager: AsrManager?
    private var decoderLayerCount = 2
    private var sessions: [String: SessionState] = [:]

    // Diarization
    private var diarizerManager: DiarizerManager?
    private var diarizationAvailable = false
    private var diarizationStatusState = "diarization_unavailable"
    private var diarizationStatusError: String?

    private let sampleRate = 16_000
    private let minPartialSamples = 16_000
    private let minNewPartialSamples = 8_000
    private let maxPartialWindowSamples = 192_000
    private let trailingSilenceSamples = 8_000

    func prepare() async {
        emit(.init(type: "status", state: "warming_up"))

        guard hasRequiredParakeetCache() else {
            emit(.init(
                type: "error",
                error: "Parakeet V3 model cache missing. Expected FluidAudio cache at ~/Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3"
            ))
            return
        }

        do {
            let models = try await AsrModels.loadFromCache(configuration: nil, version: .v3)
            let manager = AsrManager(config: .default)
            try await manager.loadModels(models)
            self.asrManager = manager
            self.decoderLayerCount = await manager.decoderLayerCount
        } catch {
            emit(.init(type: "error", error: "Failed to load Parakeet V3 from cache: \(error.localizedDescription)"))
            return
        }

        diarizationStatusState = "loading_diarization"
        diarizationStatusError = nil
        emit(.init(type: "ready", state: "ready"))

        // Load diarization after ASR is ready so missing or first-time
        // diarization models never block live transcription startup.
        Task {
            await self.loadDiarizationModels()
        }
    }

    private func loadDiarizationModels() async {
        let skipDiarization = ProcessInfo.processInfo.environment["NATIVELY_NO_DIARIZATION"] != nil
        if skipDiarization {
            diarizationStatusState = "diarization_skipped"
            diarizationStatusError = nil
            emit(.init(type: "status", state: "diarization_skipped"))
            return
        }

        diarizationStatusState = "loading_diarization"
        diarizationStatusError = nil
        emit(.init(type: "status", state: "loading_diarization"))

        do {
            let diarModels = try await loadDiarizerModelsWithoutSurprises()

            let config = DiarizerConfig(
                clusteringThreshold: 0.7,
                minSpeechDuration: 0.8,
                minEmbeddingUpdateDuration: 1.5,
                chunkDuration: 10.0,
                chunkOverlap: 0.0
            )
            let manager = DiarizerManager(config: config)
            manager.initialize(models: diarModels)

            self.diarizerManager = manager
            self.diarizationAvailable = true
            self.diarizationStatusState = "diarization_ready"
            self.diarizationStatusError = nil
            emit(.init(type: "status", state: "diarization_ready"))
        } catch {
            // Diarization is optional — ASR still works
            self.diarizationAvailable = false
            self.diarizationStatusState = "diarization_unavailable"
            self.diarizationStatusError = "Diarization models failed to load: \(error.localizedDescription)"
            emit(.init(type: "status", error: diarizationStatusError, state: "diarization_unavailable"))
        }
    }

    private func loadDiarizerModelsWithoutSurprises() async throws -> DiarizerModels {
        let modelDirectory = DiarizerModels.defaultModelsDirectory()
        let segmentationModel = modelDirectory.appendingPathComponent(ModelNames.Diarizer.segmentationFile)
        let embeddingModel = modelDirectory.appendingPathComponent(ModelNames.Diarizer.embeddingFile)
        let fileManager = FileManager.default

        if fileManager.fileExists(atPath: segmentationModel.path),
           fileManager.fileExists(atPath: embeddingModel.path) {
            FileHandle.standardError.write(
                "[ParakeetHelper] Loading diarization models from cache: \(modelDirectory.path)\n".data(using: .utf8)!
            )
            return try await DiarizerModels.load(
                localSegmentationModel: segmentationModel,
                localEmbeddingModel: embeddingModel
            )
        }

        let allowDownload = ProcessInfo.processInfo.environment["NATIVELY_PARAKEET_ALLOW_DIARIZATION_DOWNLOAD"] == "1"
        guard allowDownload else {
            throw NSError(
                domain: "NativelyParakeet",
                code: 1001,
                userInfo: [
                    NSLocalizedDescriptionKey:
                        "FluidAudio diarization models are missing at \(modelDirectory.path). Set NATIVELY_PARAKEET_ALLOW_DIARIZATION_DOWNLOAD=1 to fetch pyannote_segmentation and wespeaker_v2."
                ]
            )
        }

        FileHandle.standardError.write(
            "[ParakeetHelper] Diarization cache missing. Downloading FluidAudio diarization models once...\n".data(using: .utf8)!
        )
        return try await DiarizerModels.download()
    }

    func handle(_ line: String) async -> Bool {
        guard let data = line.data(using: .utf8) else { return true }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            emit(.init(type: "error", error: "Invalid NDJSON command"))
            return true
        }

        switch type {
        case "start_session":
            guard let sessionId = json["session_id"] as? String else {
                emit(.init(type: "error", error: "Missing session_id"))
                return true
            }
            let channel = json["channel"] as? String ?? "unknown"
            sessions[sessionId] = SessionState(channel: channel)
            // Keep one speaker manager for the system stream. The mic stream is
            // intentionally not diarized and must not reset the system speaker IDs.
            if channel == "system" {
                diarizerManager?.speakerManager.reset()
                emit(.init(
                    type: "status",
                    sessionId: sessionId,
                    error: diarizationStatusError,
                    state: diarizationStatusState
                ))
            }
            emit(.init(type: "status", sessionId: sessionId, state: "streaming"))

        case "audio":
            guard let sessionId = json["session_id"] as? String,
                  let base64 = json["audio"] as? String,
                  let audioData = Data(base64Encoded: base64) else {
                emit(.init(type: "error", error: "Invalid audio command"))
                return true
            }
            await appendAudio(audioData, sessionId: sessionId)

        case "speech_end":
            guard let sessionId = json["session_id"] as? String else {
                emit(.init(type: "error", error: "Missing session_id"))
                return true
            }
            await finalizeSession(sessionId)

        case "stop_session":
            if let sessionId = json["session_id"] as? String {
                sessions.removeValue(forKey: sessionId)
                emit(.init(type: "status", sessionId: sessionId, state: "stopped"))
            }

        case "shutdown":
            diarizerManager?.cleanup()
            return false

        default:
            emit(.init(type: "error", error: "Unknown command: \(type)"))
        }

        return true
    }

    private func appendAudio(_ data: Data, sessionId: String) async {
        if sessions[sessionId] == nil {
            sessions[sessionId] = SessionState()
        }

        let samples = Self.convertPCM16ToFloat(data)
        guard !samples.isEmpty else { return }

        sessions[sessionId]?.samples.append(contentsOf: samples)
        maybeRunPartial(sessionId)
    }

    private func maybeRunPartial(_ sessionId: String) {
        guard var session = sessions[sessionId] else { return }
        let total = session.samples.count
        guard !session.isPartialRunning else { return }
        guard total >= minPartialSamples else { return }
        guard total - session.lastPartialSampleCount >= minNewPartialSamples else { return }
        guard asrManager != nil else { return }

        session.isPartialRunning = true
        session.lastPartialSampleCount = total
        let generation = session.generation
        let snapshot = Array(session.samples.suffix(maxPartialWindowSamples))
        sessions[sessionId] = session

        Task {
            await self.transcribePartial(sessionId: sessionId, samples: snapshot, generation: generation)
        }
    }

    private func transcribePartial(sessionId: String, samples: [Float], generation: Int) async {
        defer {
            if var session = sessions[sessionId], session.generation == generation {
                session.isPartialRunning = false
                sessions[sessionId] = session
            }
        }

        guard let manager = asrManager else { return }
        var audio = samples
        if audio.count + trailingSilenceSamples < maxPartialWindowSamples {
            audio += [Float](repeating: 0, count: trailingSilenceSamples)
        }

        do {
            var decoderState = TdtDecoderState.make(decoderLayers: decoderLayerCount)
            let started = Date()
            let result = try await manager.transcribe(audio, decoderState: &decoderState)
            let text = TextNormalizer.shared.normalizeSentence(result.text)
                .trimmingCharacters(in: .whitespacesAndNewlines)

            guard var session = sessions[sessionId], session.generation == generation else { return }
            if !text.isEmpty && text != session.lastPartialText {
                session.lastPartialText = text
                sessions[sessionId] = session
                // Partials don't include diarization (too expensive for real-time)
                emit(.init(
                    type: "partial",
                    sessionId: sessionId,
                    text: text,
                    confidence: result.confidence,
                    processingMs: Date().timeIntervalSince(started) * 1000,
                    rtfx: result.rtfx
                ))
            }
        } catch {
            emit(.init(type: "error", sessionId: sessionId, error: "Partial transcription failed: \(error.localizedDescription)"))
        }
    }

    private func finalizeSession(_ sessionId: String) async {
        guard var session = sessions[sessionId] else { return }
        session.generation += 1
        session.isPartialRunning = false
        let samples = session.samples
        let timeOffset = session.diarizedTimeOffset
        let channel = session.channel
        sessions[sessionId] = session

        guard samples.count >= sampleRate / 2 else {
            sessions[sessionId] = SessionState(channel: channel, diarizedTimeOffset: timeOffset)
            return
        }

        guard let manager = asrManager else {
            emit(.init(type: "error", sessionId: sessionId, error: "Parakeet model is not loaded"))
            return
        }

        do {
            // ASR transcription
            var audio = samples
            audio += [Float](repeating: 0, count: sampleRate)
            var decoderState = TdtDecoderState.make(decoderLayers: decoderLayerCount)
            let started = Date()
            let result = try await manager.transcribe(audio, decoderState: &decoderState)
            let text = TextNormalizer.shared.normalizeSentence(result.text)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let asrMs = Date().timeIntervalSince(started) * 1000

            // Diarization (runs on the same audio that was just transcribed)
            var speakerId: String? = nil
            var diarSegments: [DiarizationSegmentEvent]? = nil

            if channel == "system", diarizationAvailable, let diarizer = diarizerManager, !samples.isEmpty {
                do {
                    let diarStarted = Date()
                    let diarResult = try diarizer.performCompleteDiarization(
                        samples,
                        sampleRate: sampleRate,
                        atTime: timeOffset
                    )
                    let diarMs = Date().timeIntervalSince(diarStarted) * 1000

                    // Find the dominant speaker (longest total duration)
                    var speakerDurations: [String: Float] = [:]
                    var segmentEvents: [DiarizationSegmentEvent] = []

                    for segment in diarResult.segments {
                        speakerDurations[segment.speakerId, default: 0] += segment.durationSeconds
                        segmentEvents.append(DiarizationSegmentEvent(
                            speaker_id: segment.speakerId,
                            start_time: segment.startTimeSeconds,
                            end_time: segment.endTimeSeconds,
                            quality: segment.qualityScore
                        ))
                    }

                    speakerId = speakerDurations.max(by: { $0.value < $1.value })?.key
                    if !segmentEvents.isEmpty {
                        diarSegments = segmentEvents
                    }

                    // Log diarization performance
                    let speakerCount = Set(diarResult.segments.map(\.speakerId)).count
                    FileHandle.standardError.write(
                        "[ParakeetHelper] Diarization: \(String(format: "%.0f", diarMs))ms, \(speakerCount) speakers, \(diarResult.segments.count) segments, dominant=\(speakerId ?? "none")\n".data(using: .utf8)!
                    )
                } catch {
                    // Diarization failure is non-fatal — emit transcript without speaker
                    FileHandle.standardError.write(
                        "[ParakeetHelper] Diarization failed (non-fatal): \(error.localizedDescription)\n".data(using: .utf8)!
                    )
                }
            }

            // Reset session buffer for the next utterance
            let audioDuration = Double(samples.count) / Double(sampleRate)
            let nextTimeOffset = channel == "system" ? timeOffset + audioDuration : timeOffset
            sessions[sessionId] = SessionState(channel: channel, diarizedTimeOffset: nextTimeOffset)

            if !text.isEmpty {
                emit(.init(
                    type: "final",
                    sessionId: sessionId,
                    text: text,
                    confidence: result.confidence,
                    processingMs: asrMs,
                    rtfx: result.rtfx,
                    speakerId: speakerId,
                    diarizationSegments: diarSegments
                ))
            }
        } catch {
            sessions[sessionId] = SessionState(channel: channel, diarizedTimeOffset: timeOffset)
            emit(.init(type: "error", sessionId: sessionId, error: "Final transcription failed: \(error.localizedDescription)"))
        }
    }

    private func hasRequiredParakeetCache() -> Bool {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let modelDir = home
            .appendingPathComponent("Library/Application Support/FluidAudio/Models/parakeet-tdt-0.6b-v3")

        let required = [
            "Encoder.mlmodelc",
            "Decoder.mlmodelc",
            "JointDecision.mlmodelc",
            "Preprocessor.mlmodelc",
        ]

        return required.allSatisfy { name in
            var isDirectory: ObjCBool = false
            return FileManager.default.fileExists(
                atPath: modelDir.appendingPathComponent(name).path,
                isDirectory: &isDirectory
            ) && isDirectory.boolValue
        }
    }

    private func emit(_ event: HelperEvent) {
        do {
            let data = try encoder.encode(event)
            if let line = String(data: data, encoding: .utf8) {
                print(line)
                fflush(stdout)
            }
        } catch {
            print("{\"type\":\"error\",\"error\":\"Failed to encode helper event\"}")
            fflush(stdout)
        }
    }

    private static func convertPCM16ToFloat(_ data: Data) -> [Float] {
        let sampleCount = data.count / MemoryLayout<Int16>.size
        var samples = [Float]()
        samples.reserveCapacity(sampleCount)

        data.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress else { return }
            for index in 0..<sampleCount {
                let offset = index * MemoryLayout<Int16>.size
                let value = baseAddress.loadUnaligned(fromByteOffset: offset, as: Int16.self)
                samples.append(max(-1.0, min(Float(Int16(littleEndian: value)) / 32767.0, 1.0)))
            }
        }

        return samples
    }
}

@main
struct ParakeetSTTHelper {
    static func main() async {
        let engine = ParakeetEngine()
        await engine.prepare()

        while let line = readLine() {
            let shouldContinue = await engine.handle(line)
            if !shouldContinue { break }
        }
    }
}
