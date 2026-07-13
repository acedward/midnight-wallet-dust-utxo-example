# midnight-wallet-dust-utxo-example

How fast can a **single Midnight wallet** build, prove and send transactions to a node?

This repo spins up a local Midnight **1.0.0** network with Docker Compose, prepares a
benchmark wallet whose NIGHT UTXOs each auto-generate an independent **dust** stream
(= one concurrently-spendable fee source), deploys a counter contract, and exposes an
HTTP API that four benchmark scripts drive. All experiments report the **same canonical
table** so results are directly comparable.

## Results (canonical format)

All rows: 6s blocks · node 1.0.0 · 12 Docker CPUs · 3 proof servers. "ops" are logical
operations (contract calls or transfers); "landed" is chain-verified.

| experiment | config | ops requested | ops landed | wall (s) | blocks | max ops/block | ops/s |
|---|---|---:|---:|---:|---:|---:|---:|
| waves (self) | 20 concurrent, no merge | 20 | 20 | 24.0 | — | — | 0.83 |
| waves (self) | 100 concurrent, no merge | 100 | 100 | 72.5 | — | — | 1.38 |
| waves (self) | 200 concurrent, no merge | 200 | 200 | 125.1 | — | — | 1.60 |
| burst (pre-proven) | 40 txs at once, no merge | 40 | 40 | 30 | 1 | 40 | 1.33 |
| burst (pre-proven) | 100 txs at once, no merge | 100 | 100 | 33 | 3 | **45** | 3.03 |
| merged transfers | 90 transfers, no merge (baseline) | 90 | 90 | 21 | 4 | 23 | 4.29 |
| merged transfers | 90 transfers, merged ×8 | 90 | 90 | 14 | 2–3 | **40** | 6.43 |
| merged contract calls | 45 calls in ONE tx | 45 | 45 | ~19 | 1 | 45 | 2.4 |
| merged contract calls | **150 calls in ONE tx** | 150 | 150 | ~20 | 1 | **150** | **7.5** |

Headline findings:

- **Block time is exactly 6.00s**; blocks fill to `HitBlockWeightLimit` — every cap below
  is one weight budget in different tx sizes.
- **Node ceiling: 45 unmerged txs/block** (burst test: 100 pre-proven txs submitted at
  once land as `45+45+10` with zero drops).
- **End-to-end bottleneck is ZK proving CPU**, never the node: during wave 200 the node
  produced *empty blocks* between 21-tx blocks while all client lanes were proving.
- **`Transaction.merge` works for contract calls** (the TS `@throws` doc is stale — the
  Rust impl only rejects segment-id collisions): **150 calls in one tx**, counter-delta
  verified. Transfers merge too, capped ~8–9 (transfer intents cost far more in the
  ledger's superlinear-in-intents fee model; hitting the cap gives
  `Malformed(FeeCalculation)` / "exceeded block limit in transaction fee computation").
- **Dust registration is address-level**: register the wallet's night address FIRST
  (one tx), then fund — every NIGHT UTXO received afterwards auto-generates dust.
  Fund-then-register consolidates your UTXOs to ≤2 (only 2 parallel fee sources).
- **Capacity model**: burst = accrued dust + dust-coin count; sustained = dust
  generation rate ∝ NIGHT held; parallel fee payments = dust-coin count.

The full investigation log (every run, failures included) is in [results.md](results.md).

## Reproduce

Prerequisites:

- Docker Desktop with **≥ 8 CPUs allocated to the VM** (`docker info --format '{{.NCPU}}'`
  — the default 2 CPUs makes proving ~10× slower and invalidates comparisons)
- Node.js ≥ 22 on the host (for the bench scripts)

```bash
cp .env.example .env          # benchmarked configuration
npm install                   # host-side deps for the bench scripts
docker compose up -d --build  # node + indexer + 3 proof servers + LB + startscript + api
curl localhost:3300/health    # wait for {"ready":true}   (setup ≈ 10 min: register →
                              #  fund 110+100 UTXOs → deploy contract)

# The four experiments — each appends its canonical table to results.md:
node bench/bench.mjs          # 1. concurrent waves, no merging (self + external modes)
node bench/burst.mjs          # 2. pre-proven burst → node's per-block packing cap
node bench/merge-burst.mjs    # 3. merged transfers vs group=1 unmerged baseline
node bench/merge-calls.mjs    # 4. N contract calls merged into ONE transaction
```

Every script prints per-run detail plus the canonical table, writes
`<script>-results.md`, and appends to `results.md`.

## Stack (docker compose)

| service | image | role |
|---|---|---|
| `node` | `midnightntwrk/midnight-node:1.0.0` | dev-mode chain (`CFG_PRESET: dev`, 6s blocks) |
| `indexer` | `midnightntwrk/indexer-standalone:4.3.2` | GraphQL chain/wallet indexer |
| `proof-server` ×3 | `midnightntwrk/proof-server:8.1.0` | ZK proving (stateless, horizontally scaled) |
| `proof-lb` | `nginx:alpine` | `least_conn` load balancer over the proof servers |
| `startscript` | built from this repo | one-shot setup, writes `/shared/state.json`, exits |
| `api` | built from this repo | benchmark HTTP API on `:3300` |

### Startup (what `startscript` does)

1. Genesis wallet (seed `…0001`) registers for dust generation and pays for setup.
2. Benchmark wallet: fund **one seed UTXO** → **register its night address** (single tx)
   → fund `TARGET_UTXOS` — every post-registration deposit auto-generates dust
   (address-level registration, ledger `dust.rs` `address_delegation`).
3. External wallet: funded with `EXTERNAL_UTXOS`, **never registered** — it must build
   transactions with `{ payFees: false }` (test case B).
4. Deploys `public-counter` — its `count: Counter` is commutative, so concurrent
   increments never conflict on contract state.

## Test cases

**A. `mode=self`** — the benchmark wallet creates the ENTIRE transaction:
build → prove → balance fees (dust) → submit → finalized on-chain.

**B. `mode=external`** — an external wallet creates, signs and **proves** a NIGHT
transfer with `{ payFees: false }` (proven, bound, unbalanced); the benchmark wallet
only balances the missing dust (`balanceFinalizedTransaction`) and submits.
Measured: identical throughput to case A (waves 5–50 within 0.4s of each other).

## API

| endpoint | description |
|---|---|
| `GET /health` | readiness (503 until wallets + contract are ready) |
| `GET /stats` | counter value, wallet balances/dust coins, totals, in-flight phases |
| `POST /tx?mode=self\|external` | one full transaction (test case A or B) |
| `POST /burst?n=N` | pre-prove N txs, submit simultaneously |
| `POST /merge-burst?total=T&group=G` | T transfers merged in groups of G |
| `POST /merge-call-test?n=N` | N contract calls merged into ONE tx (counter-verified) |

## Versions

Pinned to the midnight-ref-ai **v1.0.0** slot: `@midnight-ntwrk/wallet-sdk` 1.1.0,
`midnight-js` 4.1.1, `compact-js` 2.5.1, `ledger-v8` 8.1.0 — npm `overrides` hold the
whole family (newer releases pull the unpublished `ledger-v9`). `contracts/managed/` is
the precompiled `public-counter` (compactc 0.31).
