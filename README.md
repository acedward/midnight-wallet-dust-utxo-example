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

"wall" = elapsed seconds of the measured phase: submit → all finalized for burst/merge
rows (proving happens before the clock); full pipeline (build+prove+…+finalized) for
waves and merged-calls rows. Top-tier configs use **full-block multiples** (45 unmerged
txs/block, 40 merged-×8 transfers/block) so the peak rows show clean per-block packing.

Two throughput columns: **ops/s (wall)** = what the submitting client experiences
(includes proving handoff and finalization *observation* lag, which grows with tx
count); **ops/s (chain)** = ops ÷ (busy-block span × 6s) — what the chain actually
sustained. The last column names the ceiling each row presses against. Three limits
exist: **proving** — client ZK proof throughput (CPU); **block weight** — the chain
packs ~45 unmerged txs / ~5 merged-×8 transfers / 1 merged-×150 tx per 6s block (node
logs `HitBlockWeightLimit`); **observation** — client-side lag watching finalizations,
visible as the wall column trailing the chain column.

| experiment | config | ops | landed | wall (s) | blocks | max ops/block | ops/s (wall) | ops/s (chain) | limiting factor (theoretical) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| waves (self) | 20 concurrent, no merge | 20 | 20 | 24.0 | — | — | 0.83 | — | pipeline latency: 20 ÷ ~20s ≈ 1.0 |
| waves (self) | 200 concurrent, no merge | 200 | 200 | 125.1 | — | — | 1.60 | — | proving: ~1.7 proofs/s on this machine |
| burst (pre-proven) | 90 txs at once (2×45) | 90 | 90 | 24.8 | 2 | **45** | 3.63 | **7.50** | **block weight: 45/block — chain at ceiling** |
| burst (pre-proven) | 225 txs at once (5×45) | 225 | 225 | 63.5 | 5 | **45** | 3.54 | **7.50** | **block weight — 5 consecutive full blocks** |
| merged transfers | 80 transfers, no merge (baseline) | 80 | 80 | 37.7 | 4 | 23 | 2.12 | 3.33 | block weight: 23/block ⇒ 3.8 |
| merged transfers | 80 transfers, merged ×8 (2×40) | 80 | 80 | 21.7 | 2 | **40** | 3.69 | 6.67 | block weight: 40/block ⇒ 6.7 |
| merged contract calls | **150 calls in ONE tx** | 150 | 150 | 23.0 | 1 | **150** | 6.51 | 25.00 | one block of work; wall pays the round trip |
| sustained (single) | 180 txs pipelined, 32 lanes | 180 | 180 | 109.7 | 16 | 30 | 1.64 | 1.76 | **proving: ~1.7 proofs/s — at the ceiling** |
| sustained (merged) | **1200 calls, merged ×150 continuous** | 1200 | 1200 | 63.2 | 8 | **150** | **18.99** | **25.00** | **block weight: 150/block ⇒ 25 — at the ceiling** |

Note how the chain column exposes what the wall column hides: pre-proven bursts of ANY
size run the chain at exactly **7.50 tx/s** (the 225-burst filled 5 consecutive blocks,
45+45+45+45+45) — the wall figure trails only because the wallet takes extra seconds to
*observe* the finalizations. Unmerged sustained throughput is proving-bound (~1.7); the
merged stream holds the chain at its true 25 ops/s ceiling indefinitely.

(Chain-side the burst's `45+45` spans two 6s blocks — 7.5 tx/s of pure block capacity;
the wall column additionally includes the wallet observing finalization via the indexer.)

The sustained rows show round-trip amortization over many blocks: one-shot runs pay
~2 blocks of fixed overhead (proving handoff + finalization observation) regardless of
size. A CONTINUOUS merged stream kept **8 consecutive blocks completely full
(150+150+150+150+150+150+150+150)** — 1200 ops in 48s of chain time = 25 ops/s
chain-side, 17.98 ops/s measured wall. Sustained single-tx mode stays ~1.7 ops/s: the
client's proving rate (not the chain) caps how fast unmerged blocks can be filled.

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

## Dust cost per transaction (measured via `POST /fees`)

Exact fees from the ledger's own computation (`calculateTransactionFee`), on prepared-
then-reverted txs. 1 DUST = 10^15 specks.

| tx shape | fee (specks) | fee per op |
|---|---:|---:|
| contract call, single tx | 290 | 290 |
| 45 calls merged in one tx | 4,952 | 110 |
| 150 calls merged in one tx | 15,336 | 102 |
| NIGHT transfer, balanced | 715 | 715 |

With 62.8M NIGHT held, dust generation is 5.2×10^17 specks/s — ~15 orders of magnitude
above fee spend, so on this dev chain the dust BALANCE never limits throughput. The
practical dust constraints are per-coin: each in-flight tx locks one whole dust coin
until its change matures (parallelism = coin count), and balancing reserves the
`additionalFeeOverhead` margin (3×10^14 specks) per coin — which is why near-worthless
dust coins from micro NIGHT UTXOs fail with "could not balance dust".
