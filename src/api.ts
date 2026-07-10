/**
 * Benchmark API. Waits for the startscript's state file, builds the benchmark
 * wallet, connects to the deployed public-counter contract, then serves:
 *
 *   GET  /health         → { ready }  (503 until wallets + contract are ready)
 *   GET  /stats          → counter value, wallet balances, tx totals
 *   POST /tx             → test case A ("self"): the benchmark wallet creates
 *                          the ENTIRE transaction — build + prove + balance +
 *                          submit one `incrementBy(1)` contract call; responds
 *                          when the tx is finalized on-chain
 *   POST /tx?mode=external → test case B: the EXTERNAL wallet creates a
 *                          transaction with { payFees: false } (it has no
 *                          dust); the benchmark wallet only balances the
 *                          missing dust/gas and submits it
 *
 * Incoming /tx requests flow through a semaphore (TX_CONCURRENCY) — the wallet
 * builds and proves as many transactions in parallel as allowed; the Counter
 * ledger type is commutative so case-A txs never conflict on contract state.
 */
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as Rx from 'rxjs';
import { configFromEnv, type RunState, STATE_FILE } from './network.js';
import { connectCounter, counterProviders, readCount, type CounterProviders } from './counter.js';
import {
  buildWallet,
  firstSyncedState,
  nightBalance,
  parseUnshieldedAddress,
  waitForFunds,
  waitForSync,
  type WalletContext,
} from './wallet.js';

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

type TxMode = 'self' | 'external';

interface TxResult {
  readonly ok: boolean;
  readonly id: number;
  readonly mode: TxMode;
  readonly txHash?: string;
  readonly blockHeight?: number;
  readonly error?: string;
  /** ms spent waiting for a concurrency slot */
  readonly queueMs: number;
  /** ms spent building + proving + submitting + awaiting finalization */
  readonly execMs: number;
  readonly totalMs: number;
}

interface WalletSummary {
  readonly address: string;
  readonly utxos: number;
  readonly night: string;
  readonly dust: string;
  readonly dustCoins: number;
}

interface Ready {
  readonly state: RunState;
  readonly providers: CounterProviders;
  // deployed contract handle — callTx typed loosely; the generics don't survive our minimal factory
  readonly counter: { callTx: { incrementBy: (n: bigint) => Promise<unknown> } };
  readonly bench: WalletContext;
  readonly external: WalletContext;
  readonly benchInfo: () => WalletSummary;
  readonly externalInfo: () => WalletSummary;
  readonly sendExternal: () => Promise<{ txHash: string }>;
}

