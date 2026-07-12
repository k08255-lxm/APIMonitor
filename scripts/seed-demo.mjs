const target = new URL('/api/events', process.env.DEMO_TARGET || 'http://127.0.0.1:8787');
const token = process.env.INGEST_TOKEN || '';
const now = Date.now();

const models = [
  { name: 'gpt-5.5', input: 1.25, output: 10 },
  { name: 'claude-sonnet-4.5', input: 3, output: 15 },
  { name: 'deepseek-v4', input: 0.28, output: 0.42 },
  { name: 'gemini-2.5-pro', input: 1.25, output: 10 },
];

const events = Array.from({ length: 36 }, (_, index) => {
  const model = models[index % models.length];
  const inputTokens = 900 + ((index * 791) % 12_000);
  const outputTokens = 180 + ((index * 337) % 3_500);
  const failed = index === 8 || index === 23;
  return {
    id: `demo-${now}-${index}`,
    timestamp: new Date(now - (35 - index) * 12 * 60_000).toISOString(),
    service: index % 3 === 0 ? 'demo-sub2api' : 'demo-gateway',
    model: model.name,
    inputTokens,
    outputTokens,
    cost: (inputTokens * model.input + outputTokens * model.output) / 1_000_000,
    latencyMs: 620 + ((index * 283) % 5_600),
    status: failed ? 502 : 200,
    stream: index % 4 !== 0,
    keyId: `demo-key-${(index % 5) + 1}`,
    outcome: failed ? 'upstream_error' : 'completed',
  };
});

const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
if (token) headers.Authorization = `Bearer ${token}`;

try {
  const response = await fetch(target, {
    method: 'POST',
    headers,
    body: JSON.stringify(events),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  console.log(`[demo] accepted ${body.accepted ?? events.length} events by ${target.origin}`);
} catch (error) {
  console.error(`[demo] unable to seed ${target.origin}: ${error.message}`);
  process.exitCode = 1;
}
