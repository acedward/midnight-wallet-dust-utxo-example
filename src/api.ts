/**
 * Benchmark API. Waits for the startscript's state file, builds the benchmark
 * wallet, connects to the deployed public-counter contract, then serves:
 *
 *   GET  /health  → { ready }  (503 until the wallet + contract are ready)
 *   GET  /stats   → counter value, wallet UTXO/dust/night balances, tx totals
 *   POST /tx      → build + prove + submit one `incrementBy(1)` tx; responds
 *                   when the tx is finalized on-chain, with per-phase timings
 *
 * Incoming /tx requests flow through a semaphore (TX_CONCURRENCY) — the wallet
 * builds and proves as many transactions in parallel as allowed; the Counter
 * ledger type is commutative so the txs never conflict on contract state.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { configFromEnv, type RunState, STATE_FILE } from './network.js';
import { connectCounter, counterProviders, readCount, type CounterProviders } from './counter.js';
import { buildWallet, firstSyncedState, nightBalance, waitForFunds, waitForSync } from './wallet.js';

const PORT = Number(process.env.PORT ?? 3300);
const TX_CONCURRENCY = Number(process.env.TX_CONCURRENCY ?? 8);

const log = (msg: string): void => {
  console.log(`[api ${new Date().toISOString()}] ${msg}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Plain counting semaphore for bounding concurrent tx pipelines. */
class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];
  constructor(readonly size: number) {
    this.available = size;
  }
  get inUse(): number {
    return this.size - this.available;
  }
  get queued(): number {
    return this.waiters.length;
  }
  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      this.available--;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.available++;
      this.waiters.shift()?.();
    };
  }
}

interface TxResult {
  readonly ok: boolean;
  readonly id: number;
  readonly txHash?: string;
  readonly blockHeight?: number;
  readonly error?: string;
  /** ms spent waiting for a concurrency slot */
  readonly queueMs: number;
  /** ms spent building + proving + submitting + awaiting finalization */
  readonly execMs: number;
  readonly totalMs: number;
}

interface Ready {
  readonly state: RunState;
  readonly providers: CounterProviders;
  // deployed contract handle — callTx typed loosely; the generics don't survive our minimal factory
  readonly counter: { callTx: { incrementBy: (n: bigint) => Promise<unknown> } };
  readonly dustBalance: () => bigint;
  readonly walletInfo: () => Promise<{ utxos: number; night: string; dust: string }>;
}

let ready: Ready | null = null;
let startupError: string | null = null;
const totals = { requested: 0, succeeded: 0, failed: 0 };
let nextId = 1;
const semaphore = new Semaphore(TX_CONCURRENCY);

const init = async (): Promise<void> => {
  while (!existsSync(STATE_FILE)) {
    log(`waiting for ${STATE_FILE} (startscript still running)…`);
    await sleep(5_000);
  }
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as RunState;
  log(`state loaded: wallet=${state.address} contract=${state.contractAddress} utxos=${state.utxoCount}`);

  const cfg = configFromEnv();
  log('building benchmark wallet…');
  const ctx = await buildWallet(cfg, state.seed);
  await waitForSync(ctx.wallet);
  await waitForFunds(ctx.wallet);
  log('benchmark wallet synced and funded');

  const providers = await counterProviders(ctx, cfg);
  const counter = (await connectCounter(providers, state.contractAddress)) as unknown as Ready['counter'];
  log(`connected to public-counter at ${state.contractAddress}`);

  let latest = await firstSyncedState(ctx.wallet);
  ctx.wallet.state().subscribe({
    next: (s) => {
      latest = s;
    },
  });

  ready = {
    state,
    providers,
    counter,
    dustBalance: () => latest.dust.balance(new Date()),
    walletInfo: async () => ({
      utxos: latest.unshielded.availableCoins.length,
      night: nightBalance(latest).toString(),
      dust: latest.dust.balance(new Date()).toString(),
    }),
  };
  log(`API ready on :${PORT} (tx concurrency=${TX_CONCURRENCY})`);
};

const extractTxInfo = (result: unknown): { txHash?: string; blockHeight?: number } => {
  // FinalizedCallTxData shape: { public: { txHash, blockHeight, ... }, private: {...} } — probe defensively.
  const pub = (result as { public?: Record<string, unknown> })?.public ?? (result as Record<string, unknown>);
  if (!pub || typeof pub !== 'object') return {};
  const rec = pub as Record<string, unknown>;
  const txHash = typeof rec.txHash === 'string' ? rec.txHash : typeof rec.txId === 'string' ? rec.txId : undefined;
  const blockHeight =
    typeof rec.blockHeight === 'number' || typeof rec.blockHeight === 'bigint' ? Number(rec.blockHeight) : undefined;
  return { txHash, blockHeight };
};

const handleTx = async (): Promise<TxResult> => {
  const id = nextId++;
  totals.requested++;
  const started = Date.now();
  const release = await semaphore.acquire();
  const queueMs = Date.now() - started;
  try {
    const execStarted = Date.now();
    const result = await ready!.counter.callTx.incrementBy(1n);
    const execMs = Date.now() - execStarted;
    totals.succeeded++;
    return { ok: true, id, ...extractTxInfo(result), queueMs, execMs, totalMs: Date.now() - started };
  } catch (err) {
    totals.failed++;
    const message = err instanceof Error ? err.message : String(err);
    log(`tx #${id} failed: ${message}`);
    return {
      ok: false,
      id,
      error: message,
      queueMs,
      execMs: Date.now() - started - queueMs,
      totalMs: Date.now() - started,
    };
  } finally {
    release();
  }
};

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2));
};

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/health') {
      if (startupError) return json(res, 500, { ready: false, error: startupError });
      return json(res, ready ? 200 : 503, { ready: ready !== null });
    }
    if (req.method === 'GET' && url.pathname === '/stats') {
      if (!ready) return json(res, 503, { ready: false });
      const [wallet, count] = await Promise.all([
        ready.walletInfo(),
        readCount(ready.providers, ready.state.contractAddress),
      ]);
      return json(res, 200, {
        ready: true,
        contractAddress: ready.state.contractAddress,
        counter: count?.toString() ?? null,
        wallet: { address: ready.state.address, ...wallet },
        totals,
        concurrency: { size: semaphore.size, inUse: semaphore.inUse, queued: semaphore.queued },
      });
    }
    if (req.method === 'POST' && url.pathname === '/tx') {
      if (!ready) return json(res, 503, { ok: false, error: 'not ready' });
      const result = await handleTx();
      return json(res, result.ok ? 200 : 500, result);
    }
    return json(res, 404, { error: 'not found — use GET /health, GET /stats, POST /tx' });
  })().catch((err: unknown) => {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  });
});

server.listen(PORT, () => log(`listening on :${PORT} (initializing…)`));

init().catch((err: unknown) => {
  startupError = err instanceof Error ? err.message : String(err);
  console.error('[api] startup FAILED:', err);
});
