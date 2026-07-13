#!/usr/bin/env node
/**
 * Concurrent-waves benchmark (NO merging). Fires waves of concurrent POST /tx
 * requests, each request = one full transaction pipeline, and reports the
 * canonical results table.
 *
 * Two test cases (modes):
 *   self     — the benchmark wallet creates the ENTIRE transaction
 *              (contract call: build + prove + balance fees + submit)
 *   external — an external wallet creates and PROVES a transfer with
 *              { payFees: false }; the benchmark wallet only balances the
 *              missing dust and submits
 *
 *   node bench/bench.mjs [--api URL] [--node URL] [--waves 1,5,20,50,100] [--modes self,external]
 */
import {
  API,
  arg,
  canonicalRow,
  CANONICAL_HEADER,
  chainSpanS,
  currentHeight,
  scanBlocks,
  sleep,
  waitForApiReady,
  writeResults,
} from './lib.mjs';

const WAVES = arg('waves', '1,5,20,50,100').split(',').map(Number);
const MODES = arg('modes', 'self,external').split(',');
const REQUEST_TIMEOUT_MS = Number(arg('timeout', 45 * 60_000));

const one = async (mode) => {
  const started = Date.now();
  try {
    const res = await fetch(`${API}/tx?mode=${mode}`, {
      method: 'POST',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await res.json();
    return { ok: body.ok === true, latencyMs: Date.now() - started, error: body.error };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: String(err) };
  }
};

const runWave = async (mode, n) => {
  console.log(`\n=== [${mode}] wave: ${n} concurrent request${n === 1 ? '' : 's'} ===`);
  const h0 = await currentHeight();
  const started = Date.now();
  const results = await Promise.all(Array.from({ length: n }, () => one(mode)));
  const wallMs = Date.now() - started;
  const h1 = await currentHeight();

  const ok = results.filter((r) => r.ok).length;
  for (const r of results.filter((r) => !r.ok).slice(0, 3)) console.log(`  sample failure: ${r.error}`);
  const blocks = await scanBlocks(h0, h1 + 1);
  const row = {
    experiment: `waves (${mode})`,
    config: `${n} concurrent, no merge`,
    requested: n,
    landed: ok,
    wallS: wallMs / 1000,
    blocks: blocks.length,
    maxOpsPerBlock: Math.max(0, ...blocks.map((b) => b.userTxs)),
      chainS: chainSpanS(blocks),
  };
  console.log(canonicalRow(row));
  return row;
};

const main = async () => {
  await waitForApiReady();
  const rows = [];
  for (const mode of MODES) {
    for (const n of WAVES) {
      rows.push(await runWave(mode, n));
      await sleep(5_000);
    }
  }
  console.log(['', ...CANONICAL_HEADER, ...rows.map(canonicalRow)].join('\n'));
  writeResults('bench', 'Concurrent waves (no merging)', rows);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
