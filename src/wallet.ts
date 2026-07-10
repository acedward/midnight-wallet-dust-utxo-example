/**
 * Wallet construction and readiness helpers for the local `undeployed` devnet.
 * Trimmed from midnight-canary's wallet-builder (no state cache — the local
 * chain is recreated on every `docker compose up`).
 */
import * as ledger from '@midnight-ntwrk/ledger-v8';
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import { getNetworkId, setNetworkId } from '@midnight-ntwrk/midnight-js/network-id';
import { toHex } from '@midnight-ntwrk/midnight-js/utils';
import {
  createKeystore,
  DustWallet,
  type FacadeState,
  generateRandomSeed,
  HDWallet,
  InMemoryTransactionHistoryStorage,
  MidnightBech32m,
  PublicKey,
  Roles,
  ShieldedWallet,
  TransactionHistoryStorage,
  UnshieldedAddress,
  type UnshieldedKeystore,
  UnshieldedWallet,
  WalletFacade,
} from '@midnight-ntwrk/wallet-sdk';
import { Buffer } from 'buffer';
import * as Rx from 'rxjs';
import { WebSocket } from 'ws';
import { type NetworkConfig } from './network.js';

// @ts-expect-error apollo client wants a global WebSocket
globalThis.WebSocket = WebSocket;

export interface WalletContext {
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
}

const deriveKeysFromSeed = (seed: string) => {
  const hdWallet = HDWallet.fromSeed(Buffer.from(seed, 'hex'));
  if (hdWallet.type !== 'seedOk') throw new Error('Failed to initialize HDWallet from seed');
  const result = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== 'keysDerived') throw new Error('Failed to derive keys');
  hdWallet.hdWallet.clear();
  return result.keys;
};

export const buildWallet = async (cfg: NetworkConfig, seed: string): Promise<WalletContext> => {
  setNetworkId(cfg.networkId);

  const keys = deriveKeysFromSeed(seed);
  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

  const walletConfig = {
    networkId: getNetworkId(),
    indexerClientConnection: { indexerHttpUrl: cfg.indexer, indexerWsUrl: cfg.indexerWS },
    provingServerUrl: new URL(cfg.proofServer),
    relayURL: new URL(cfg.node.replace(/^http/, 'ws')),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(TransactionHistoryStorage.TransactionHistoryCommonSchema),
    costParameters: {
      additionalFeeOverhead: BigInt(process.env.FEE_OVERHEAD ?? 300_000_000_000_000n),
      // 5 blocks × ~6s = the exact 30s quantization observed in external-mode
      // dust balancing under concurrency; tunable to probe/relax that gate.
      feeBlocksMargin: Number(process.env.FEE_BLOCKS_MARGIN ?? 5),
    },
  };

  const wallet = await WalletFacade.init({
    configuration: walletConfig,
    shielded: (c) => ShieldedWallet(c).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (c) => UnshieldedWallet(c).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (c) => DustWallet(c).startWithSecretKey(dustSecretKey, ledger.LedgerParameters.initialParameters().dust),
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  return { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore };
};

/** Resolve with the wallet's first synced `FacadeState`. */
export const firstSyncedState = (wallet: WalletFacade): Promise<FacadeState> =>
  Rx.firstValueFrom(wallet.state().pipe(Rx.filter((s) => s.isSynced)));

export const waitForSync = (wallet: WalletFacade): Promise<FacadeState> =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(2_000),
      Rx.filter((s) => s.isSynced),
    ),
  );

export const nightBalance = (state: FacadeState): bigint =>
  state.unshielded.balances[unshieldedToken().raw] ?? 0n;

export const waitForFunds = (wallet: WalletFacade): Promise<bigint> =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(2_000),
      Rx.filter((s) => s.isSynced),
      Rx.map((s) => nightBalance(s)),
      Rx.filter((b) => b > 0n),
    ),
  );

