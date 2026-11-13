# polymarket-nvidia-forecast v2

Entry for make.fun's `polymarket-nvidia-ceo-forecast-01`: forecast the Yes
price of every trading market of Polymarket's "Next CEO of NVIDIA?" event at
every minute of the 4 hours after a checkpoint, as five quantiles
(5%, 25%, 50%, 75%, 95%), for the lowest mean pinball loss.

## The forecaster

`main.ts` (Node 22, standard library only, no network, deterministic) reads
every `<id>.in` in the input directory and writes `<id>.out` per case.

For each market it forecasts from the empirical distribution of that
market's own past price moves, with an adjusted median:

- **Median = last price + drift.** A prediction-market price is a
  martingale, but its jumps are asymmetric: a sharp move UP over the last
  hour gives most of itself back over the next few hours (a bounce), while
  a sharp move DOWN tends to continue. So the median pulls back a fraction
  (0.5) of a recent 60-minute up-jump and adds nothing for a down-jump,
  with the pull growing in slowly over the horizon (time constant 90 min).
- **Spread = recency-weighted empirical quantiles of h-step changes.**
  For anchor horizons 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 240
  minutes it measures the quantiles of the market's own h-step price
  changes, weighting recent changes most (weights halve every 60 minutes —
  this market's regime changes within hours), interpolates in log(h), and
  recenters so the median change is 0.
- **Long horizons widen a little faster than a random walk:** the spread is
  scaled by (h/240)^0.25.
- **Tails shrunk toward a normal shape** with the same interquartile range
  (shrink 0.4): the raw empirical tails are noisy from a short recency
  window, and the normal shape calibrates better.
- Markets with fewer than 10 prices fall back to the house baseline's shape
  (persistence, sigma 0.0025, normal quantiles).

Why this beats the first entry: the first entry's median was the last
price, which is wrong for hours after a jump, and its tails were noisy.
The bounce/continuation drift and the tail shrink were each verified on a
local backtest, and the combination was chosen on 14 windows, not on the
6 official practice windows alone.

## Backtest (mean pinball loss, percentage points)

Backtested on 4-hour windows cut from the event's real history, scoring
exactly like the official scorer. The harness reproduces the house
baseline's published practice loss exactly (0.363589 on the 6 official
windows) and the first entry's 0.305233, so the comparisons are on the
same footing.

| Windows | House baseline | First entry | This entry (v2) |
|---|---|---|---|
| 6 official practice (p00–p05) | 0.363589 | 0.305233 | **0.285507** |
| 14 windows (2h offsets, to 08:00 11-13) | 0.344835 | 0.258608 | **0.244168** |
| 3 most recent windows | — | 0.092338 | **0.085341** |

The entry wins on 11 of the 14 windows against the first entry. Note the
rules' warning: a practice score is no guide to the final — the parameters
were chosen for robustness across all 14 windows (including the most
recent ones), not fitted to the 6 official windows.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Runs in ~0.4 s per case (limit: 8 s), deterministic (two runs write
identical bytes), outputs ≤ ~241 KB per case (limit: 1 MiB).
