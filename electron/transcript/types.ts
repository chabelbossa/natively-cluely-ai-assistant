export type CanonicalSpeakerRole = `speaker_${number}`;

export type CanonicalTranscriptRole =
  | 'me'
  | 'interlocutor'
  | CanonicalSpeakerRole
  | 'uncertain'
  | 'assistant';

export type CanonicalTranscriptSource = 'mic' | 'system' | 'merged';

export type MicRoutingPolicy = 'local_user' | 'conference_floor';

export type TranscriptQualityFlag =
  | 'echo_suppressed'
  | 'possible_overlap'
  | 'low_confidence'
  | 'speaker_uncertain'
  | 'mic_intervention'
  | 'mic_gate_held'
  | 'mic_rejected'
  | 'speaker_stable'
  | 'system_audio'
  | 'trusted_interlocutor'
  | 'trusted_me'
  | 'echo_suspect'
  | 'late_flush_duplicate'
  | 'late_flush_trimmed'
  | 'repaired_context'
  | 'stitched_fragment'
  | 'role_repaired'
  | 'unstable_fragment'
  | 'system_audio_unavailable'
  | 'mic_speaker_fallback'
  | 'conference_floor'
  | 'stt_low_quality'
  | 'raw_debug';

export interface RawTranscriptSegment {
  channel: 'mic' | 'system';
  provider: string;
  speaker: string;
  text: string;
  timestamp: number;
  final: boolean;
  confidence?: number;
  speakerId?: number;
  diarized?: boolean;
  systemAudioActive?: boolean;
  systemAudioSilent?: boolean;
  systemAudioLevel?: { rms: number; peak: number } | null;
  micGateActive?: boolean;
}

export interface CanonicalTranscriptSegment {
  id: string;
  role: CanonicalTranscriptRole;
  source: CanonicalTranscriptSource;
  speaker: string;
  text: string;
  timestamp: number;
  final: boolean;
  confidence?: number;
  qualityFlags: TranscriptQualityFlag[];
  rawSpeaker?: string;
  provider?: string;
  speakerId?: number;
}

export interface TranscriptRouteResult {
  segment?: CanonicalTranscriptSegment;
  suppressed?: boolean;
  reason?: string;
  matchedSpeaker?: string;
  similarity?: number;
}
