import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { inspectRequestJson, ProxyCapture } from '../lib/proxy-capture.mjs';

const encoder = new TextEncoder();

function feedOneByteAtATime(capture, text) {
  const bytes = encoder.encode(text);
  for (let index = 0; index < bytes.length; index += 1) {
    capture.inspect(bytes.subarray(index, index + 1));
  }
  capture.finish();
}

describe('ProxyCapture', () => {
  it('parses SSE across arbitrary byte boundaries, CRLF, multi-line data, comments, and DONE', () => {
    const capture = new ProxyCapture('text/event-stream; charset=utf-8');
    const stream = [
      ': keepalive\r\n',
      'event: response.completed\r\n',
      'data: {"type":"response.completed","response":\r\n',
      'data: {"model":"gpt-5.5","usage":{"input_tokens":91,"output_tokens":9,"total_tokens":100}}}\r\n',
      '\r\n',
      'data: [DONE]\r\n',
      '\r\n',
    ].join('');

    feedOneByteAtATime(capture, stream);

    assert.equal(capture.model, 'gpt-5.5');
    assert.equal(capture.usageKnown, true);
    assert.deepEqual(capture.usage, {
      inputTokens: 91,
      outputTokens: 9,
      totalTokens: 100,
    });
  });

  it('uses the final SSE usage event without summing cumulative chunks', () => {
    const capture = new ProxyCapture('text/event-stream');
    const stream = [
      'data: {"model":"gpt-test","usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n',
      'data: {"model":"gpt-test","usage":{"prompt_tokens":10,"completion_tokens":8,"total_tokens":18}}\n\n',
      'data: [DONE]\n\n',
    ].join('');

    capture.inspect(encoder.encode(stream));
    capture.finish();

    assert.deepEqual(capture.usage, {
      inputTokens: 10,
      outputTokens: 8,
      totalTokens: 18,
    });
  });

  it('parses a split non-streaming Responses API body', () => {
    const capture = new ProxyCapture('application/json');
    const body = encoder.encode(JSON.stringify({
      id: 'resp_1',
      model: 'gpt-5.5',
      usage: {
        input_tokens: 45,
        output_tokens: 5,
        total_tokens: 50,
        cost_usd: 0.0123,
      },
    }));

    capture.inspect(body.subarray(0, 7));
    capture.inspect(body.subarray(7, 23));
    capture.inspect(body.subarray(23));
    capture.finish();

    assert.equal(capture.model, 'gpt-5.5');
    assert.equal(capture.usageKnown, true);
    assert.deepEqual(capture.usage, {
      inputTokens: 45,
      outputTokens: 5,
      totalTokens: 50,
    });
    assert.equal(capture.cost, 0.0123);
  });

  it('keeps usage unknown when a stream ends without a usage object', () => {
    const capture = new ProxyCapture('text/event-stream');
    feedOneByteAtATime(
      capture,
      'data: {"id":"chunk","choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n',
    );

    assert.equal(capture.usageKnown, false);
    assert.deepEqual(capture.usage, {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it('extracts only safe request metadata from JSON request bodies', () => {
    const secret = 'private prompt';
    const metadata = inspectRequestJson(
      Buffer.from(JSON.stringify({ model: 'gpt-5.5', stream: true, input: secret })),
      'application/json; charset=utf-8',
    );

    assert.deepEqual(metadata, { model: 'gpt-5.5', stream: true });
    assert.equal(JSON.stringify(metadata).includes(secret), false);
  });
});
