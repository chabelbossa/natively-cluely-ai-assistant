export type LiveActionStatus = 'pending' | 'streaming' | 'completed' | 'failed' | 'cancelled';

export interface LiveActionRequest {
  actionId: string;
  question?: string;
  imagePaths?: string[];
  problemStatement?: string;
  intent?: string;
  userRequest?: string;
}

export interface LiveActionEventBase {
  actionId: string;
}

export interface LiveActionErrorPayload extends LiveActionEventBase {
  error: string;
  mode: string;
  code?: string;
}
