# fast-tx benchmark results

Run: 2026-07-13T17:42:07.953Z  ·  API: http://127.0.0.1:3300  ·  waves: 20, 50, 100, 200

## mode: self

The benchmark wallet creates the ENTIRE transaction — one `incrementBy(1)` contract call:
build → prove (proof server) → balance fees (dust) → submit → finalized on-chain.

| requests | ok | failed | wall time (s) | avg latency (s) | p50 (s) | max (s) | throughput (tx/s) | counter after |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 20 | 20 | 0 | 24.0 | 20.2 | 17.7 | 24.0 | 0.83 | 20 |
| 50 | 50 | 0 | 35.7 | 25.9 | 23.7 | 35.7 | 1.40 | 70 |
| 100 | 100 | 0 | 72.5 | 39.2 | 36.6 | 72.5 | 1.38 | 170 |
| 200 | 200 | 0 | 125.1 | 67.5 | 70.6 | 125.1 | 1.60 | 370 |

## Scaling run: hunting the node's limit

Config: Docker VM 2→12 CPUs · 3 proof servers behind nginx `least_conn` · 32 pipeline
lanes · 33 dust coins · 6e12 NIGHT/UTXO. Self mode, fresh chain:

| requests | ok | wall (s) | avg (s) | p50 (s) | throughput (tx/s) |
|---:|---:|---:|---:|---:|---:|
| 20 | 20 | 24.0 | 20.2 | 17.7 | 0.83 |
| 50 | 50 | 35.7 | 25.9 | 23.7 | 1.40 |
| 100 | 100 | 72.5 | 39.2 | 36.6 | 1.38 |
| 200 | 200 | 125.1 | 67.5 | 70.6 | **1.60** |

Per-block extrinsic counts over the run (idle block = 3 inherents; "ours" = count − 3):
peak block carried **24 benchmark txs**; the steady wave-200 pattern is a repeating
`[21, 17, 3]` cycle — ~32 txs land across two blocks, then an **empty block** while all
32 lanes are busy proving the next batch (~18s pipeline ≈ 3 block times).

**Conclusion: the node's limit was NOT reached.** It absorbed 24 single-wallet txs in
one 6s block with zero rejects and then idled, waiting for the client. The binding
constraint is still ZK proving throughput on this machine (12 vCPUs shared by node +
indexer + 3 provers + wallet). Node ceiling ≥ 4 tx/s from one wallet; to find the real
one, proving must move to separate hardware (N proof-server machines), then raise
TX_CONCURRENCY/dust coins in step.

Dust after 370 txs: balance still growing (4.0e20) — at 6e12-NIGHT UTXOs the fee budget
sustains this rate indefinitely; dust was not a limiter in this run.

## Burst test (pre-proven txs submitted simultaneously)

Run: 2026-07-13T18:26:54.150Z

| burst size | prepared | finalized | submit→confirm (s) | blocks used | distribution | max in one block |
|---:|---:|---:|---:|---:|---:|---:|
| 20 | 20 | 20 | 0.0 | 1 | 20 | 20 |
| 30 | 30 | 30 | 0.0 | 1 | 29 | 29 |
| 40 | 40 | 40 | 0.0 | 1 | 40 | 40 |
| 60 | 60 | 60 | 0.0 | 2 | 45+15 | 45 |
| 100 | 100 | 100 | 2.8 | 3 | 45+45+10 | 45 |

The 100-burst distribution — `45 + 45 + 10` in three consecutive blocks, nothing dropped
(100/100 finalized) — pins the node's per-block packing cap at **45 of these txs per
block** (block weight/size limit; all benchmark txs are identical counter-call + dust
shape). At 6s blocks that is a **node-side ceiling of 7.5 tx/s** for this tx type. The
mempool absorbed 100 pre-proven simultaneous submissions cleanly and spilled the excess
into subsequent blocks in order.

End-to-end implication: to saturate the node (7.5 tx/s) the client side must prove ~45
txs per 6s — roughly 5-10× this machine's proving throughput — i.e. a fleet of proof
servers. The chain itself was never the bottleneck until exactly 45/block.

## Transaction.merge test (does merging improve throughput?)

Contract calls cannot merge at all (ledger: at most ONE contract interaction per
transaction). Fee-less transfers CAN — after rebuilding each at a random segment id
(`Transaction.fromPartsRandomized`; wallet-built txs all sit at segment 1 and collide
in `merge`). The benchmark wallet then balances each merged tx ONCE: one dust coin and
one dust proof per GROUP instead of per transfer.

| merge group | result | merged txs/block | transfers/block |
|---:|---|---:|---:|
| 1 (baseline) | ok | 23 | 23 |
| 5 | ok | 7 | 35 |
| **8** | **ok** | **5** | **40 (+74%)** |
| 10 | ✗ node: `Malformed(FeeCalculation)` = `BlockLimitExceeded` | — | — |
| 15 / 45 | ✗ same | — | — |
| 90 | ✗ client: "exceeded block limit in transaction fee computation" | — | — |

