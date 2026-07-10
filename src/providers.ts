/**
 * midnight-js provider wiring for contract deploy/call, backed by the wallet
 * facade. Adapted from midnight-canary's provider-wiring.
 */
import { type FinalizedTransaction } from '@midnight-ntwrk/ledger-v8';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import {
  type MidnightProvider,
  type PrivateStateProvider,
  type UnboundTransaction,
  type WalletProvider,
} from '@midnight-ntwrk/midnight-js/types';
import { type NetworkConfig } from './network.js';
import { firstSyncedState, type WalletContext } from './wallet.js';

/**
 * In-memory PrivateStateProvider. The level(-db) provider locks its database
 * per operation and trips "Database failed to open" under concurrent contract
 * calls; public-counter has no private state or witnesses, so a Map is all we
 * need — and it keeps the benchmark free of disk I/O.
 */
export const inMemoryPrivateStateProvider = <PSI extends string, PS>(): PrivateStateProvider<PSI, PS> => {
  const states = new Map<string, PS>();
  const signingKeys = new Map<string, string>();
  let contractAddress = '';
  return {
    setContractAddress(address: string): void {
      contractAddress = address;
    },
    async set(privateStateId: PSI, state: PS): Promise<void> {
      states.set(`${contractAddress}:${privateStateId}`, state);
    },
    async get(privateStateId: PSI): Promise<PS | null> {
      return states.get(`${contractAddress}:${privateStateId}`) ?? null;
    },
    async remove(privateStateId: PSI): Promise<void> {
      states.delete(`${contractAddress}:${privateStateId}`);
    },
    async clear(): Promise<void> {
      states.clear();
    },
    async setSigningKey(address: string, signingKey: string): Promise<void> {
      signingKeys.set(address, signingKey);
    },
    async getSigningKey(address: string): Promise<string | null> {
      return signingKeys.get(address) ?? null;
    },
    async removeSigningKey(address: string): Promise<void> {
      signingKeys.delete(address);
    },
  } as PrivateStateProvider<PSI, PS>;
};

export const createWalletAndMidnightProvider = async (
  ctx: WalletContext,
): Promise<WalletProvider & MidnightProvider> => {
  const state = await firstSyncedState(ctx.wallet);
  return {
    getCoinPublicKey() {
      return state.shielded.coinPublicKey.toHexString();
    },
    getEncryptionPublicKey() {
      return state.shielded.encryptionPublicKey.toHexString();
    },
    async balanceTx(tx: UnboundTransaction, ttl?: Date): Promise<FinalizedTransaction> {
      const recipe = await ctx.wallet.balanceUnboundTransaction(
        tx,
        { shieldedSecretKeys: ctx.shieldedSecretKeys, dustSecretKey: ctx.dustSecretKey },
        { ttl: ttl ?? new Date(Date.now() + 30 * 60 * 1000) },
      );
      const signed = await ctx.wallet.signRecipe(recipe, (payload: Uint8Array) =>
        ctx.unshieldedKeystore.signData(payload),
      );
      return ctx.wallet.finalizeRecipe(signed);
    },
    submitTx(tx: FinalizedTransaction) {
      return ctx.wallet.submitTransaction(tx);
    },
  };
};

export const configureProviders = async <PSI extends string, CIRC extends string>(
  ctx: WalletContext,
  cfg: NetworkConfig,
  wiring: { readonly privateStateStoreName: string; readonly zkConfigPath: string },
) => {
  const wmp = await createWalletAndMidnightProvider(ctx);
  const zkConfigProvider = new NodeZkConfigProvider<CIRC>(wiring.zkConfigPath);
  return {
    privateStateProvider: inMemoryPrivateStateProvider<PSI, unknown>(),
    publicDataProvider: indexerPublicDataProvider(cfg.indexer, cfg.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(cfg.proofServer, zkConfigProvider),
    walletProvider: wmp,
    midnightProvider: wmp,
  };
};
