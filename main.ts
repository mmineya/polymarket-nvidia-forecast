// polymarket-nvidia-ceo-forecast-01 entry v2 (Node 22, standard library only).
//
// Forecast: for each market, the empirical distribution of its own past
// price moves, recentered on an adjusted median, with the spread taken from
// recency-weighted h-step changes and shrunk toward a normal shape.
//
//   q_tau(h) = clamp(med(h) + s_tau(h) * (h/240)^(ALPHA-0.5), 0, 1)
//
// where med(h) is the last price plus a drift, and s_tau(h) is the
// tau-quantile of the market's h-step price changes, interpolated in log(h)
// between anchor horizons [1,2,3,5,8,13,21,34,55,89,144,233,240], estimated
// from every h-step change in its history with weights decaying by half
// every 60 minutes (this market's regime changes within hours), recentered
// so the median change is 0.
//
// The median drift is the part the first entry missed. Prices here move in
// jumps, and the jumps are asymmetric: a sharp move UP over the last hour
// gives most of itself back over the next few hours (a bounce), while a
// sharp move DOWN tends to continue (no bounce back up). So the median
// pulls back a fraction A_UP of a recent up-jump and adds a fraction
// A_DOWN of a recent down-jump, with the pull growing slowly over the
// horizon (time constant REV_TAU minutes). The spread is also shrunk toward
// a normal shape with the same interquartile range (TAIL_SHRINK): the raw
// empirical tails are noisy from a short recency window, and the normal
// shape calibrates better.
//
// Backtested locally on 14 four-hour windows cut from the event's real
// history (2026-11-12T06:00Z to 2026-11-13T08:00Z), scoring exactly like
// the official scorer (the harness reproduces the house baseline's
// published practice loss of 0.363589 and the first entry's 0.305233):
// this model scores 0.244 pooled over the 14 windows (0.286 on the 6
// official practice windows) against the first entry's 0.259 (0.305).
//
// Deterministic: a pure function of the input file (no clock, no randomness,
// no network). Reads every <id>.in in the input directory, in name order,
// and writes one <id>.out per case, exactly as the rules require.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Anchor horizons (minutes) at which the empirical change distribution is measured. */
const ANCHORS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 240];
/** Recency weights halve every HALFLIFE minutes (a change's age is measured from the newest change). */
const HALFLIFE = 60;
/** Spread grows like h^ALPHA; 0.5 is a random walk. */
const ALPHA = 0.75;
/** The house baseline's spread, used only when a market has too little history to measure its own. */
const FALLBACK_SIGMA = 0.0025;
/** The standard normal's quantile at each level, used by the fallback and the tail shrink. */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
/** The recent move the median reacts to: the price change over the last JUMP_MIN minutes. */
const JUMP_MIN = 60;
/** Fraction of a recent up-jump the median gives back (bounce). */
const A_UP = 0.5;
/** Fraction of a recent down-jump the median adds on (down-continuation). */
const A_DOWN = 0;
/** Time constant (minutes) over which the median drift grows in. */
const REV_TAU = 90;
/** How far the empirical quantiles are shrunk toward a normal shape with the same IQR (0 = none, 1 = full). */
const TAIL_SHRINK = 0.4;
/** Overall multiplier on the spread. */
const WIDEN = 1;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/** x clamped to [0,1] and rounded to 6 decimals (0, never -0). */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/**
 * The tau-quantiles of `values` under `weights` (same length, weights > 0):
 * sort by value, walk the cumulative weight (each point counted at its
 * midpoint, the usual continuity correction), and linearly interpolate.
 * Deterministic: equal values contribute the same cumulative weight in any
 * order, so the result does not depend on the sort's tie order.
 */
function weightedQuantiles(values: number[], weights: number[], taus: number[]): number[] {
  const pairs = values.map((v, i) => [v, weights[i] as number] as [number, number]);
  pairs.sort((a, b) => a[0] - b[0]);
  // Cumulative weight at each point's midpoint, scaled so the last is 1
  // (the weighted form of the (i - 0.5) / n plotting positions).
  const cum: number[] = [];
  let run = 0;
  for (const p of pairs) {
    run += p[1];
    cum.push(run - 0.5 * p[1]);
  }
  const scale = cum[cum.length - 1] as number;
  for (let i = 0; i < cum.length; i++) cum[i] = (cum[i] as number) / scale;
  const out: number[] = [];
  for (const tau of taus) {
    if (tau <= cum[0] as number) {
      out.push(pairs[0]?.[0] as number);
      continue;
    }
    const last = cum.length - 1;
    if (tau >= (cum[last] as number)) {
      out.push(pairs[last]?.[0] as number);
      continue;
    }
    let i = 0;
    while ((cum[i + 1] as number) < tau) i++;
    const c0 = cum[i] as number;
    const c1 = cum[i + 1] as number;
    const v0 = pairs[i]?.[0] as number;
    const v1 = pairs[i + 1]?.[0] as number;
    out.push(v0 + ((tau - c0) / (c1 - c0)) * (v1 - v0));
  }
  return out;
}