Findings:
- **Yes, merging improves things**: +74% transfers per block (23 → 40) and an 8× cut in
  the balancer's dust proofs (one per group), plus 8× fewer dust coins needed.
- The merge width is capped ≈ 8-9 intents per tx: the ledger's fee/cost model is
  **superlinear in intents** — a 5-transfer merge costs ≤1/7 block, a 15-transfer merge
  exceeds an ENTIRE block's cost budget (`fees()` normalizes tx cost against
  `params.limits.block_limits` and errors).
- Raising the wallet's `additionalFeeOverhead` does not help — it is a hard cost-model
  bound, not underpayment.
- All blocks fill to `HitBlockWeightLimit` (node log) — every per-block cap measured in
  this repo (45 counter calls, 23 plain transfers, 5 merged-8 txs) is the same weight
  budget expressed in different transaction sizes.

## Transaction.merge test (80 transfers per config)

Run: 2026-07-13T18:45:28.725Z

| group size | merged txs | finalized | transfers landed | balance+prove (s) | blocks | extrinsics/block | max transfers in one block |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 8 | 10 | 10 | 80 | 1.5 | 2 | 5+5 | 40 |
| 10 | 8 | 0 | 0 | 1.2 | 0 |  | 0 |

## Merged CONTRACT CALLS — the TS docs are wrong (empirically falsified)

`ledger-v8.d.ts` says `merge` throws "if both transactions have contract interactions".
The Rust implementation (`structure.rs::merge`) has NO such check — only network-id and
segment-id-collision checks. Tested on-chain (counter delta verified via indexer each time):

| calls merged into ONE tx | result | counter delta | prove+balance |
|---:|---|---:|---:|
| 2 / 4 / 8 / 12 / 16 / 20 | ✅ | +n each | ~0.5s |
| 45 | ✅ | +45 | 1.0s |
| 90 | ✅ | +90 | 1.7s |
| **150** | ✅ | **+150** | 2.7s |
| 200 / 250 / 300 | ✗ "exceeded block limit in transaction fee computation" | — | — |

- **One merged transaction carried 150 contract calls** — 3.3× the previous per-block
  record (45 separate txs) inside a single extrinsic, and the whole thing proves in
  under 3 seconds.
- Single-tx cost cap for counter calls sits between 150 and 200 (same superlinear
  cost-model wall as transfers, but counter-call intents are far cheaper than transfer
  intents: 150 vs ~9 mergeable).
- Segment ids must be unique across the whole batch (birthday paradox at 100+ random
  draws from 65534 — dedupe with a used-set).

Revised throughput picture: batching via merge lifts the per-block ceiling for these
contract calls from 45 to ~150+ ops (≈25 ops/s at 6s blocks), with proving cost per op
collapsing (one balancing + shared envelope). The TS `@throws` doc for `merge` should be
reported upstream as stale.

## Pre-proven burst (no merging)

Run: 2026-07-13T19:35:49.077Z

| experiment | config | ops requested | ops landed | wall (s) | blocks | max ops/block | ops/s |
|---|---|---:|---:|---:|---:|---:|---:|
| burst (pre-proven) | 90 txs submitted at once, no merge | 90 | 90 | 30.0 | 2 | 45 | 3.00 |

## Merged transfers vs unmerged baseline (Transaction.merge)

Run: 2026-07-13T19:37:31.258Z

| experiment | config | ops requested | ops landed | wall (s) | blocks | max ops/block | ops/s |
|---|---|---:|---:|---:|---:|---:|---:|
| merged transfers | 80 transfers, no merge (baseline) | 80 | 46 | 30.0 | 5 | 23 | 1.53 |
| merged transfers | 80 transfers, merged ×8 | 80 | 80 | 30.0 | 2 | 40 | 2.67 |

## Pre-proven burst (no merging)

Run: 2026-07-13T19:42:44.834Z

| experiment | config | ops requested | ops landed | wall (s) | blocks | max ops/block | ops/s |
|---|---|---:|---:|---:|---:|---:|---:|
| burst (pre-proven) | 90 txs submitted at once, no merge | 90 | 90 | 23.9 | 2 | 45 | 3.77 |

## Merged transfers vs unmerged baseline (Transaction.merge)

Run: 2026-07-13T19:45:26.198Z

| experiment | config | ops requested | ops landed | wall (s) | blocks | max ops/block | ops/s |
|---|---|---:|---:|---:|---:|---:|---:|
| merged transfers | 80 transfers, no merge (baseline) | 80 | 80 | 37.7 | 4 | 23 | 2.12 |
| merged transfers | 80 transfers, merged ×8 | 80 | 80 | 21.7 | 2 | 40 | 3.69 |

## Merged contract calls (N calls in one transaction)

Run: 2026-07-13T19:46:17.416Z

| experiment | config | ops requested | ops landed | wall (s) | blocks | max ops/block | ops/s |
|---|---|---:|---:|---:|---:|---:|---:|
| merged contract calls | 150 calls in ONE tx | 150 | 150 | 23.0 | 1 | 150 | 6.51 |
