#!/usr/bin/env node
/**
 * External benchmark driver. Fires waves of concurrent POST /tx requests at
 * the fast-tx API (1, 5, 20, 50, 100 by default), measures wall time and
 * per-request latency, and prints a markdown results table.
 *
 *   node bench/bench.mjs [--api http://127.0.0.1:3300] [--waves 1,5,20,50,100]
 */
import { writeFileSync } from 'node:fs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const API = arg('api', process.env.API_URL ?? 'http://127.0.0.1:3300');
const WAVES = arg('waves', '1,5,20,50,100').split(',').map(Number);
const REQUEST_TIMEOUT_MS = Number(arg('timeout', 15 * 60_000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitForReady = async () => {
  process.stdout.write(`waiting for API at ${API} to be ready `);
  for (;;) {
    try {
      const res = await fetch(`${API}/health`);
      const body = await res.json();
      if (body.ready) break;
      if (body.error) throw new Error(`API startup failed: ${body.error}`);
    } catch (err) {
      if (String(err).includes('startup failed')) throw err;
    }
    process.stdout.write('.');
    await sleep(3000);
  }
  console.log(' ready.');
};

const one = async () => {
  const started = Date.now();
  try {
    const res = await fetch(`${API}/tx`, { method: 'POST', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = await res.json();
    return { ok: body.ok === true, latencyMs: Date.now() - started, error: body.error };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: String(err) };
  }
};

const stats = async () => {
  try {
    return await (await fetch(`${API}/stats`)).json();
  } catch {
    return null;
  }
};

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

const runWave = async (n) => {
  console.log(`\n=== wave: ${n} concurrent request${n === 1 ? '' : 's'} ===`);
  const before = await stats();
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: n }, one));
  const wallMs = Date.now() - started;

  const ok = results.filter((r) => r.ok).length;
  const failed = n - ok;
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / n;
  const after = await stats();

  for (const r of results.filter((r) => !r.ok).slice(0, 3)) console.log(`  sample failure: ${r.error}`);
  const row = {
    n,
    ok,
    failed,
    wallS: wallMs / 1000,
    avgS: avg / 1000,
    p50S: percentile(latencies, 50) / 1000,
    maxS: latencies[latencies.length - 1] / 1000,
    tps: ok / (wallMs / 1000),
    counterBefore: before?.counter ?? '?',
    counterAfter: after?.counter ?? '?',
    dustAfter: after?.wallet?.dust ?? '?',
  };
  console.log(
    `  ok=${ok}/${n} wall=${row.wallS.toFixed(1)}s avg=${row.avgS.toFixed(1)}s ` +
      `p50=${row.p50S.toFixed(1)}s max=${row.maxS.toFixed(1)}s → ${row.tps.toFixed(2)} tx/s ` +
      `(counter ${row.counterBefore} → ${row.counterAfter})`,
  );
  return row;
};

const table = (rows) => {
  const lines = [
    '| requests | ok | failed | wall time (s) | avg latency (s) | p50 (s) | max (s) | throughput (tx/s) | counter after |',
    '|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...rows.map(
      (r) =>
        `| ${r.n} | ${r.ok} | ${r.failed} | ${r.wallS.toFixed(1)} | ${r.avgS.toFixed(1)} | ${r.p50S.toFixed(1)} | ` +
        `${r.maxS.toFixed(1)} | ${r.tps.toFixed(2)} | ${r.counterAfter} |`,
    ),
  ];
  return lines.join('\n');
};

const main = async () => {
  await waitForReady();
  const initial = await stats();
  console.log(
    `wallet: ${initial?.wallet?.address}\n` +
      `utxos=${initial?.wallet?.utxos} night=${initial?.wallet?.night} dust=${initial?.wallet?.dust}\n` +
      `contract: ${initial?.contractAddress} (counter=${initial?.counter})`,
  );

  const rows = [];
  for (const n of WAVES) {
    rows.push(await runWave(n));
  }

  const md = `# fast-tx benchmark results

Run: ${new Date().toISOString()}  ·  API: ${API}  ·  waves: ${WAVES.join(', ')}

Each request = one \`incrementBy(1)\` call on the public-counter contract:
build → prove (proof server) → balance fees (dust) → submit → finalized on-chain.

${table(rows)}
`;
  console.log(`\n${md}`);
  const out = new URL('../results.md', import.meta.url).pathname;
  writeFileSync(out, md);
  console.log(`written to ${out}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
