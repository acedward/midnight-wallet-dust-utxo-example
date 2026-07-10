/**
 * One-shot startup orchestrator:
 *
 * 1. Build the genesis wallet (holds all funds on the dev chain) and register
 *    it for dust generation so it can pay fees.
 * 2. Create a fresh benchmark wallet.
 * 3. Fund it with ONE seed UTXO and register its night address for dust
 *    generation (a single tx). Dust registration is address-level on the
 *    ledger: every NIGHT UTXO received AFTER registration automatically
 *    becomes its own dust-generation stream — no re-registration needed.
 * 4. Fund it from genesis with TARGET_UTXOS separate NIGHT outputs, sending
 *    the batches as fast as the chain accepts them. Each arriving output
 *    auto-generates dust (one dust coin each = parallel fee capacity).
 * 5. Create and fund an "external" wallet the same way — but do NOT register
 *    it for dust: it builds transactions with { payFees: false } and the
 *    benchmark wallet balances the missing dust for it (test case B).
 * 6. Deploy the public-counter contract (from genesis, so the benchmark
 *    wallet's dust is untouched).
 * 7. Write /shared/state.json for the API service, then exit 0.
 */
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { configFromEnv, GENESIS_MINT_SEED, type RunState, STATE_FILE } from './network.js';
import { counterProviders, deployCounter } from './counter.js';
import {
  buildWallet,
  firstSyncedState,
  generateFreshSeed,
  nightBalance,
  registerForDustGeneration,
  unshieldedAddressOf,
  waitForDustCoins,
  waitForFunds,
  waitForSync,
  waitForUtxoCount,
  type WalletContext,
} from './wallet.js';

const TARGET_UTXOS = Number(process.env.TARGET_UTXOS ?? 20);
/** External wallet's UTXO pool. Its in-flight transfer capacity == this, so size it to the largest planned wave. */
const EXTERNAL_UTXOS = Number(process.env.EXTERNAL_UTXOS ?? TARGET_UTXOS);
const OUTPUTS_PER_TX = Number(process.env.OUTPUTS_PER_TX ?? 10);

