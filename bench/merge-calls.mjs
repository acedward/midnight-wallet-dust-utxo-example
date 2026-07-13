#!/usr/bin/env node
/**
 * Transaction.merge benchmark for CONTRACT CALLS: N `incrementBy(1)` calls
 * merged into ONE transaction. The counter delta is read from the contract
 * on-chain after each run, so every "landed" figure is chain-verified.
 * (The ledger-v8 TS docs claim contract-interaction txs can't merge; the Rust
 * implementation has no such check — this proves they can.)
 *
 *   node bench/merge-calls.mjs [--api URL] [--node URL] [--sizes 2,20,45,90,150,200]
 */
import { API, arg, canonicalRow, CANONICAL_HEADER, scanBlocks, sleep, waitForApiReady, writeResults } from './lib.mjs';

const SIZES = arg('sizes', '2,20,45,90,150,200').split(',').map(Number);

const main = async () => {
  await waitForApiReady();
  const rows = [];
  for (const n of SIZES) {
    console.log(`\n=== ${n} contract calls merged into ONE transaction ===`);
    const started = Date.now();
    const r = await fetch(`${API}/merge-call-test?n=${n}`, { method: 'POST' }).then((x) => x.json());
    const wallS = (Date.now() - started) / 1000;
    if (!r.ok) {
      console.log(`  ✗ failed at ${r.stage}: ${r.error}`);
      rows.push({
        experiment: 'merged contract calls',
        config: `${n} calls in ONE tx — FAILED (${r.stage}): ${r.error}`,
        requested: n,
        landed: 0,
        wallS: 0,
      });
      continue;
    }
    const blocks = await scanBlocks(r.heightBeforeSubmit, r.heightAfterConfirm + 1);
    console.log(
      `  counter ${r.counterBefore} → ${r.counterAfter} (Δ${r.counterDelta}) ` +
        `prove+balance=${(r.proveBalanceMs / 1000).toFixed(1)}s`,
    );
    const row = {
      experiment: 'merged contract calls',
      config: `${n} calls in ONE tx`,
      requested: n,
      landed: r.counterDelta ?? 0,
      wallS,
      blocks: blocks.length,
      // the merged tx is one extrinsic carrying n ops; it lands in one block
      maxOpsPerBlock: blocks.length > 0 ? n : 0,
    };
    console.log(canonicalRow(row));
    rows.push(row);
    await sleep(8_000);
  }
  console.log(['', ...CANONICAL_HEADER, ...rows.map(canonicalRow)].join('\n'));
  writeResults('merge-calls', 'Merged contract calls (N calls in one transaction)', rows);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
