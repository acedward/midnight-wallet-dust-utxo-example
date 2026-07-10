# fast-tx benchmark results

Run: 2026-07-10T18:58:29.237Z  ·  API: http://127.0.0.1:3300  ·  waves: 1, 5, 20, 50, 100

## mode: external

An EXTERNAL wallet creates a NIGHT transfer with `{ payFees: false }`; the benchmark wallet
only balances the missing dust/gas, finalizes, submits, and waits for on-chain inclusion.

| requests | ok | failed | wall time (s) | avg latency (s) | p50 (s) | max (s) | throughput (tx/s) | counter after |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 0 | 25.2 | 25.2 | 25.2 | 25.2 | 0.04 | 0 |
| 5 | 5 | 0 | 30.0 | 30.0 | 30.0 | 30.0 | 0.17 | 0 |
| 20 | 20 | 0 | 60.0 | 36.0 | 30.0 | 60.0 | 0.33 | 0 |
| 50 | 50 | 0 | 240.0 | 124.8 | 120.0 | 240.0 | 0.21 | 0 |
| 100 | 100 | 0 | 690.0 | 318.6 | 330.0 | 690.0 | 0.14 | 0 |

## Appendix: symmetry experiments (why external ≠ self)

Expectation tested: both modes should be thresholded alike (benchmark wallet: 20 dust
coins; external wallet: 20 NIGHT UTXOs).

| experiment | result |
|---|---|
| external wallet **100 UTXOs** (vs 20) | wave 100: 690s vs 660s — **identical** ⇒ UTXO pool is NOT the limiter |
| phase sampling during a 20-wave | all 16 lanes sit in the facade's dust-balance/prove step; completions quantized to **exact 30s ticks**, ~2 per tick |
| route heavy proof via midnight-js proof client | still quantized ⇒ not the proof transport |
| `feeBlocksMargin` 5 → 1 (30s = 5 × 6s blocks) | slower, quanta unchanged ⇒ not the fee margin |

Conclusion: the external-mode ceiling (~0.2 tx/s) sits inside the wallet facade's dust
balancing for transactions that carry **unshielded offers**. Self-mode contract calls
(no unshielded inputs/outputs, dust-only fees) go through the same wallet and scale
smoothly to 0.60 tx/s — so a single wallet's parallel capacity depends on the
*transaction shape*, not just its coin counts. Candidate wallet-sdk issue: concurrent
`balanceUnprovenTransaction`/`finalizeRecipe` over txs with unshielded offers
serializes in ~30s batches.
