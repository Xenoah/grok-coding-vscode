import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildConversationInput,
  continuationFromResponse,
  readContinuation
} from '../chat/conversationState';
import type { XAIResponse } from '../xai/types';

function completedResponse(): XAIResponse {
  return {
    id: 'resp-1',
    object: 'response',
    status: 'completed',
    output: [
      {
        id: 'reasoning-1',
        type: 'reasoning',
        status: 'completed',
        encrypted_content: 'encrypted-local-state',
        summary: []
      },
      {
        id: 'message-1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: '最初の回答' }]
      }
    ]
  };
}

describe('dedicated chat conversation state', () => {
  it('returns encrypted response output on the next stateless turn', () => {
    const continuation = continuationFromResponse(completedResponse());
    const input = buildConversationInput(continuation, [], '続けて説明して');

    assert.deepEqual(
      input.map(item => item.type),
      ['reasoning', 'message', 'message']
    );
    assert.equal(input[0]?.encrypted_content, 'encrypted-local-state');
    assert.equal(input[2]?.role, 'user');
    assert.equal(input[2]?.content, '続けて説明して');
  });

  it('migrates chats created before encrypted continuation was saved', () => {
    const input = buildConversationInput(
      [],
      [
        { role: 'user', content: '最初の質問', status: 'complete' },
        { role: 'assistant', content: '最初の回答', status: 'complete' }
      ],
      '二つ目の質問'
    );

    assert.equal(input.length, 1);
    assert.equal(input[0]?.role, 'user');
    assert.match(String(input[0]?.content), /最初の質問/);
    assert.match(String(input[0]?.content), /最初の回答/);
    assert.match(String(input[0]?.content), /二つ目の質問/);
  });

  it('validates persisted continuation and ignores failed responses', () => {
    const persisted = readContinuation([
      { type: 'reasoning', encrypted_content: 'opaque' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'answer' }]
      },
      { type: 'function_call', name: 'untrusted' }
    ]);
    assert.deepEqual(
      persisted.map(item => item.type),
      ['reasoning', 'message']
    );

    const failed = completedResponse();
    failed.status = 'failed';
    assert.deepEqual(continuationFromResponse(failed), []);
  });
});
