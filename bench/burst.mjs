#!/usr/bin/env node
/**
 * Burst benchmark: for each size N, ask the API to pre-prove N transactions
 * and submit them all in the same instant, then count how many landed in each
 * block — measuring the node's per-block packing capacity directly.
 *
 *   node bench/burst.mjs [--api http://127.0.0.1:3300] [--node http://127.0.0.1:29944] [--sizes 20,30,40,60,100]
 */
import { writeFileSync } from 'node:fs';
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const API = arg('api', 'http://127.0.0.1:3300');
const NODE = arg('node', 'http://127.0.0.1:29944');
const SIZES = arg('sizes', '20,30,40,60,100').split(',').map(Number);
/** Extrinsics every block carries with no user txs (inherents). */
const BASELINE = Number(arg('baseline', 3));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rpc = async (method, params = []) => {
  const res = await fetch(NODE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  });
  return (await res.json()).result;
};

const userTxsPerBlock = async (from, to) => {
  const rows = [];
  for (let h = from; h <= to; h++) {
    const hash = await rpc('chain_getBlockHash', [h]);
    const block = await rpc('chain_getBlock', [hash]);
    rows.push({ height: h, userTxs: Math.max(0, block.block.extrinsics.length - BASELINE) });
  }
  return rows;
};

const main = async () => {
  for (;;) {
    const health = await fetch(`${API}/health`).then((r) => r.json()).catch(() => ({}));
    if (health.ready) break;
    process.stdout.write('.');
    await sleep(5000);
  }
  console.log('API ready.');

  const results = [];
  for (const n of SIZES) {
    console.log(`\n=== burst: prepare ${n} proven txs, submit at once ===`);
    const r = await fetch(`${API}/burst?n=${n}`, { method: 'POST' }).then((x) => x.json());
    if (r.error) {
      console.log(`  burst failed: ${r.error}`);
      results.push({ n, error: r.error });
      continue;
    }
    // +1 block margin: a tx submitted right at a block boundary can land one later
    const blocks = await userTxsPerBlock(r.heightBeforeSubmit, r.heightAfterConfirm + 1);
    const packed = blocks.filter((b) => b.userTxs > 0);
    const maxPerBlock = Math.max(0, ...blocks.map((b) => b.userTxs));
    console.log(
      `  prepared=${r.prepared}/${r.requested} acks=${r.submitAcks} finalized=${r.finalized}\n` +
        `  prepare=${(r.prepareMs / 1000).toFixed(1)}s submit=${(r.submitMs / 1000).toFixed(1)}s confirm=${(r.confirmMs / 1000).toFixed(1)}s\n` +
        `  blocks ${r.heightBeforeSubmit}..${r.heightAfterConfirm}: ` +
        packed.map((b) => `#${b.height}:${b.userTxs}`).join(' ') +
        `\n  max per block: ${maxPerBlock}`,
    );
    if (r.prepareErrors?.length) console.log(`  prepare errors: ${r.prepareErrors.join(' | ')}`);
    if (r.submitErrors?.length) console.log(`  submit errors: ${r.submitErrors.join(' | ')}`);
    results.push({ n, ...r, maxPerBlock, distribution: packed.map((b) => b.userTxs).join('+') });
    await sleep(10_000); // let the pool fully drain between bursts
  }

  const lines = [
    '| burst size | prepared | finalized | submit→confirm (s) | blocks used | distribution | max in one block |',
    '|---:|---:|---:|---:|---:|---:|---:|',
    ...results
      .filter((r) => !r.error)
      .map(
        (r) =>
          `| ${r.n} | ${r.prepared} | ${r.finalized} | ${(r.confirmMs / 1000).toFixed(1)} | ` +
          `${r.distribution.split('+').length} | ${r.distribution} | ${r.maxPerBlock} |`,
      ),
  ];
  const md = `\n## Burst test (pre-proven txs submitted simultaneously)\n\nRun: ${new Date().toISOString()}\n\n${lines.join('\n')}\n`;
  console.log(md);
  writeFileSync(new URL('../burst-results.md', import.meta.url).pathname, md);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
