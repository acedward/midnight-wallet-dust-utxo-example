
## Merged contract calls (one transaction, N `incrementBy` intents)

Run: 2026-07-13T19:23:17.890Z

| calls merged into one tx | result | counter Δ | prove+balance (s) |
|---:|---|---:|---:|
| 2 | ok | +2 | 0.5 |
| 20 | ok | +20 | 0.7 |
| 45 | ok | +45 | 0.9 |
| 90 | ok | +90 | 1.6 |
| 150 | ok | +150 | 2.5 |
| 200 | ✗ prove/balance: exceeded block limit in transaction fee computation | — | — |
