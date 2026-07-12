import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { keyFingerprint, normalizeEvent } from '../lib/events.mjs';

describe('normalizeEvent', () => {
  it('normalizes OpenAI Chat Completions usage fields', () => {
    const event = normalizeEvent({
      id: 'chat-1',
      timestamp: '2026-07-12T08:00:00.000Z',
      service: 'openai',
      model: 'gpt-5.5',
      usage: {
        prompt_tokens: 120,
        completion_tokens: 30,
        total_tokens: 150,
      },
      latencyMs: 250,
      status: 200,
    });

    assert.equal(event.inputTokens, 120);
    assert.equal(event.outputTokens, 30);
    assert.equal(event.tokens, 150);
    assert.equal(event.status, 200);
    assert.equal(event.healthy, true);
  });

  it('normalizes Responses API and camelCase usage fields', () => {
    const responses = normalizeEvent({
      usage: { input_tokens: 80, output_tokens: 20, total_tokens: 100 },
    });
    const camelCase = normalizeEvent({
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    });

    assert.deepEqual(
      [responses.inputTokens, responses.outputTokens, responses.tokens],
      [80, 20, 100],
    );
    assert.deepEqual(
      [camelCase.inputTokens, camelCase.outputTokens, camelCase.tokens],
      [7, 3, 10],
    );
  });

  it('never persists request secrets, prompts, or raw credentials', () => {
    const secret = 'sk-secret-that-must-not-be-stored';
    const prompt = 'private prompt text';
    const event = normalizeEvent({
      model: 'gpt-5.5\nlog-forgery',
      authorization: `Bearer ${secret}`,
      apiKey: secret,
      headers: { authorization: `Bearer ${secret}`, cookie: 'session=private' },
      prompt,
      messages: [{ role: 'user', content: prompt }],
      requestBody: { input: prompt },
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const serialized = JSON.stringify(event);

    assert.equal(Object.hasOwn(event, 'authorization'), false);
    assert.equal(Object.hasOwn(event, 'headers'), false);
    assert.equal(Object.hasOwn(event, 'messages'), false);
    assert.equal(Object.hasOwn(event, 'requestBody'), false);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes(prompt), false);
    assert.equal(event.model, 'gpt-5.5log-forgery');
  });

  it('fingerprints credentials deterministically without returning the credential', () => {
    const authorization = 'Bearer sk-private-value';
    const first = keyFingerprint(authorization);
    const second = keyFingerprint(authorization);

    assert.match(first, /^key-[a-f0-9]{10}$/);
    assert.equal(first, second);
    assert.equal(first.includes('sk-private-value'), false);
    assert.equal(keyFingerprint(''), '');
  });

  it('calculates configured model cost without accepting negative usage', () => {
    const event = normalizeEvent({
      model: 'gpt-test',
      usage: { input_tokens: 2_000_000, output_tokens: 500_000 },
    }, {
      pricing: {
        'gpt-*': { inputPerMillion: 1.5, outputPerMillion: 4 },
      },
    });

    assert.equal(event.cost, 5);
    assert.equal(normalizeEvent({ usage: { input_tokens: -10 } }).inputTokens, 0);
  });
});
