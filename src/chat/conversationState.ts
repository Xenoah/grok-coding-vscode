import type {
  XAIInputItem,
  XAIResponse
} from '../xai/types';

const MAX_CONTINUATION_BYTES = 8 * 1024 * 1024;
const MAX_MIGRATION_TRANSCRIPT_CHARACTERS = 200_000;

export interface TranscriptMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly status?: 'complete' | 'streaming' | 'error';
}

/**
 * Build a stateless follow-up request.
 *
 * xAI reasoning models require the previous response.output items (including
 * encrypted reasoning) to be sent back when store:false is used. Existing
 * chats created before that state was persisted are migrated through a plain
 * transcript on their next turn.
 */
export function buildConversationInput(
  continuation: readonly XAIInputItem[],
  previousMessages: readonly TranscriptMessage[],
  userText: string
): XAIInputItem[] {
  const userMessage: XAIInputItem = {
    type: 'message',
    role: 'user',
    content: userText
  };

  if (continuation.length > 0) {
    return [...continuation, userMessage];
  }

  const transcript = previousMessages
    .filter(message => message.status !== 'error' && message.content.trim().length > 0)
    .map(message => `${message.role === 'user' ? 'User' : 'Assistant'}:\n${message.content}`)
    .join('\n\n');
  if (!transcript) {
    return [userMessage];
  }

  const boundedTranscript = transcript.slice(-MAX_MIGRATION_TRANSCRIPT_CHARACTERS);
  return [
    {
      type: 'message',
      role: 'user',
      content:
        'Continue the conversation represented by this local transcript. ' +
        'Answer the latest user message in the same language.\n\n' +
        `${boundedTranscript}\n\nLatest user message:\n${userText}`
    }
  ];
}

/** Keep only the response items needed for the next stateless turn. */
export function continuationFromResponse(response: XAIResponse): XAIInputItem[] {
  if (response.status !== 'completed') {
    return [];
  }
  return sanitizeContinuation(response.output);
}

/** Validate locally persisted opaque state before sending it back to xAI. */
export function readContinuation(value: unknown): XAIInputItem[] {
  return Array.isArray(value) ? sanitizeContinuation(value) : [];
}

function sanitizeContinuation(items: readonly unknown[]): XAIInputItem[] {
  const result: XAIInputItem[] = [];
  for (const item of items) {
    const copied = copyContinuationItem(item);
    if (copied) {
      result.push(copied);
    }
  }

  if (!result.some(item => item.type === 'message')) {
    return [];
  }

  try {
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_CONTINUATION_BYTES) {
      return [];
    }
  } catch {
    return [];
  }
  return result;
}

function copyContinuationItem(value: unknown): XAIInputItem | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return undefined;
  }

  if (value.type === 'reasoning') {
    if (typeof value.encrypted_content !== 'string' || value.encrypted_content.length === 0) {
      return undefined;
    }
    const item: Record<string, unknown> = {
      type: 'reasoning',
      encrypted_content: value.encrypted_content
    };
    copyShortString(value, item, 'id', 512);
    copyShortString(value, item, 'status', 64);
    if (Array.isArray(value.summary)) {
      item.summary = value.summary;
    }
    return item as XAIInputItem;
  }

  if (value.type === 'message' && value.role === 'assistant' && Array.isArray(value.content)) {
    const content = value.content
      .filter(
        (part): part is Record<string, unknown> =>
          isRecord(part) && part.type === 'output_text' && typeof part.text === 'string'
      )
      .map(part => ({ type: 'output_text', text: part.text }));
    if (content.length === 0) {
      return undefined;
    }
    const item: Record<string, unknown> = {
      type: 'message',
      role: 'assistant',
      content
    };
    copyShortString(value, item, 'id', 512);
    copyShortString(value, item, 'status', 64);
    return item as XAIInputItem;
  }

  return undefined;
}

function copyShortString(
  source: Record<string, unknown>,
  target: Record<string, unknown>,
  key: string,
  maximumLength: number
): void {
  const value = source[key];
  if (typeof value === 'string' && value.length <= maximumLength) {
    target[key] = value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
