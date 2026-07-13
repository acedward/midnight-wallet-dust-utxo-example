#!/usr/bin/env node
/**
 * Sustained multi-block throughput. One-shot bursts pay a fixed pipeline
 * round trip (~4 blocks of wall for ~2 blocks of chain work); a continuous
 * stream over many blocks amortizes it away — wall here is first-submit →
 * last-finalized across the whole stream, converging on the chain-side rate.
 *
 *   node bench/sustained.mjs [--api URL] [--node URL] \
 *     [--singleTotal 270] [--concurrency 64] [--mergedTotal 1200] [--group 150]
 */
import { API, arg, canonicalRow, CANONICAL_HEADER, chainSpanS, scanBlocks, sleep, waitForApiReady, writeResults } from './lib.mjs';

const SINGLE_TOTAL = Number(arg('singleTotal', 270));
const CONCURRENCY = Number(arg('concurrency', 64));
const MERGED_TOTAL = Number(arg('mergedTotal', 1200));
const GROUP = Number(arg('group', 150));

const run = async (mode, params, configLabel) => {
  console.log(`\n=== sustained ${mode}: ${configLabel} ===`);
  const qs = new URLSearchParams({ mode, ...params }).toString();
  const r = await fetch(`${API}/sustained?${qs}`, { method: 'POST' }).then((x) => x.json());
  if (r.error) {
    console.log(`  failed: ${r.error}`);
    return null;
  }
  const blocks = await scanBlocks(r.heightBefore, r.heightAfter + 1);
  // ops per block = extrinsics × group (merged) or extrinsics (single)
  const opsPerBlock = blocks.map((b) => b.userTxs * (mode === 'merged' ? r.group : 1));
  console.log(
    `  ops ${r.opsLanded}/${r.total} over ${blocks.length} busy blocks ` +
      `(heights ${r.heightBefore}..${r.heightAfter})\n  ops/block: ${opsPerBlock.join(' ')}`,
  );
  const row = {
    experiment: `sustained (${mode})`,
    config: configLabel,
    requested: r.total,
    landed: r.opsLanded,
    wallS: r.firstSubmitToLastFinalMs / 1000,
    blocks: blocks.length,
    maxOpsPerBlock: Math.max(0, ...opsPerBlock),
      chainS: chainSpanS(blocks),
  };
  console.log(canonicalRow(row));
  return row;
};

const main = async () => {
  await waitForApiReady();
  const rows = [];
  const single = await run(
    'single',
    { total: SINGLE_TOTAL, concurrency: CONCURRENCY },
    `${SINGLE_TOTAL} txs pipelined, ${CONCURRENCY} lanes, no merge`,
  );
  if (single) rows.push(single);
  await sleep(30_000);
  const merged = await run(
    'merged',
    { total: MERGED_TOTAL, group: GROUP },
    `${MERGED_TOTAL} calls as merged ×${GROUP}, continuous`,
  );
  if (merged) rows.push(merged);
  console.log(['', ...CANONICAL_HEADER, ...rows.map(canonicalRow)].join('\n'));
  writeResults('sustained', 'Sustained multi-block stream (round trip amortized)', rows);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
