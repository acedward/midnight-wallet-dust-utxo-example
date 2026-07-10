/**
 * midnight-js provider wiring for contract deploy/call, backed by the wallet
 * facade. Adapted from midnight-canary's provider-wiring.
 */
import { type FinalizedTransaction } from '@midnight-ntwrk/ledger-v8';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { type MidnightProvider, type UnboundTransaction, type WalletProvider } from '@midnight-ntwrk/midnight-js/types';
import { Buffer } from 'buffer';
import { type NetworkConfig } from './network.js';
import { firstSyncedState, type WalletContext } from './wallet.js';

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
  const accountId = wmp.getCoinPublicKey();
  const storagePassword = `${Buffer.from(accountId, 'hex').toString('base64')}!`;
  return {
    privateStateProvider: levelPrivateStateProvider<PSI>({
      privateStateStoreName: wiring.privateStateStoreName,
      accountId,
      privateStoragePasswordProvider: () => storagePassword,
    }),
    publicDataProvider: indexerPublicDataProvider(cfg.indexer, cfg.indexerWS),
    zkConfigProvider,
    proofProvider: httpClientProofProvider(cfg.proofServer, zkConfigProvider),
    walletProvider: wmp,
    midnightProvider: wmp,
  };
};
