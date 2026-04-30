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

    init(
        type: String,
        sessionId: String? = nil,
        text: String? = nil,
        confidence: Float? = nil,
        error: String? = nil,
        state: String? = nil,
        processingMs: Double? = nil,
        rtfx: Float? = nil
    ) {
        self.type = type
        self.session_id = sessionId
        self.text = text
        self.confidence = confidence
        self.error = error
        self.state = state
        self.processing_ms = processingMs
        self.rtfx = rtfx
    }
}

struct SessionState {
    var samples: [Float] = []
    var lastPartialSampleCount = 0
    var lastPartialText = ""
    var isPartialRunning = false
    var generation = 0
}

actor ParakeetEngine {
    private let encoder = JSONEncoder()
    private var asrManager: AsrManager?
    private var decoderLayerCount = 2
    private var sessions: [String: SessionState] = [:]

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
            emit(.init(type: "ready", state: "ready"))
        } catch {
            emit(.init(type: "error", error: "Failed to load Parakeet V3 from cache: \(error.localizedDescription)"))
        }
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
            sessions[sessionId] = SessionState()
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
        sessions[sessionId] = session

        guard samples.count >= sampleRate / 2 else {
            sessions[sessionId] = SessionState()
            return
        }

        guard let manager = asrManager else {
            emit(.init(type: "error", sessionId: sessionId, error: "Parakeet model is not loaded"))
            return
        }

        do {
            var audio = samples
            audio += [Float](repeating: 0, count: sampleRate)
            var decoderState = TdtDecoderState.make(decoderLayers: decoderLayerCount)
            let started = Date()
            let result = try await manager.transcribe(audio, decoderState: &decoderState)
            let text = TextNormalizer.shared.normalizeSentence(result.text)
                .trimmingCharacters(in: .whitespacesAndNewlines)

            sessions[sessionId] = SessionState()
            if !text.isEmpty {
                emit(.init(
                    type: "final",
                    sessionId: sessionId,
                    text: text,
                    confidence: result.confidence,
                    processingMs: Date().timeIntervalSince(started) * 1000,
                    rtfx: result.rtfx
                ))
            }
        } catch {
            sessions[sessionId] = SessionState()
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