const t0 = Date.now();
const log = (msg: string): void => {
  console.log(`[start +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Send one funding tx with `count` equal outputs to `to`; retries on transient failures (e.g. dust still accruing). */
const sendBatch = async (
  genesis: WalletContext,
  to: ReturnType<typeof unshieldedAddressOf>['address'],
  amount: bigint,
  count: number,
): Promise<string> => {
  const night = unshieldedToken().raw;
  const outputs = Array.from({ length: count }, () => ({ type: night, receiverAddress: to, amount }));
  let lastError: unknown;
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const recipe = await genesis.wallet.transferTransaction(
        [{ type: 'unshielded', outputs }],
        { shieldedSecretKeys: genesis.shieldedSecretKeys, dustSecretKey: genesis.dustSecretKey },
        { ttl: new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signed = await genesis.wallet.signRecipe(recipe, (payload) => genesis.unshieldedKeystore.signData(payload));
      const finalized = await genesis.wallet.finalizeRecipe(signed);
      return await genesis.wallet.submitTransaction(finalized);
    } catch (err) {
      lastError = err;
      log(`funding tx attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}); retrying in 5s`);
      await sleep(5_000);
    }
  }
  throw lastError;
};

const main = async (): Promise<void> => {
  const cfg = configFromEnv();
  log(`network config: node=${cfg.node} indexer=${cfg.indexer} proof=${cfg.proofServer}`);

  // 1. Genesis wallet: sync, confirm funds, register for dust so it can pay fees.
  log('building genesis wallet…');
  const genesis = await buildWallet(cfg, GENESIS_MINT_SEED);
  await waitForSync(genesis.wallet);
  const genesisFunds = await waitForFunds(genesis.wallet);
  log(`genesis wallet synced, NIGHT balance=${genesisFunds}`);
  await registerForDustGeneration(genesis);
  log('genesis wallet registered for dust generation');

  // 2. Fresh benchmark + external wallets.
  const seed = process.env.BENCH_WALLET_SEED ?? generateFreshSeed();
  log('building benchmark wallet…');
  const bench = await buildWallet(cfg, seed);
  await waitForSync(bench.wallet);
  const benchAddr = unshieldedAddressOf(bench);
  log(`benchmark wallet ready: ${benchAddr.encoded}`);

  const externalSeed = process.env.EXTERNAL_WALLET_SEED ?? generateFreshSeed();
  log('building external wallet…');
  const external = await buildWallet(cfg, externalSeed);
  await waitForSync(external.wallet);
  const externalAddr = unshieldedAddressOf(external);
  log(`external wallet ready: ${externalAddr.encoded}`);

  const amountPerUtxo = BigInt(
    process.env.AMOUNT_PER_UTXO ?? String(genesisFunds / BigInt((TARGET_UTXOS + EXTERNAL_UTXOS) * 2)),
  );

  // Fund a wallet with `count` NIGHT outputs, batches sent back-to-back as
  // fast as the chain confirms them (each new batch spends genesis change, so
  // a batch must land before the next is built).
  const fund = async (name: string, target: ReturnType<typeof unshieldedAddressOf>, wallet: WalletContext, count: number) => {
    const base = (await firstSyncedState(wallet.wallet)).unshielded.availableCoins.length;
    let sent = 0;
    while (sent < count) {
      const n = Math.min(OUTPUTS_PER_TX, count - sent);
      const txId = await sendBatch(genesis, target.address, amountPerUtxo, n);
      sent += n;
      log(`${name} funding tx submitted (${n} outputs of ${amountPerUtxo} NIGHT atoms): ${txId}`);
      // Wait until the receiving wallet sees the new outputs before sending more.
      await waitForUtxoCount(wallet.wallet, base + sent);
      log(`${name} wallet now holds ${base + sent}+ NIGHT UTXOs`);
    }
  };

  // 3. Seed + register the benchmark wallet's night ADDRESS (single tx).
  //    Registration is address-level: everything funded after this point
  //    auto-generates dust — no further registrations needed.
  await fund('benchmark(seed)', benchAddr, bench, 1);
  log('registering benchmark wallet address for dust generation…');
  await registerForDustGeneration(bench, log);
  log('benchmark wallet registered — subsequent NIGHT deposits auto-generate dust');

  // 4. Fund both wallets. The external wallet is deliberately NOT registered:
  //    it has no dust and must build transactions with { payFees: false }.
  await fund('benchmark', benchAddr, bench, TARGET_UTXOS);
  await fund('external', externalAddr, external, EXTERNAL_UTXOS);

  // Every post-registration deposit becomes its own dust-generation stream;
  // wait until they are all live (dust coins = parallel fee capacity).
  const benchState = await waitForDustCoins(bench.wallet, TARGET_UTXOS);
  log(
    `benchmark wallet dust generation active: utxos=${benchState.unshielded.availableCoins.length} ` +
      `dustCoins=${benchState.dust.availableCoins.length} ` +
      `night=${nightBalance(benchState)} dust=${benchState.dust.balance(new Date())}`,
  );

  // 5. Deploy the counter contract from genesis.
  log('deploying public-counter contract…');
  const providers = await counterProviders(genesis, cfg);
  const deployed = await deployCounter(providers, 0);
  const contractAddress = deployed.deployTxData.public.contractAddress;
  log(`public-counter deployed at ${contractAddress}`);

  // 6. Persist state for the API (atomic write: tmp + rename).
  const state: RunState = {
    seed,
    address: benchAddr.encoded,
    externalSeed,
    externalAddress: externalAddr.encoded,
    contractAddress,
    utxoCount: benchState.unshielded.availableCoins.length,
    createdAt: new Date().toISOString(),
  };
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
  log(`state written to ${STATE_FILE} — startup complete`);

  await Promise.allSettled([genesis.wallet.stop(), bench.wallet.stop(), external.wallet.stop()]);
  process.exit(0);
};

main().catch((err) => {
  console.error('[start] FAILED:', err);
  process.exit(1);
});
