/**
 * Network configuration, driven by environment variables so the same code runs
 * on the host (localhost ports) and inside docker compose (service hostnames).
 */
export interface NetworkConfig {
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
  readonly networkId: string;
}

export const configFromEnv = (): NetworkConfig => {
  const indexer = process.env.INDEXER_URL ?? 'http://127.0.0.1:8088/api/v4/graphql';
  const indexerWS =
    process.env.INDEXER_WS_URL ?? indexer.replace(/^http/, 'ws').replace(/\/graphql$/, '/graphql/ws');
  return {
    indexer,
    indexerWS,
    node: process.env.NODE_URL ?? 'http://127.0.0.1:9944',
    proofServer: process.env.PROOF_SERVER_URL ?? 'http://127.0.0.1:6300',
    networkId: process.env.NETWORK_ID ?? 'undeployed',
  };
};

/** Genesis-block-funded seed; only valid on undeployed (dev) networks. */
export const GENESIS_MINT_SEED = '0000000000000000000000000000000000000000000000000000000000000001';

/** Where the startscript writes (and the API reads) the shared run state. */
export const STATE_FILE = process.env.STATE_FILE ?? '/shared/state.json';

export interface RunState {
  /** Hex seed of the benchmark ("test") wallet. */
  readonly seed: string;
  /** Bech32m unshielded address of the benchmark wallet. */
  readonly address: string;
  /** Deployed public-counter contract address. */
  readonly contractAddress: string;
  /** Number of NIGHT UTXOs the test wallet was funded with. */
  readonly utxoCount: number;
  readonly createdAt: string;
}
