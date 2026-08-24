import type { LiveActionStatus } from '../types/liveActions';

export interface LiveActionMessageBase {
  id: string;
  role: 'user' | 'system' | 'interviewer';
  text: string;
  intent?: string;
  actionId?: string;
  actionStatus?: LiveActionStatus;
  isStreaming?: boolean;
  pendingAction?: boolean;
  modelUsed?: string;
  tokensUsed?: number;
  durationMs?: number;
  serviceTierUsed?: 'fast' | 'standard';
  serviceTierFallback?: boolean;
  precomputed?: boolean;
}

export interface LiveActionMessageMeta {
  modelUsed?: string;
  tokensUsed?: number;
  durationMs?: number;
  serviceTierUsed?: 'fast' | 'standard';
  serviceTierFallback?: boolean;
  precomputed?: boolean;
}

export function resolveLiveActionModelId(
  serviceTierModel?: string,
  actionModel?: string,
  currentModel?: string,
): string | undefined {
  const model = [serviceTierModel, actionModel, currentModel]
    .map((value) => String(value || '').trim())
    .find(Boolean);
  return model || undefined;
}

export function createLiveActionId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `action-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function findActionIndex<T extends LiveActionMessageBase>(messages: T[], actionId: string): number {
  return messages.findIndex((message) => message.actionId === actionId);
}

export function upsertPendingActionMessage<T extends LiveActionMessageBase>(
  messages: T[],
  actionId: string,
  intent: string,
  text: string,
): T[] {
  const index = findActionIndex(messages, actionId);
  if (index >= 0) {
    const updated = [...messages];
    updated[index] = {
      ...updated[index],
      text,
      intent,
      actionId,
      actionStatus: 'pending',
      pendingAction: true,
      isStreaming: true,
    };
    return updated;
  }

  return [
    ...messages,
    {
      id: actionId,
      role: 'system',
      text,
      intent,
      actionId,
      actionStatus: 'pending',
      isStreaming: true,
      pendingAction: true,
    } as T,
  ];
}

export function appendStreamingMessage<T extends LiveActionMessageBase>(
  messages: T[],
  actionId: string,
  intent: string,
  token: string,
): T[] {
  const index = findActionIndex(messages, actionId);
  if (index >= 0) {
    const existing = messages[index];
    if (existing.actionStatus === 'completed' || existing.actionStatus === 'failed' || existing.actionStatus === 'cancelled') {
      return messages;
    }
    const updated = [...messages];
    updated[index] = {
      ...existing,
      text: existing.pendingAction ? token : existing.text + token,
      intent,
      actionId,
      actionStatus: 'streaming',
      pendingAction: false,
      isStreaming: true,
    };
    return updated;
  }

  return [
    ...messages,
    {
      id: actionId,
      role: 'system',
      text: token,
      intent,
      actionId,
      actionStatus: 'streaming',
      isStreaming: true,
      pendingAction: false,
    } as T,
  ];
}

export function finalizeStreamingMessage<T extends LiveActionMessageBase>(
  messages: T[],
  actionId: string,
  intent: string,
  text: string,
  meta?: LiveActionMessageMeta,
  status: LiveActionStatus = 'completed',
): T[] {
  const index = findActionIndex(messages, actionId);
  if (index >= 0) {
    const existingStatus = messages[index].actionStatus;
    const existingIsTerminal = existingStatus === 'completed' || existingStatus === 'failed' || existingStatus === 'cancelled';
    if (existingIsTerminal) {
      if (existingStatus !== status || !meta) return messages;
      const existing = messages[index];
      const updated = [...messages];
      updated[index] = {
        ...existing,
        modelUsed: existing.modelUsed ?? meta.modelUsed,
        tokensUsed: existing.tokensUsed ?? meta.tokensUsed,
        durationMs: existing.durationMs ?? meta.durationMs,
        serviceTierUsed: existing.serviceTierUsed ?? meta.serviceTierUsed,
        serviceTierFallback: existing.serviceTierFallback ?? meta.serviceTierFallback,
        precomputed: existing.precomputed ?? meta.precomputed,
      };
      return updated;
    }
    const updated = [...messages];
    updated[index] = {
      ...updated[index],
      text,
      intent,
      actionId,
      actionStatus: status,
      isStreaming: false,
      pendingAction: false,
      ...(meta || {}),
    };
    return updated;
  }

  return [
    ...messages,
    {
      id: actionId,
      role: 'system',
      text,
      intent,
      actionId,
      actionStatus: status,
      isStreaming: false,
      pendingAction: false,
      ...(meta || {}),
    } as T,
  ];
}

export const finalizePendingActionMessage = finalizeStreamingMessage;
export const settleActionMessage = finalizeStreamingMessage;

export function cancelActionMessage<T extends LiveActionMessageBase>(
  messages: T[],
  actionId: string,
  intent: string,
  text = 'Cancelled.',
): T[] {
  return finalizeStreamingMessage(messages, actionId, intent, text, undefined, 'cancelled');
}
