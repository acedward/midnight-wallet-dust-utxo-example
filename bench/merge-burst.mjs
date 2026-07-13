#!/usr/bin/env node
/**
 * Transaction.merge benchmark for TRANSFERS: the same number of logical
 * transfers, merged into groups of different sizes before submission.
 * `--groups 1` is the no-merge baseline — directly comparable.
 *
 * Each merged tx is balanced ONCE by the benchmark wallet (one dust coin +
 * one dust proof per GROUP instead of per transfer).
 *
 *   node bench/merge-burst.mjs [--api URL] [--node URL] [--total 90] [--groups 1,5,8]
 */
import { API, arg, canonicalRow, CANONICAL_HEADER, chainSpanS, scanBlocks, sleep, waitForApiReady, writeResults } from './lib.mjs';

const TOTAL = Number(arg('total', 90));
const GROUPS = arg('groups', '1,5,8').split(',').map(Number);

const main = async () => {
  await waitForApiReady();
  console.log(`total=${TOTAL} transfers per config; group sizes: ${GROUPS.join(', ')}`);
  const rows = [];
  for (const group of GROUPS) {
    console.log(`\n=== merge-burst: ${TOTAL} transfers as ${Math.ceil(TOTAL / group)} merged txs (group=${group}) ===`);
    const r = await fetch(`${API}/merge-burst?total=${TOTAL}&group=${group}`, { method: 'POST' }).then((x) => x.json());
    if (r.error) {
      console.log(`  failed: ${r.error}`);
      rows.push({
        experiment: 'merged transfers',
        config: `${TOTAL} transfers, group=${group} — FAILED: ${r.error}`,
        requested: TOTAL,
        landed: 0,
        wallS: 0,
      });
      continue;
    }
    const blocks = await scanBlocks(r.heightBeforeSubmit, r.heightAfterConfirm + 1);
    console.log(
      `  merged=${r.mergedTxs} finalized=${r.finalizedMergedTxs} ` +
        `blocks: ${blocks.map((b) => `#${b.height}:${b.userTxs}`).join(' ')}`,
    );
    if (r.submitErrors?.length) console.log(`  submit errors: ${r.submitErrors.join(' | ')}`);
    const row = {
      experiment: 'merged transfers',
      config: group === 1 ? `${TOTAL} transfers, no merge (baseline)` : `${TOTAL} transfers, merged ×${group}`,
      requested: TOTAL,
      landed: r.transfersLanded,
      wallS: r.submitToFinalizedMs / 1000,
      blocks: blocks.length,
      // ops = logical transfers: extrinsics per block × group size
      maxOpsPerBlock: Math.max(0, ...blocks.map((b) => b.userTxs)) * group,
      chainS: chainSpanS(blocks),
    };
    console.log(canonicalRow(row));
    rows.push(row);
    await sleep(30_000); // let external change + dust coins recycle
  }
  console.log(['', ...CANONICAL_HEADER, ...rows.map(canonicalRow)].join('\n'));
  writeResults('merge', 'Merged transfers vs unmerged baseline (Transaction.merge)', rows);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
