/**
 * Thin wrapper around the compiled `public-counter` contract. `count` is a
 * `Counter` — a commutative ledger kernel type — so concurrent `incrementBy`
 * transactions all apply without competing over state.
 */
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import { type ContractAddress } from '@midnight-ntwrk/compact-runtime';
import {
  createCallTxOptions,
  deployContract,
  findDeployedContract,
  submitCallTxAsync,
} from '@midnight-ntwrk/midnight-js/contracts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as PublicCounter from '../contracts/managed/public-counter/contract/index.js';
import { type NetworkConfig } from './network.js';
import { configureProviders } from './providers.js';
import { type WalletContext } from './wallet.js';

export const CONTRACT_NAME = 'public-counter';
const PRIVATE_STATE_ID = 'publicCounterPrivateState' as const;

type PrivateState = Record<string, never>;
type Circuits = 'incrementBy' | 'reset';

/** contracts/managed/public-counter, resolved relative to this module (works from dist/ and src/). */
export const zkConfigPath = (): string =>
  process.env.ZK_CONFIG_PATH ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'managed', CONTRACT_NAME);

const compiledContract = () =>
  CompiledContract.make(CONTRACT_NAME, PublicCounter.Contract).pipe(
    CompiledContract.withVacantWitnesses,
    CompiledContract.withCompiledFileAssets(zkConfigPath()),
  );

export const counterProviders = (ctx: WalletContext, cfg: NetworkConfig) =>
  configureProviders<typeof PRIVATE_STATE_ID, Circuits>(ctx, cfg, {
    privateStateStoreName: `${CONTRACT_NAME}-private-state`,
    zkConfigPath: zkConfigPath(),
  });

export type CounterProviders = Awaited<ReturnType<typeof counterProviders>>;

export const deployCounter = async (providers: CounterProviders, initial = 0) => {
  const deployOptions = {
    compiledContract: compiledContract(),
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: {} as PrivateState,
    args: [BigInt(initial)],
  };
  return await (deployContract as (p: CounterProviders, o: typeof deployOptions) => ReturnType<typeof deployContract>)(
    providers,
    deployOptions,
  );
};

export const connectCounter = async (providers: CounterProviders, contractAddress: ContractAddress) => {
  const findOptions = {
    contractAddress,
    compiledContract: compiledContract(),
    privateStateId: PRIVATE_STATE_ID,
    initialPrivateState: {} as PrivateState,
  };
  return await (
    findDeployedContract as (p: CounterProviders, o: typeof findOptions) => ReturnType<typeof findDeployedContract>
  )(providers, findOptions);
};

/**
 * Build, prove, balance and SUBMIT one `incrementBy(1)` call — without waiting
 * for finalization. The convenience `callTx` path waits via an indexer
 * subscription (`watchForTxData`) that races tx inclusion: when the tx
 * finalizes before the watcher connects, the event never fires and the call
 * hangs forever (reliably reproduced under concurrency). Callers should await
 * finalization through the wallet's own pending-transaction set instead.
 */
export const submitIncrementAsync = async (
  providers: CounterProviders,
  contractAddress: ContractAddress,
): Promise<{ txHash: string }> => {
  const options = createCallTxOptions(
    compiledContract(),
    'incrementBy' as never,
    contractAddress,
    PRIVATE_STATE_ID,
    undefined,
    [1n] as never,
  );
  const submitted = (await (
    submitCallTxAsync as (p: CounterProviders, o: typeof options) => Promise<{ txId: string }>
  )(providers, options)) as { txId: string };
  return { txHash: submitted.txId };
};

export const readCount = async (
  providers: CounterProviders,
  contractAddress: ContractAddress,
): Promise<bigint | null> => {
  const state = await providers.publicDataProvider.queryContractState(contractAddress);
  return state == null ? null : PublicCounter.ledger(state.data).count;
};
