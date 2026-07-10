# fast-tx benchmark results

Run: 2026-07-10T17:15:30.154Z  ·  API: http://127.0.0.1:3300  ·  waves: 1, 5, 20, 50, 100

## mode: self

The benchmark wallet creates the ENTIRE transaction — one `incrementBy(1)` contract call:
build → prove (proof server) → balance fees (dust) → submit → finalized on-chain.

| requests | ok | failed | wall time (s) | avg latency (s) | p50 (s) | max (s) | throughput (tx/s) | counter after |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 0 | 22.7 | 22.7 | 22.7 | 22.7 | 0.04 | 61 |
| 5 | 5 | 0 | 24.5 | 24.5 | 24.5 | 24.5 | 0.20 | 66 |
| 20 | 20 | 0 | 47.3 | 31.3 | 28.9 | 47.3 | 0.42 | 86 |
| 50 | 50 | 0 | 96.8 | 53.4 | 53.4 | 96.8 | 0.52 | 136 |
| 100 | 100 | 0 | 167.6 | 91.2 | 95.6 | 167.6 | 0.60 | 236 |

## mode: external

An EXTERNAL wallet creates a NIGHT transfer with `{ payFees: false }`; the benchmark wallet
only balances the missing dust/gas, finalizes, submits, and waits for on-chain inclusion.

| requests | ok | failed | wall time (s) | avg latency (s) | p50 (s) | max (s) | throughput (tx/s) | counter after |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 0 | 51.6 | 51.6 | 51.6 | 51.6 | 0.02 | 236 |
| 5 | 5 | 0 | 30.0 | 30.0 | 30.0 | 30.0 | 0.17 | 236 |
| 20 | 20 | 0 | 60.0 | 46.5 | 60.0 | 60.0 | 0.33 | 236 |
| 50 | 50 | 0 | 240.0 | 127.2 | 120.0 | 240.0 | 0.21 | 236 |
| 100 | 100 | 0 | 660.0 | 341.7 | 360.0 | 660.0 | 0.15 | 236 |
