import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';

/**
 * Append-only JSONL storage. Writes are serialized within this process, and
 * readers wait for queued writes so a dashboard snapshot never sees a partial
 * line produced by this server.
 */
export class EventStore {
  #filePath;
  #writeTail = Promise.resolve();
  #listeners = new Set();

  constructor(filePath) {
    this.#filePath = filePath;
  }

  async init() {
    await mkdir(dirname(this.#filePath), { recursive: true });
    const handle = await open(this.#filePath, 'a');
    await handle.close();
  }

  append(events) {
    const batch = Array.isArray(events) ? events : [events];
    if (batch.length === 0) return Promise.resolve();

    const payload = `${batch.map((event) => JSON.stringify(event)).join('\n')}\n`;
    const write = this.#writeTail.then(() => appendFile(this.#filePath, payload, 'utf8'));

    // Keep the queue usable after a failed write while still rejecting this call.
    this.#writeTail = write.catch(() => undefined);
    return write.then(() => {
      for (const listener of this.#listeners) {
        try {
          listener(batch);
        } catch {
          // Storage must not fail because an observer disconnected mid-write.
        }
      }
    });
  }

  async flush() {
    await this.#writeTail;
  }

  onAppend(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async *readEvents() {
    await this.flush();

    const input = createReadStream(this.#filePath, { encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Infinity });

    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        try {
          const value = JSON.parse(line);
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            yield value;
          }
        } catch {
          // A damaged or externally interrupted JSONL line is isolated and skipped.
        }
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }
}
