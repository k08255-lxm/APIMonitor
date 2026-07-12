function finiteToken(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : 0;
}

export class ProxyCapture {
  #decoder = new TextDecoder();
  #eventStream;
  #lineBuffer = '';
  #eventData = [];
  #jsonParts = [];
  #jsonBytes = 0;
  #jsonLimit;

  constructor(contentType = '', jsonLimit = 2 * 1024 * 1024) {
    this.#eventStream = contentType.toLowerCase().includes('text/event-stream');
    this.#jsonLimit = jsonLimit;
    this.model = '';
    this.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    this.cost = undefined;
    this.usageKnown = false;
  }

  inspect(chunk) {
    if (this.#eventStream) {
      this.#lineBuffer += this.#decoder.decode(chunk, { stream: true });
      this.#drainSseLines(false);
      return;
    }

    if (this.#jsonBytes + chunk.byteLength <= this.#jsonLimit) {
      this.#jsonParts.push(Buffer.from(chunk));
      this.#jsonBytes += chunk.byteLength;
    } else {
      this.#jsonParts = [];
      this.#jsonBytes = this.#jsonLimit + 1;
    }
  }

  finish() {
    if (this.#eventStream) {
      this.#lineBuffer += this.#decoder.decode();
      this.#drainSseLines(true);
      this.#dispatchSseEvent();
      return;
    }

    if (this.#jsonBytes <= this.#jsonLimit && this.#jsonParts.length) {
      try {
        this.#merge(JSON.parse(Buffer.concat(this.#jsonParts).toString('utf8')));
      } catch {
        // Non-JSON and oversized responses are still proxied, just not inspected.
      }
    }
  }

  #drainSseLines(final) {
    while (this.#lineBuffer) {
      const match = /[\r\n]/.exec(this.#lineBuffer);
      if (!match) break;
      const index = match.index;
      const character = this.#lineBuffer[index];

      // A trailing CR may be the first half of CRLF in the next TCP chunk.
      if (!final && character === '\r' && index === this.#lineBuffer.length - 1) break;

      const separatorLength = character === '\r' && this.#lineBuffer[index + 1] === '\n' ? 2 : 1;
      const line = this.#lineBuffer.slice(0, index);
      this.#lineBuffer = this.#lineBuffer.slice(index + separatorLength);
      this.#inspectSseLine(line);
    }

    if (final && this.#lineBuffer) {
      this.#inspectSseLine(this.#lineBuffer);
      this.#lineBuffer = '';
    }
  }

  #inspectSseLine(line) {
    if (line === '') {
      this.#dispatchSseEvent();
      return;
    }
    if (line.startsWith(':') || !line.startsWith('data:')) return;
    const value = line.slice(5);
    this.#eventData.push(value.startsWith(' ') ? value.slice(1) : value);
  }

  #dispatchSseEvent() {
    if (!this.#eventData.length) return;
    const data = this.#eventData.join('\n').trim();
    this.#eventData = [];
    if (!data || data === '[DONE]') return;
    try {
      this.#merge(JSON.parse(data));
    } catch {
      // Ignore provider-specific non-JSON SSE messages.
    }
  }

  #merge(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (typeof payload.model === 'string') this.model = payload.model.slice(0, 120);

    const response = payload.response && typeof payload.response === 'object' ? payload.response : null;
    if (response && typeof response.model === 'string') this.model = response.model.slice(0, 120);

    const usage = payload.usage ?? response?.usage;
    if (!usage || typeof usage !== 'object') return;
    this.usageKnown = true;

    const inputTokens = finiteToken(usage.input_tokens ?? usage.prompt_tokens ?? usage.inputTokens);
    const outputTokens = finiteToken(usage.output_tokens ?? usage.completion_tokens ?? usage.outputTokens);
    const totalTokens = finiteToken(usage.total_tokens ?? usage.totalTokens) || inputTokens + outputTokens;
    this.usage.inputTokens = Math.max(this.usage.inputTokens, inputTokens);
    this.usage.outputTokens = Math.max(this.usage.outputTokens, outputTokens);
    this.usage.totalTokens = Math.max(this.usage.totalTokens, totalTokens, inputTokens + outputTokens);

    const cost = usage.cost ?? usage.cost_usd ?? payload.cost;
    if (Number.isFinite(Number(cost)) && Number(cost) >= 0) this.cost = Number(cost);
  }
}

export function inspectRequestJson(buffer, contentType) {
  if (!buffer.length || !contentType.toLowerCase().includes('json')) return {};
  try {
    const body = JSON.parse(buffer.toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
    return {
      model: typeof body.model === 'string' ? body.model.slice(0, 120) : '',
      stream: Boolean(body.stream),
    };
  } catch {
    return {};
  }
}
