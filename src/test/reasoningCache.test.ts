import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ReasoningStateCache } from '../provider/reasoningCache';
import type { XAIInputItem, XAIResponse } from '../xai/types';

function response(id: string, callIds: readonly string[]): XAIResponse {
  return {
    id,
    object: 'response',
    status: 'completed',
    output: [
      {
        id: `reasoning-${id}`,
        type: 'reasoning',
        status: 'completed',
        encrypted_content: `encrypted-${id}`,
        summary: []
      },
      { type: 'message', role: 'assistant', content: [] },
      ...callIds.map(callId => ({
        type: 'function_call' as const,
        call_id: callId,
        name: 'read_file',
        arguments: '{}'
      }))
    ]
  };
}

describe('ReasoningStateCache', () => {
  it('restores one reasoning item before an assistant tool-call batch', () => {
    const cache = new ReasoningStateCache();
    cache.record('conversation-a', response('resp-1', ['call-1', 'call-2']));
    const input: XAIInputItem[] = [
      { role: 'user', content: 'inspect the project' },
      { role: 'assistant', content: 'I will inspect two files.' },
      { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' },
      { type: 'function_call', call_id: 'call-2', name: 'read_file', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call-1', output: 'one' },
      { type: 'function_call_output', call_id: 'call-2', output: 'two' }
    ];

    const augmented = cache.augment('conversation-a', input);
    assert.equal(augmented[1]?.type, 'reasoning');
    assert.equal(augmented.filter(item => item.type === 'reasoning').length, 1);
    assert.deepEqual(augmented[2], input[1]);
    assert.deepEqual(augmented[1], {
      id: 'reasoning-resp-1',
      type: 'reasoning',
      encrypted_content: 'encrypted-resp-1'
    });
  });

  it('does not add state for unrelated calls or responses without reasoning', () => {
    const cache = new ReasoningStateCache();
    cache.record('conversation-a', response('resp-1', ['call-1']));
    cache.record('conversation-a', {
      id: 'resp-2',
      object: 'response',
      status: 'completed',
      output: [{ type: 'function_call', call_id: 'call-2', name: 'tool', arguments: '{}' }]
    });
    const input: XAIInputItem[] = [
      { type: 'function_call', call_id: 'call-2', name: 'tool', arguments: '{}' }
    ];
    assert.deepEqual(cache.augment('conversation-a', input), input);
  });

  it('evicts the oldest bundle and clears all aliases for it', () => {
    const cache = new ReasoningStateCache(1);
    cache.record('conversation-a', response('resp-1', ['old-a', 'old-b']));
    cache.record('conversation-a', response('resp-2', ['new-a']));

    const oldInput: XAIInputItem[] = [
      { type: 'function_call', call_id: 'old-b', name: 'read_file', arguments: '{}' }
    ];
    const newInput: XAIInputItem[] = [
      { type: 'function_call', call_id: 'new-a', name: 'read_file', arguments: '{}' }
    ];
    assert.equal(cache.augment('conversation-a', oldInput).some(item => item.type === 'reasoning'), false);
    assert.equal(cache.augment('conversation-a', newInput).some(item => item.type === 'reasoning'), true);
  });

  it('never restores reasoning across conversation namespaces', () => {
    const cache = new ReasoningStateCache();
    cache.record('conversation-a', response('resp-1', ['call-1']));
    const input: XAIInputItem[] = [
      { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' }
    ];

    assert.equal(
      cache.augment('conversation-b', input).some(item => item.type === 'reasoning'),
      false
    );
  });

  it('requires the historical call name and arguments to match', () => {
    const cache = new ReasoningStateCache();
    cache.record('conversation-a', response('resp-1', ['call-1']));

    for (const input of [
      [{ type: 'function_call', call_id: 'call-1', name: 'write_file', arguments: '{}' }],
      [{ type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"other"}' }]
    ] satisfies XAIInputItem[][]) {
      assert.equal(
        cache.augment('conversation-a', input).some(item => item.type === 'reasoning'),
        false
      );
    }
  });

  it('expires cached reasoning and ignores non-completed responses', () => {
    let now = 1_000;
    const cache = new ReasoningStateCache(8, 100, () => now);
    cache.record('conversation-a', response('resp-1', ['call-1']));
    const input: XAIInputItem[] = [
      { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' }
    ];
    assert.equal(cache.augment('conversation-a', input)[0]?.type, 'reasoning');

    now += 101;
    assert.deepEqual(cache.augment('conversation-a', input), input);

    const incomplete = response('resp-2', ['call-2']);
    incomplete.status = 'incomplete';
    cache.record('conversation-a', incomplete);
    assert.deepEqual(
      cache.augment('conversation-a', [
        { type: 'function_call', call_id: 'call-2', name: 'read_file', arguments: '{}' }
      ]),
      [{ type: 'function_call', call_id: 'call-2', name: 'read_file', arguments: '{}' }]
    );
  });
});
