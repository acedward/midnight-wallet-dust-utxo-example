# fast-tx benchmark results

Run: 2026-07-10T23:24:48.432Z  ·  API: http://127.0.0.1:3300  ·  waves: 1, 5, 20, 50, 100

## mode: self

The benchmark wallet creates the ENTIRE transaction — one `incrementBy(1)` contract call:
build → prove (proof server) → balance fees (dust) → submit → finalized on-chain.

| requests | ok | failed | wall time (s) | avg latency (s) | p50 (s) | max (s) | throughput (tx/s) | counter after |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 0 | 21.5 | 21.5 | 21.5 | 21.5 | 0.05 | 1 |
| 5 | 5 | 0 | 17.4 | 17.4 | 17.4 | 17.4 | 0.29 | 6 |
| 20 | 20 | 0 | 35.5 | 24.8 | 24.1 | 35.5 | 0.56 | 26 |
| 50 | 50 | 0 | 72.5 | 42.7 | 43.1 | 72.5 | 0.69 | 76 |
| 100 | 100 | 0 | 125.6 | 70.9 | 71.8 | 125.6 | 0.80 | 176 |

## mode: external

An EXTERNAL wallet creates a NIGHT transfer with `{ payFees: false }`; the benchmark wallet
only balances the missing dust/gas, finalizes, submits, and waits for on-chain inclusion.

| requests | ok | failed | wall time (s) | avg latency (s) | p50 (s) | max (s) | throughput (tx/s) | counter after |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 0 | 19.2 | 19.2 | 19.2 | 19.2 | 0.05 | 176 |
| 5 | 5 | 0 | 17.4 | 16.6 | 16.4 | 17.4 | 0.29 | 176 |
| 20 | 20 | 0 | 35.3 | 24.2 | 23.0 | 35.3 | 0.57 | 176 |
| 50 | 50 | 0 | 72.1 | 42.8 | 43.4 | 72.1 | 0.69 | 176 |
| 100 | 100 | 0 | 1960.6 | 956.3 | 995.9 | 1960.6 | 0.05 | 176 |

## Appendix: how the two modes converged

External mode originally had the benchmark wallet prove the ENTIRE unproven external tx
(`balanceUnprovenTransaction` on an unproven transfer) — that skewed it heavily. With the
intended split — the **creator proves** its fee-less tx (`payFees: false` →
`finalizeRecipe` on the external side), and the benchmark wallet only
**`balanceFinalizedTransaction`** (one small dust-spend proof) + submit — the modes are
symmetric, exactly as expected:

| wave | self | external (creator-proves) |
|---:|---:|---:|
| 5 | 17.4s | 17.4s |
| 20 | 35.5s | 35.3s |
| 50 | 72.5s | 72.1s |
| 100 | 125.6s | 1960.6s* |

\* external wave 100 ran LAST (252 fees already paid this session): the wallet's
accumulated dust buffer was drained, so the wave proceeded at the **dust generation
rate** (∝ NIGHT held, 65.6e12 atoms here) — 100/100 still succeeded, just fee-budget
limited. Burst capacity = accrued dust + ~21 dust coins; sustained capacity = dust
generation rate.

Other findings that hold:
- The external wallet's UTXO pool size is irrelevant to this flow's throughput
  (20 vs 100 identical) — a fee-less transfer proof is nearly free (no circuits, no dust
  spend), so the creator side is never the bottleneck.
- Keep benchmark/balancer wallets clean: routing transfer outputs TO the balancer
  litters it with micro NIGHT UTXOs whose near-worthless auto-generated dust coins
  degrade coin selection ("could not balance dust"). Use a sink address.
