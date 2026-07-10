# fast-tx benchmark results

Run: 2026-07-10T22:31:41.970Z  ·  API: http://127.0.0.1:3300  ·  waves: 1, 5, 20, 50, 100

## mode: external

An EXTERNAL wallet creates a NIGHT transfer with `{ payFees: false }`; the benchmark wallet
only balances the missing dust/gas, finalizes, submits, and waits for on-chain inclusion.

| requests | ok | failed | wall time (s) | avg latency (s) | p50 (s) | max (s) | throughput (tx/s) | counter after |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 0 | 102.1 | 102.1 | 102.1 | 102.1 | 0.01 | 0 |
| 5 | 5 | 0 | 120.0 | 96.0 | 90.0 | 120.0 | 0.04 | 0 |
| 20 | 20 | 0 | 269.9 | 157.5 | 120.0 | 269.9 | 0.07 | 0 |
| 50 | 50 | 0 | 630.0 | 365.0 | 360.0 | 630.0 | 0.08 | 0 |
| 100 | 38 | 62 | 540.0 | 377.0 | 394.4 | 540.0 | 0.07 | 0 |