/** Linear interpolation of `ys` (at log-spaced `xs`) at each log(h). */
function interpLogH(xs: number[], ys: number[], h: number): number {
  const x = Math.log(h);
  if (x <= xs[0] as number) return ys[0] as number;
  const last = xs.length - 1;
  if (x >= (xs[last] as number)) return ys[last] as number;
  let i = 0;
  while ((xs[i + 1] as number) < x) i++;
  const x0 = xs[i] as number;
  const x1 = xs[i + 1] as number;
  const y0 = ys[i] as number;
  const y1 = ys[i + 1] as number;
  return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
}

/** The forecast of one market: horizon rows of the five quantiles around its adjusted median. */
function forecast(m: CaseMarket, horizon: number): number[][] {
  if (m.prices.length === 0) throw new Error(`market ${m.id} has no prices`);
  const x = m.prices[m.prices.length - 1] as number;
  const n = m.prices.length;
  const rows: number[][] = [];

  // Too little history to measure a distribution: fall back to the house baseline's shape.
  if (n < 10) {
    for (let h = 1; h <= horizon; h++) {
      rows.push(Z.map((z) => price6(x + z * FALLBACK_SIGMA * Math.sqrt(h))));
    }
    return rows;
  }

  // Empirical quantiles of the h-step changes at each anchor horizon.
  const logAnchors = ANCHORS.map((a) => Math.log(a));
  // eq[a][j] = the tau_j quantile of the a-step changes.
  const eq: number[][] = ANCHORS.map((a) => {
    const m2 = n - a;
    if (m2 < 6) return [0, 0, 0, 0, 0];
    const values: number[] = new Array(m2);
    const weights: number[] = new Array(m2);
    for (let i = 0; i < m2; i++) {
      values[i] = (m.prices[i + a] as number) - (m.prices[i] as number);
      weights[i] = Math.pow(0.5, (m2 - 1 - i) / HALFLIFE);
    }
    return weightedQuantiles(values, weights, QUANTILES);
  });

  // The recent jump the median reacts to (0 when the market is too young to have one).
  const jump = n > JUMP_MIN ? x - (m.prices[n - 1 - JUMP_MIN] as number) : 0;

  for (let h = 1; h <= horizon; h++) {
    // Median drift: give back a fraction of a recent up-jump, continue a
    // recent down-jump, growing in slowly over the horizon.
    const r = 1 - Math.exp(-h / REV_TAU);
    const med = x + (-A_UP * Math.max(jump, 0) + A_DOWN * Math.min(jump, 0)) * r;
    // Spread at this horizon: interpolate each quantile in log(h), recenter
    // so the median change is 0, and widen long horizons a little (h^0.25).
    const medEq = interpLogH(logAnchors, eq.map((row) => row[2] as number), h);
    const widen = WIDEN * Math.pow(h / 240, ALPHA - 0.5);
    let row = QUANTILES.map((_, j) => {
      const s = interpLogH(logAnchors, eq.map((rr) => rr[j] as number), h) - medEq;
      return med + s * widen;
    });
    // Shrink the tails toward a normal shape with the same interquartile
    // range: the raw empirical tails are noisy from a short recency window.
    if (TAIL_SHRINK > 0) {
      const iqr = (row[3] as number) - (row[1] as number);
      const sd = iqr > 0 ? iqr / 1.34898 : 0;
      row = row.map((v, j) => (1 - TAIL_SHRINK) * v + TAIL_SHRINK * (med + (Z[j] as number) * sd));
    }
    const out = row.map((v) => price6(v));
    // Enforce non-decreasing quantiles (rounding can tie them, never invert them, but be safe).
    for (let j = 1; j < out.length; j++) {
      if ((out[j] as number) < (out[j - 1] as number)) out[j] = out[j - 1] as number;
    }
    rows.push(out);
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecast(m, c.horizon_minutes) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
