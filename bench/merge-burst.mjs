#!/usr/bin/env node
/**
 * Transaction.merge benchmark: same number of logical transfers, different
 * merge group sizes. Measures whether merging improves fee cost (one dust
 * proof per GROUP), block packing (one extrinsic per group), and total time.
 *
 *   node bench/merge-burst.mjs [--api http://127.0.0.1:3300] [--node http://127.0.0.1:29944] \
 *                              [--total 90] [--groups 1,5,15,45]
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
const TOTAL = Number(arg('total', 90));
const GROUPS = arg('groups', '1,5,15,45').split(',').map(Number);
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

const blocksIn = async (from, to) => {
  const rows = [];
  for (let h = from; h <= to; h++) {
    const hash = await rpc('chain_getBlockHash', [h]);
    const block = await rpc('chain_getBlock', [hash]);
    rows.push({ height: h, extrinsics: Math.max(0, block.block.extrinsics.length - BASELINE) });
  }
  return rows.filter((b) => b.extrinsics > 0);
};

const main = async () => {
  for (;;) {
    const health = await fetch(`${API}/health`).then((r) => r.json()).catch(() => ({}));
    if (health.ready) break;
    process.stdout.write('.');
    await sleep(5000);
  }
  console.log(`API ready. total=${TOTAL} transfers per config; group sizes: ${GROUPS.join(', ')}`);

  const results = [];
  for (const group of GROUPS) {
    console.log(`\n=== merge-burst: ${TOTAL} transfers as ${Math.ceil(TOTAL / group)} merged txs (group=${group}) ===`);
    const r = await fetch(`${API}/merge-burst?total=${TOTAL}&group=${group}`, { method: 'POST' }).then((x) => x.json());
    if (r.error) {
      console.log(`  failed: ${r.error}`);
      results.push({ group, error: r.error });
      continue;
    }
    const blocks = await blocksIn(r.heightBeforeSubmit, r.heightAfterConfirm + 1);
    const maxTxsPerBlock = Math.max(0, ...blocks.map((b) => b.extrinsics));
    console.log(
      `  merged=${r.mergedTxs} finalized=${r.finalizedMergedTxs} transfers=${r.transfersLanded}\n` +
        `  create=${(r.createMs / 1000).toFixed(1)}s merge=${(r.mergeMs / 1000).toFixed(1)}s ` +
        `balance+prove=${(r.balanceProveMs / 1000).toFixed(1)}s confirm=${(r.confirmMs / 1000).toFixed(1)}s\n` +
        `  blocks: ${blocks.map((b) => `#${b.height}:${b.extrinsics}`).join(' ')}\n` +
        `  → transfers/block (max): ${maxTxsPerBlock * group}`,
    );
    if (r.submitErrors?.length) console.log(`  submit errors: ${r.submitErrors.join(' | ')}`);
    results.push({
      group,
      ...r,
      blocksUsed: blocks.length,
      distribution: blocks.map((b) => b.extrinsics).join('+'),
      maxTransfersPerBlock: maxTxsPerBlock * group,
    });
    await sleep(15_000); // let external wallet change + dust coins recycle
  }

  const lines = [
    `| group size | merged txs | finalized | transfers landed | balance+prove (s) | blocks | extrinsics/block | max transfers in one block |`,
    '|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...results
      .filter((r) => !r.error)
      .map(
        (r) =>
          `| ${r.group} | ${r.mergedTxs} | ${r.finalizedMergedTxs} | ${r.transfersLanded} | ` +
          `${(r.balanceProveMs / 1000).toFixed(1)} | ${r.blocksUsed} | ${r.distribution} | ${r.maxTransfersPerBlock} |`,
      ),
  ];
  const md = `\n## Transaction.merge test (${TOTAL} transfers per config)\n\nRun: ${new Date().toISOString()}\n\n${lines.join('\n')}\n`;
  console.log(md);
  writeFileSync(new URL('../merge-results.md', import.meta.url).pathname, md);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
