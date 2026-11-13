# polymarket-nvidia-forecast

Entry for make.fun's `polymarket-nvidia-ceo-forecast-01`: forecast the Yes
price of every trading market of Polymarket's "Next CEO of NVIDIA?" event at
every minute of the 4 hours after a checkpoint, as five quantiles
(5%, 25%, 50%, 75%, 95%), for the lowest mean pinball loss.

## The forecaster

`main.ts` (Node 22, standard library only, no network, deterministic) reads
every `<id>.in` in the input directory and writes `<id>.out` per case.

For each market it forecasts from the empirical distribution of that
market's own past price moves:

- **Median = last price.** A prediction-market price is a martingale: its
  best point forecast is where it is now. Adding the empirical median, a
  drift, or a cross-market sum-to-1 adjustment all made backtests worse.
- **Spread = recency-weighted empirical quantiles of h-step changes.**
  For anchor horizons 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 240
  minutes it measures the quantiles of the market's own h-step price
  changes, weighting recent changes most (weights halve every 180 minutes —
  this market's regime changes within hours), interpolates in log(h), and
  recenters so the median change is 0.
- **Long horizons widen a little faster than a random walk:** the spread is
  scaled by (h/240)^0.25.
- Markets with fewer than 10 prices fall back to the house baseline's shape
  (persistence, sigma 0.0025, normal quantiles).

Why this beats the house persistence baseline: the baseline's spread
(sigma 0.0025, normal quantiles) is far too narrow and too symmetric for
the real move distribution — 1-minute changes have a standard deviation of
0.002–0.043 per market, mostly zeros with occasional jumps of 0.4+ — and
the empirical quantiles capture the fat tails and the asymmetry (a market
at 0.003 can jump up 0.48 but can only fall 0.003).

## Backtest (mean pinball loss, percentage points)

Backtested on 4-hour windows cut from the event's real history
(2026-11-12T06:00Z to 2026-11-13T06:00Z), scoring exactly like the
official scorer. The harness reproduces the house baseline's published
practice loss exactly (0.363589 on the 6 official windows), so the
comparisons are on the same footing.

| Windows | House baseline | This entry | Improvement |
|---|---|---|---|
| 6 official practice (p00–p05) | 0.363589 | **0.305233** | −16.1% |
| 7 windows (incl. extra 06:00 11-13) | 0.341044 | **0.270** | −20.8% |
| 13 windows (incl. 2-hour offsets) | 0.356050 | **0.276** | −22.5% |

The 6-window figure is the shipped `main.ts` itself, scored on the
practice cases. The 7- and 13-window figures are the same model in the
Python reference harness (alpha 0.70; the shipped program uses 0.75 and
its outputs match the reference to <0.001). The entry wins on 12 of the
13 windows; the one it loses is the 18:00 11-12 window (0.376 vs 0.369,
−2%).

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Runs in ~0.15 s per case (limit: 8 s), deterministic (two runs write
identical bytes), outputs ≤ ~241 KB per case (limit: 1 MiB).