/** Wait until the wallet holds at least `count` unshielded NIGHT UTXOs; resolves with the synced state. */
export const waitForUtxoCount = (wallet: WalletFacade, count: number): Promise<FacadeState> =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(1_000),
      Rx.filter((s) => s.isSynced),
      Rx.filter((s) => s.unshielded.availableCoins.length >= count),
    ),
  );

/**
 * Register the wallet's night ADDRESS for dust generation, then wait until the
 * dust balance is positive. No-op when there is nothing to register.
 *
 * Dust registration is address-level on the ledger (`DustRegistration.night_key`
 * → `address_delegation` map): every NIGHT UTXO created for a registered owner
 * AFTER registration automatically gets its own dust-generation stream
 * (ledger `dust.rs`: `fresh_dust_output` on each new NIGHT output whose owner
 * is delegated). Only UTXOs that pre-date the registration need to be passed
 * here — the SDK "rotates" them (spend + recreate) to bootstrap generation,
 * consolidating them into at most two outputs in the process.
 *
 * Therefore: register EARLY with few UTXOs, and fund the wallet afterwards —
 * post-registration deposits each become an independent dust coin with no
 * further transactions.
 */
export const registerForDustGeneration = async (
  ctx: WalletContext,
  log: (msg: string) => void = () => undefined,
): Promise<void> => {
  const state = await firstSyncedState(ctx.wallet);

  const nightUtxos = state.unshielded.availableCoins.filter(
    (coin: { meta?: { registeredForDustGeneration?: boolean } }) => coin.meta?.registeredForDustGeneration !== true,
  );
  if (nightUtxos.length === 0) return;

  const recipe = await ctx.wallet.registerNightUtxosForDustGeneration(
    nightUtxos,
    ctx.unshieldedKeystore.getPublicKey(),
    (payload) => ctx.unshieldedKeystore.signData(payload),
  );
  const finalized = await ctx.wallet.finalizeRecipe(recipe);
  const txId = await ctx.wallet.submitTransaction(finalized);
  log(`dust registration submitted (${nightUtxos.length} pre-existing utxo(s) rotated): ${txId}`);

  await Rx.firstValueFrom(
    ctx.wallet.state().pipe(
      Rx.throttleTime(2_000),
      Rx.filter((s) => s.isSynced),
      Rx.filter((s) => s.dust.balance(new Date()) > 0n),
    ),
  );
};

/** Wait until the wallet holds at least `count` dust coins (independent fee-paying streams). */
export const waitForDustCoins = (wallet: WalletFacade, count: number): Promise<FacadeState> =>
  Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(2_000),
      Rx.filter((s) => s.isSynced),
      Rx.filter((s) => s.dust.availableCoins.length >= count),
    ),
  );

export const generateFreshSeed = (): string => toHex(Buffer.from(generateRandomSeed()));

/** The wallet's own unshielded address, in both bech32m string and decoded form. */
export const unshieldedAddressOf = (
  ctx: WalletContext,
): { readonly encoded: string; readonly address: UnshieldedAddress } => {
  const bech = ctx.unshieldedKeystore.getBech32Address();
  return { encoded: bech.asString(), address: bech.decode(UnshieldedAddress, getNetworkId()) };
};

/** Parse a bech32m unshielded address string into the SDK's `UnshieldedAddress`. */
export const parseUnshieldedAddress = (input: string): UnshieldedAddress =>
  MidnightBech32m.parse(input.trim()).decode(UnshieldedAddress, getNetworkId());

/** Derive the unshielded address for a seed without building a wallet (e.g. throwaway sink addresses). */
export const deriveUnshieldedAddress = (seed: string): UnshieldedAddress => {
  const keys = deriveKeysFromSeed(seed);
  const keystore = createKeystore(keys[Roles.NightExternal], getNetworkId());
  return keystore.getBech32Address().decode(UnshieldedAddress, getNetworkId());
};
