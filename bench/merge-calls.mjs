#!/usr/bin/env node
/**
 * Merged CONTRACT CALLS experiment: how many `incrementBy(1)` calls fit in ONE
 * merged transaction? (The ledger-v8 TS docs claim contract-interaction txs
 * can't merge — the Rust implementation has no such check, and this proves it
 * on-chain: the counter delta is read from the contract after each run.)
 *
 *   node bench/merge-calls.mjs [--api http://127.0.0.1:3300] [--sizes 2,20,45,90,150,200]
 */
import { writeFileSync } from 'node:fs';
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const API = arg('api', 'http://127.0.0.1:3300');
const SIZES = arg('sizes', '2,20,45,90,150,200').split(',').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    console.log(`\n=== ${n} contract calls merged into ONE transaction ===`);
    const r = await fetch(`${API}/merge-call-test?n=${n}`, { method: 'POST' }).then((x) => x.json());
    if (r.ok) {
      console.log(
        `  counter ${r.counterBefore} → ${r.counterAfter} (Δ${r.counterDelta}) ` +
          `build=${(r.buildMs / 1000).toFixed(1)}s prove+balance=${(r.proveBalanceMs / 1000).toFixed(1)}s ` +
          `blocks ${r.heightBeforeSubmit}..${r.heightAfterConfirm}`,
      );
    } else {
      console.log(`  ✗ failed at ${r.stage}: ${r.error}`);
    }
    results.push({ n, ...r });
    await sleep(8000);
  }

  const lines = [
    '| calls merged into one tx | result | counter Δ | prove+balance (s) |',
    '|---:|---|---:|---:|',
    ...results.map((r) =>
      r.ok
        ? `| ${r.n} | ok | +${r.counterDelta} | ${(r.proveBalanceMs / 1000).toFixed(1)} |`
        : `| ${r.n} | ✗ ${r.stage}: ${r.error} | — | — |`,
    ),
  ];
  const md = `\n## Merged contract calls (one transaction, N \`incrementBy\` intents)\n\nRun: ${new Date().toISOString()}\n\n${lines.join('\n')}\n`;
  console.log(md);
  writeFileSync(new URL('../merge-calls-results.md', import.meta.url).pathname, md);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
