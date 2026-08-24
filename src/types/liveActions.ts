export type LiveActionStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface LiveActionRequest {
  actionId: string;
  question?: string;
  imagePaths?: string[];
  problemStatement?: string;
  intent?: string;
  userRequest?: string;
  /** Serve the pre-computed answer when available; silently fall back to a fresh generation otherwise. */
  usePrepared?: boolean;
}

export interface LiveActionEventBase {
  actionId: string;
}

export interface LiveActionErrorPayload extends LiveActionEventBase {
  error: string;
  mode: string;
  code?: string;
}
