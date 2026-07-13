# midnight-wallet-dust-utxo-example

How fast can a **single Midnight wallet** build, prove and send transactions to a node?

This repo spins up a local Midnight **1.0.0** network (node + indexer + proof server) with
Docker Compose, prepares a benchmark wallet with **20 NIGHT UTXOs** — each one an
independent dust-generation stream, i.e. one concurrently-spendable fee source — deploys
a contract, and exposes an HTTP API you can load-test externally.

## Stack (docker compose)

| service | image | role |
|---|---|---|
| `node` | `midnightntwrk/midnight-node:1.0.0` | dev-mode chain (`CFG_PRESET: dev`) |
| `indexer` | `midnightntwrk/indexer-standalone:4.3.2` | GraphQL chain/wallet indexer |
| `proof-server` | `midnightntwrk/proof-server:8.1.0` | ZK proving |
| `startscript` | built from this repo | one-shot setup, writes `/shared/state.json`, exits |
| `api` | built from this repo | benchmark HTTP API on `:3300` |

### Startup (what `startscript` does)

1. Builds the **genesis wallet** (seed `…0001`, holds all dev-chain funds) and registers it
   for dust generation so it can pay fees.
2. Creates a fresh **benchmark wallet**, funds it with **one seed UTXO**, and registers its
   night **address** for dust generation — a single transaction.
3. Funds it from genesis with **20 NIGHT outputs** — batches sent as fast as the chain
   confirms them. Dust registration is **address-level** on the ledger
   (`DustRegistration.night_key` → `address_delegation` map): every NIGHT UTXO received
   *after* registration automatically becomes its own dust-generation stream (ledger
   `dust.rs` calls `fresh_dust_output` for each new NIGHT output of a delegated owner).
   20 UTXOs ⇒ 20 dust coins ⇒ 20 fees payable **in parallel**.
   ⚠️ Order matters: UTXOs that pre-date the registration do NOT generate — the SDK has
   to "rotate" them (spend + recreate), and that rotation consolidates them into at most
   2 outputs (observed 20 → 2, i.e. only 2 dust coins). Register first, fund after.
4. Creates and funds an **external wallet** the same way, but does **not** register it for
   dust — it has no way to pay fees, which is exactly test case B.
5. Deploys the **public-counter** contract. Its `count: Counter` is a commutative ledger
   kernel type, so concurrent `incrementBy` transactions change the ledger **without
   competing** — the contract never becomes the bottleneck.
6. Writes `/shared/state.json` (seeds, contract address) and exits.

## Test cases

**A. `mode=self` — the benchmark wallet creates the entire transaction.**
Each `POST /tx` is one `incrementBy(1)` contract call: build → prove (proof server) →
balance fees (dust) → submit → wait for on-chain finalization.

**B. `mode=external` — an external wallet creates the transaction with `{ payFees: false }`.**
The external wallet (no dust) builds and signs a NIGHT transfer; the benchmark wallet only
**balances the missing dust/gas** (`balanceUnprovenTransaction`), finalizes, submits, and
waits for inclusion.

## Usage

```bash
docker compose up -d --build        # start the stack (setup takes ~5 min:
                                    #   register → fund 20 UTXOs → deploy)
curl localhost:3300/health          # → {"ready": true} when setup is done
curl localhost:3300/stats           # wallet balances, dust coins, counter value

node bench/bench.mjs                # run both modes × waves of 1, 5, 20, 50, 100
node bench/bench.mjs --waves 1,5 --modes self   # subset
```

The bench prints (and writes to `results.md`) a markdown table per mode:
requests · ok/failed · wall time · avg/p50/max latency · throughput (tx/s).

### All experiments (with and without merging)

| experiment | script | API endpoint | measures |
|---|---|---|---|
| concurrent waves (no merge) | `bench/bench.mjs` | `POST /tx?mode=self\|external` | end-to-end tx/s per wave, both test cases |
| pre-proven burst (no merge) | `bench/burst.mjs` | `POST /burst?n=N` | node block-packing: N proven txs submitted at once (cap found: 45/block) |
| merged transfers vs baseline | `bench/merge-burst.mjs --groups 1,5,8` | `POST /merge-burst?total=T&group=G` | `group=1` = no merge baseline; `group>1` = Transaction.merge (23 → 40 transfers/block at group 8) |
| merged contract calls | `bench/merge-calls.mjs` | `POST /merge-call-test?n=N` | N `incrementBy` calls in ONE tx, counter-delta verified (150 ok; 200 exceeds cost cap) |

Findings from all runs are consolidated in [results.md](results.md).

### API

| endpoint | description |
|---|---|
| `GET /health` | readiness (503 until wallets + contract are ready) |
| `GET /stats` | counter value, both wallets' UTXO/NIGHT/dust balances, totals |
| `POST /tx` | test case A (self) — full contract-call transaction |
| `POST /tx?mode=external` | test case B — balance + send an externally-created tx |

`TX_CONCURRENCY` (default 8) bounds how many transactions the API pipelines in parallel.

### Host ports (see `.env`)

node `29944` · indexer `28088` · proof server `26300` · api `3300`
(non-default to avoid clashing with a natively-running midnight stack).

## Versions

Pinned to the midnight-ref-ai **v1.0.0** slot: `@midnight-ntwrk/wallet-sdk` 1.1.0,
`midnight-js` 4.1.1, `compact-js` 2.5.1, `ledger-v8` 8.1.0 (npm `overrides` keep the whole
family at these versions — newer releases pull the unpublished `ledger-v9`).
`contracts/managed/` is the precompiled `public-counter` (compactc 0.31).
