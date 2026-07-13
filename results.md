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
