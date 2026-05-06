export type CanonicalTranscriptRole =
  | 'me'
  | 'interlocutor'
  | 'speaker_1'
  | 'speaker_2'
  | 'uncertain'
  | 'assistant';

export type CanonicalTranscriptSource = 'mic' | 'system' | 'merged';

export type TranscriptQualityFlag =
  | 'echo_suppressed'
  | 'possible_overlap'
  | 'low_confidence'
  | 'speaker_uncertain'
  | 'mic_intervention'
  | 'system_audio'
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
