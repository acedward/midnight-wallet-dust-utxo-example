/**
 * Shared helpers for the bench scripts, including the CANONICAL results table
 * — every experiment reports the same columns so results are comparable:
 *
 *   experiment | config | ops requested | ops landed | wall (s) | blocks | max ops/block | ops/s
 *
 * - "ops" are logical operations (contract calls or transfers), not extrinsics.
 * - "wall" is submit→all-finalized for burst-style runs, first-request→last-response
 *   for wave-style runs.
 * - "blocks" / "max ops/block" come from scanning the node's blocks over the
 *   run's height window (extrinsics minus the 3 inherents every block carries).
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { Agent, setGlobalDispatcher } from 'undici';

// Requests legitimately take many minutes under load; undici's default 5-min
// headers/body timeouts would kill them client-side.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

export const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const API = arg('api', process.env.API_URL ?? 'http://127.0.0.1:3300');
export const NODE = arg('node', process.env.NODE_RPC_URL ?? 'http://127.0.0.1:29944');
/** Extrinsics every block carries with no user txs (timestamp + inherents). */
export const BASELINE_EXTRINSICS = Number(arg('baseline', 3));

export const rpc = async (method, params = []) => {
  const res = await fetch(NODE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
  });
  return (await res.json()).result;
};

export const currentHeight = async () => parseInt((await rpc('chain_getHeader')).number, 16);

/** Per-block user-extrinsic counts over [from, to]; blocks with none are dropped. */
export const scanBlocks = async (from, to) => {
  const rows = [];
  for (let h = from; h <= to; h++) {
    const hash = await rpc('chain_getBlockHash', [h]);
    const block = await rpc('chain_getBlock', [hash]);
    const userTxs = Math.max(0, block.block.extrinsics.length - BASELINE_EXTRINSICS);
    if (userTxs > 0) rows.push({ height: h, userTxs });
  }
  return rows;
};

export const waitForApiReady = async () => {
  for (;;) {
    const health = await fetch(`${API}/health`).then((r) => r.json()).catch(() => ({}));
    if (health.ready) break;
    process.stdout.write('.');
    await sleep(5000);
  }
  // Don't measure while the API is still draining work from a previous run.
  for (;;) {
    const s = await fetch(`${API}/stats`).then((r) => r.json()).catch(() => null);
    if (s && s.concurrency?.inUse === 0 && s.concurrency?.queued === 0) break;
    process.stdout.write('~');
    await sleep(5000);
  }
  console.log(' API ready & idle.');
};

export const BLOCK_TIME_S = 6;

export const CANONICAL_HEADER = [
  '| experiment | config | ops requested | ops landed | wall (s) | blocks | max ops/block | ops/s (wall) | ops/s (chain) |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|',
];

/** Chain-side seconds actually spanned by the busy blocks (first→last, inclusive). */
export const chainSpanS = (blocks) =>
  blocks.length > 0 ? (blocks[blocks.length - 1].height - blocks[0].height + 1) * BLOCK_TIME_S : 0;

/**
 * @param r {{experiment: string, config: string, requested: number, landed: number,
 *            wallS: number, blocks?: number|string, maxOpsPerBlock?: number|string,
 *            chainS?: number}}
 *
 * ops/s (wall)  = landed / wall — what the submitting client experiences,
 *                 including proving handoff and finalization OBSERVATION lag.
 * ops/s (chain) = landed / (busy block span × 6s) — what the chain actually
 *                 sustained while carrying the work.
 */
export const canonicalRow = (r) => {
  const opsPerS = r.wallS > 0 ? (r.landed / r.wallS).toFixed(2) : '—';
  const chainOpsPerS = r.chainS && r.chainS > 0 ? (r.landed / r.chainS).toFixed(2) : '—';
  return (
    `| ${r.experiment} | ${r.config} | ${r.requested} | ${r.landed} | ${r.wallS.toFixed(1)} | ` +
    `${r.blocks ?? '—'} | ${r.maxOpsPerBlock ?? '—'} | ${opsPerS} | ${chainOpsPerS} |`
  );
};

/** Write the canonical table for one script run, and append it to results.md. */
export const writeResults = (scriptName, title, rows, extra = '') => {
  const md = `\n## ${title}\n\nRun: ${new Date().toISOString()}\n\n${[
    ...CANONICAL_HEADER,
    ...rows.map(canonicalRow),
  ].join('\n')}\n${extra}`;
  const artifact = new URL(`../${scriptName}-results.md`, import.meta.url).pathname;
  writeFileSync(artifact, md);
  appendFileSync(new URL('../results.md', import.meta.url).pathname, md);
  console.log(md);
  console.log(`written to ${artifact} and appended to results.md`);
};
