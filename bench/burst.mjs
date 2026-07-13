#!/usr/bin/env node
/**
 * Pre-proven burst benchmark (NO merging). The API prepares N fully-proven,
 * fee-balanced transactions, then submits them ALL in the same instant —
 * isolating the node's block-packing capacity from proving latency.
 *
 *   node bench/burst.mjs [--api URL] [--node URL] [--sizes 20,30,40,60,100]
 */
import { API, arg, canonicalRow, CANONICAL_HEADER, chainSpanS, scanBlocks, sleep, waitForApiReady, writeResults } from './lib.mjs';

const SIZES = arg('sizes', '20,30,40,60,100').split(',').map(Number);

const main = async () => {
  await waitForApiReady();
  const rows = [];
  for (const n of SIZES) {
    console.log(`\n=== burst: prepare ${n} proven txs, submit at once ===`);
    const r = await fetch(`${API}/burst?n=${n}`, { method: 'POST' }).then((x) => x.json());
    if (r.error) {
      console.log(`  burst failed: ${r.error}`);
      continue;
    }
    const blocks = await scanBlocks(r.heightBeforeSubmit, r.heightAfterConfirm + 1);
    console.log(
      `  prepared=${r.prepared}/${r.requested} finalized=${r.finalized} ` +
        `prepare=${(r.prepareMs / 1000).toFixed(1)}s  blocks: ${blocks.map((b) => `#${b.height}:${b.userTxs}`).join(' ')}`,
    );
    if (r.submitErrors?.length) console.log(`  submit errors: ${r.submitErrors.join(' | ')}`);
    const row = {
      experiment: 'burst (pre-proven)',
      config: `${n} txs submitted at once, no merge`,
      requested: n,
      landed: r.finalized,
      wallS: r.submitToFinalizedMs / 1000,
      blocks: blocks.length,
      maxOpsPerBlock: Math.max(0, ...blocks.map((b) => b.userTxs)),
      chainS: chainSpanS(blocks),
    };
    console.log(canonicalRow(row));
    rows.push(row);
    await sleep(30_000); // drain: let dust coins recycle after big bursts
  }
  console.log(['', ...CANONICAL_HEADER, ...rows.map(canonicalRow)].join('\n'));
  writeResults('burst', 'Pre-proven burst (no merging)', rows);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