let ready: Ready | null = null;
let startupError: string | null = null;
const emptyTotals = () => ({ requested: 0, succeeded: 0, failed: 0 });
const totals: Record<TxMode, ReturnType<typeof emptyTotals>> = { self: emptyTotals(), external: emptyTotals() };
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
  const bench = await buildWallet(cfg, state.seed);
  await waitForSync(bench.wallet);
  await waitForFunds(bench.wallet);
  log('benchmark wallet synced and funded');

  log('building external wallet…');
  const external = await buildWallet(cfg, state.externalSeed);
  await waitForSync(external.wallet);
  await waitForFunds(external.wallet);
  log('external wallet synced and funded');

  const providers = await counterProviders(bench, cfg);
  const counter = (await connectCounter(providers, state.contractAddress)) as unknown as Ready['counter'];
  log(`connected to public-counter at ${state.contractAddress}`);

  const track = (ctx: WalletContext) => {
    let latest: Awaited<ReturnType<typeof firstSyncedState>>;
    const init = firstSyncedState(ctx.wallet).then((s) => {
      latest = s;
      ctx.wallet.state().subscribe({
        next: (next) => {
          latest = next;
        },
      });
    });
    return { init, latest: () => latest };
  };
  const benchTrack = track(bench);
  const externalTrack = track(external);
  await Promise.all([benchTrack.init, externalTrack.init]);

  const summarize = (address: string, latest: () => Awaited<ReturnType<typeof firstSyncedState>>): WalletSummary => {
    const s = latest();
    return {
      address,
      utxos: s.unshielded.availableCoins.length,
      night: nightBalance(s).toString(),
      dust: s.dust.balance(new Date()).toString(),
      dustCoins: s.dust.availableCoins.length,
    };
  };

  const benchAddress = parseUnshieldedAddress(state.address);
  const night = unshieldedToken().raw;
  const externalTransferAmount = BigInt(process.env.EXTERNAL_TRANSFER_AMOUNT ?? 1_000_000);

  /**
   * Test case B: the external wallet creates and signs a NIGHT transfer with
   * { payFees: false } (it holds no dust); the benchmark wallet balances the
   * missing dust fee, proves/finalizes, submits, and waits for finalization.
   */
  const sendExternal = async (): Promise<{ txHash: string }> => {
    const ttl = new Date(Date.now() + 30 * 60 * 1000);
    // 1. External wallet builds the fee-less transaction and signs its inputs.
    const recipe = await external.wallet.transferTransaction(
      [{ type: 'unshielded', outputs: [{ type: night, receiverAddress: benchAddress, amount: externalTransferAmount }] }],
      { shieldedSecretKeys: external.shieldedSecretKeys, dustSecretKey: external.dustSecretKey },
      { ttl, payFees: false },
    );
    const signed = await external.wallet.signRecipe(recipe, (payload) => external.unshieldedKeystore.signData(payload));
    if (signed.type !== 'UNPROVEN_TRANSACTION') throw new Error(`unexpected recipe type: ${signed.type}`);

    // 2. Benchmark wallet balances the missing dust/gas, finalizes and submits.
    const balanced = await bench.wallet.balanceUnprovenTransaction(
      signed.transaction,
      { shieldedSecretKeys: bench.shieldedSecretKeys, dustSecretKey: bench.dustSecretKey },
      { ttl },
    );
    const finalized = await bench.wallet.finalizeRecipe(balanced);
    const ids = finalized.identifiers();
    const txHash = await bench.wallet.submitTransaction(finalized);

    // 3. Wait until the tx leaves the benchmark wallet's pending set (applied
    //    on-chain), so "complete" means the same thing as in test case A.
    await Rx.firstValueFrom(
      bench.wallet.state().pipe(
        Rx.filter((s) => s.isSynced),
        Rx.filter((s) => {
          const items = s.pending.all;
          for (const item of items) {
            const itemIds = item.tx.identifiers();
            if (ids.some((id) => itemIds.includes(id))) {
              const result = (item as { result?: { status?: string } }).result;
              if (result?.status === 'FAILURE') throw new Error(`transaction failed on-chain: ${txHash}`);
              return false; // still pending
            }
          }
          return true; // no longer pending → finalized
        }),
        Rx.timeout({ first: 10 * 60_000 }),
      ),
    );
    return { txHash };
  };

  ready = {
    state,
    providers,
    counter,
    bench,
    external,
    benchInfo: () => summarize(state.address, benchTrack.latest),
    externalInfo: () => summarize(state.externalAddress, externalTrack.latest),
    sendExternal,
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

const handleTx = async (mode: TxMode): Promise<TxResult> => {
  const id = nextId++;
  totals[mode].requested++;
  const started = Date.now();
  const release = await semaphore.acquire();
  const queueMs = Date.now() - started;
  try {
    const execStarted = Date.now();
    const info =
      mode === 'self'
        ? extractTxInfo(await ready!.counter.callTx.incrementBy(1n))
        : await ready!.sendExternal();
    const execMs = Date.now() - execStarted;
    totals[mode].succeeded++;
    return { ok: true, id, mode, ...info, queueMs, execMs, totalMs: Date.now() - started };
  } catch (err) {
    totals[mode].failed++;
    const message = err instanceof Error ? err.message : String(err);
    log(`tx #${id} (${mode}) failed: ${message}`);
    return {
      ok: false,
      id,
      mode,
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
      const count = await readCount(ready.providers, ready.state.contractAddress);
      return json(res, 200, {
        ready: true,
        contractAddress: ready.state.contractAddress,
        counter: count?.toString() ?? null,
        wallet: ready.benchInfo(),
        externalWallet: ready.externalInfo(),
        totals,
        concurrency: { size: semaphore.size, inUse: semaphore.inUse, queued: semaphore.queued },
      });
    }
    if (req.method === 'POST' && url.pathname === '/tx') {
      if (!ready) return json(res, 503, { ok: false, error: 'not ready' });
      const modeParam = url.searchParams.get('mode') ?? 'self';
      if (modeParam !== 'self' && modeParam !== 'external') {
        return json(res, 400, { ok: false, error: `unknown mode "${modeParam}" — use self or external` });
      }
      const result = await handleTx(modeParam);
      return json(res, result.ok ? 200 : 500, result);
    }
    return json(res, 404, { error: 'not found — use GET /health, GET /stats, POST /tx[?mode=self|external]' });
  })().catch((err: unknown) => {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  });
});

server.listen(PORT, () => log(`listening on :${PORT} (initializing…)`));

init().catch((err: unknown) => {
  startupError = err instanceof Error ? err.message : String(err);
  console.error('[api] startup FAILED:', err);
});
