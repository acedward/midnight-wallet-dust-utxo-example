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
import {
  buildUnprovenIncrementTx,
  connectCounter,
  counterProviders,
  readCount,
  type CounterProviders,
} from './counter.js';
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

type SetPhase = (phase: string) => void;

interface Ready {
  readonly state: RunState;
  readonly providers: CounterProviders;
  readonly bench: WalletContext;
  readonly external: WalletContext;
  readonly benchInfo: () => WalletSummary;
  readonly externalInfo: () => WalletSummary;
  readonly sendSelf: (setPhase: SetPhase) => Promise<{ txHash: string }>;
  readonly sendExternal: (setPhase: SetPhase) => Promise<{ txHash: string }>;
}

let ready: Ready | null = null;
let startupError: string | null = null;
const emptyTotals = () => ({ requested: 0, succeeded: 0, failed: 0 });
const totals: Record<TxMode, ReturnType<typeof emptyTotals>> = { self: emptyTotals(), external: emptyTotals() };
let nextId = 1;
const semaphore = new Semaphore(TX_CONCURRENCY);
/** What each in-flight request is doing right now — surfaced via /stats to make any hang immediately visible. */
const inFlight = new Map<number, { mode: TxMode; phase: string; since: number }>();

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
  // Verifies the deployment AND seeds the (vacant) private state into the
  // provider — createUnprovenCallTx requires an entry at the private state ID.
  await connectCounter(providers, state.contractAddress);
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
   * Wait until a submitted tx leaves the benchmark wallet's pending set
   * (applied on-chain). This is the reliable finalization signal: unlike the
   * indexer `watchForTxData` subscription (which races tx inclusion and hangs
   * forever when the tx lands before the watcher connects), the wallet tracks
   * its own pending transactions and always observes their resolution.
   */
  const waitForFinalization = async (ids: readonly string[], txHash: string): Promise<void> => {
    const finalized = Rx.firstValueFrom(
      bench.wallet.state().pipe(
        Rx.filter((s) => s.isSynced),
        Rx.filter((s) => {
          const items = s.pending.all;
          for (const item of items) {
            const itemIds = item.tx.identifiers();
            if (ids.some((id) => itemIds.includes(id))) {
              // A CheckedItem carries the on-chain result while still listed;
              // SUCCESS means finalized — only result-less items are pending.
              const result = (item as { result?: { status?: string } }).result;
              if (result?.status === 'SUCCESS' || result?.status === 'PARTIAL_SUCCESS') return true;
              if (result?.status === 'FAILURE') throw new Error(`transaction failed on-chain: ${txHash}`);
              return false; // no result yet → still pending
            }
          }
          return true; // no longer listed → finalized (cleared)
        }),
      ),
    );
    // Overall deadline (Rx.timeout({first}) only bounds the FIRST emission —
    // the state stream emits continuously, so it never fires here).
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`finalization not observed within 10min: ${txHash}`)), 10 * 60_000);
    });
    try {
      await Promise.race([finalized, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Submit a finalized tx and wait for on-chain finalization. The submit await
   * itself is hang-prone under concurrency (observed: tx broadcast + applied
   * on-chain, `wallet.submitTransaction` never resolves), so it is RACED
   * against the pending-set watch: whichever signal arrives first wins, and a
   * genuine submission error still fails fast.
   */
  const submitAndFinalize = async (
    finalized: { identifiers: () => string[] },
    setPhase: SetPhase,
  ): Promise<{ txHash: string }> => {
    const ids = finalized.identifiers();
    const txHash = ids[0] ?? 'unknown';
    setPhase('submit+finalize');
    const submit: Promise<{ ok: true } | { ok: false; err: unknown }> = bench.wallet
      .submitTransaction(finalized as never)
      .then(
        () => ({ ok: true as const }),
        (err: unknown) => ({ ok: false as const, err }),
      );
    const finalizedWatch = waitForFinalization(ids, txHash).then(() => 'finalized' as const);
    const first = await Promise.race([submit, finalizedWatch]);
    if (first === 'finalized') return { txHash }; // applied on-chain; ignore a dangling submit await
    if (!first.ok) throw first.err instanceof Error ? first.err : new Error(String(first.err));
    await finalizedWatch;
    return { txHash };
  };

  /**
   * Test case A: the benchmark wallet creates the ENTIRE transaction — one
   * `incrementBy(1)` contract call: build → prove → balance dust → submit →
   * wait for on-chain finalization.
   */
  const sendSelf = async (setPhase: SetPhase): Promise<{ txHash: string }> => {
    setPhase('build');
    const unprovenTx = await buildUnprovenIncrementTx(providers, state.contractAddress);
    setPhase('prove');
    const proven = await providers.proofProvider.proveTx(unprovenTx as never);
    setPhase('balance');
    const finalized = await providers.walletProvider.balanceTx(proven);
    return submitAndFinalize(finalized, setPhase);
  };

  /**
   * Test case B: the EXTERNAL wallet creates, signs and PROVES a NIGHT
   * transfer with { payFees: false } — a proven, bound, but UNBALANCED
   * transaction (it holds no dust, so it cannot pay fees). The benchmark
   * wallet then only balances the missing dust/gas onto the finished tx
   * (`balanceFinalizedTransaction` — proving just the small balancing intent),
   * submits, and waits for finalization. The creator carries the heavy
   * proving cost; the balancer's work is fee balancing + submission only.
   */
  const sendExternal = async (setPhase: SetPhase): Promise<{ txHash: string }> => {
    const ttl = new Date(Date.now() + 30 * 60 * 1000);
    // 1. External wallet builds, signs and proves the fee-less transaction.
    setPhase('external-build');
    const recipe = await external.wallet.transferTransaction(
      [{ type: 'unshielded', outputs: [{ type: night, receiverAddress: benchAddress, amount: externalTransferAmount }] }],
      { shieldedSecretKeys: external.shieldedSecretKeys, dustSecretKey: external.dustSecretKey },
      { ttl, payFees: false },
    );
    const signed = await external.wallet.signRecipe(recipe, (payload) => external.unshieldedKeystore.signData(payload));
    setPhase('external-prove');
    const provenUnbalanced = await external.wallet.finalizeRecipe(signed);

    // 2. Benchmark wallet balances the missing dust/gas onto the proven tx —
    //    only the balancing intent itself remains to be proved.
    setPhase('balance');
    const balancedRecipe = await bench.wallet.balanceFinalizedTransaction(
      provenUnbalanced,
      { shieldedSecretKeys: bench.shieldedSecretKeys, dustSecretKey: bench.dustSecretKey },
      { ttl },
    );
    setPhase('prove-balance');
    const finalized = await bench.wallet.finalizeRecipe(balancedRecipe);

    // 3. Same submit + finalization semantics as test case A.
    return submitAndFinalize(finalized, setPhase);
  };

  ready = {
    state,
    providers,
    bench,
    external,
    benchInfo: () => summarize(state.address, benchTrack.latest),
    externalInfo: () => summarize(state.externalAddress, externalTrack.latest),
    sendSelf,
    sendExternal,
  };
  log(`API ready on :${PORT} (tx concurrency=${TX_CONCURRENCY})`);
};

const handleTx = async (mode: TxMode): Promise<TxResult> => {
  const id = nextId++;
  totals[mode].requested++;
  const started = Date.now();
  inFlight.set(id, { mode, phase: 'queue', since: started });
  const setPhase: SetPhase = (phase) => inFlight.set(id, { mode, phase, since: Date.now() });
  const release = await semaphore.acquire();
  const queueMs = Date.now() - started;
  try {
    const execStarted = Date.now();
    const info = mode === 'self' ? await ready!.sendSelf(setPhase) : await ready!.sendExternal(setPhase);
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
    inFlight.delete(id);
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
        inFlight: Array.from(inFlight.entries()).map(([id, f]) => ({
          id,
          mode: f.mode,
          phase: f.phase,
          forMs: Date.now() - f.since,
        })),
      });
    }
    if (req.method === 'GET' && url.pathname === '/pending') {
      if (!ready) return json(res, 503, { ready: false });
      const s = await firstSyncedState(ready.bench.wallet);
      return json(res, 200, {
        pending: s.pending.all.map((item) => ({
          ids: item.tx.identifiers(),
          result: (item as { result?: { status?: string } }).result?.status ?? null,
        })),
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

// Requests legitimately take minutes under load (queue + prove + finalize);
// Node's default requestTimeout (5 min) would destroy the socket mid-flight.
server.requestTimeout = 0;
server.headersTimeout = 60_000;

server.listen(PORT, () => log(`listening on :${PORT} (initializing…)`));

init().catch((err: unknown) => {
  startupError = err instanceof Error ? err.message : String(err);
  console.error('[api] startup FAILED:', err);
});
