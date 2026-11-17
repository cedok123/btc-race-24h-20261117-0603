// BTC 1-minute trading bot for make.fun btc-race-24h-20261117-0603.
//
// Strategy (long only, one position, full-size entries, all integer math):
//   Every bar is a 1-minute close of cbBTC/USDC from its Orca Whirlpool. The
//   bot watches three independent entry signals, checked in this priority
//   order:
//
//   1. WASHOUT (d30): the 30-minute return is below -90 bps -- a sharp
//      washout. Exit at +150 bps over the entry close, at -200 bps (stop),
//      or after 240 bars, whichever comes first.
//   2. IGNITION (mom): the 2-minute return is above +40 bps -- a sharp upward
//      jump (1-minute returns show positive lag-1 autocorrelation on the dev
//      window). Exit at +150 bps, on a 150 bps trailing drawdown from the
//      peak close, or after 120 bars.
//   3. RANGE LOW (range): the close is within 40 bps of the trailing
//      360-minute low, before bar 1000 only. Exit at +150 bps, on a 250 bps
//      trailing drawdown, or after 720 bars.
//
//   Safety: no entries while the 240-minute return is below -200 bps (deep
//   downtrend), and no entries in the last 60 bars of the window (the harness
//   flattens everything at the last close anyway, so a late entry would only
//   pay entry costs for no time to move). After an exit that lost money, no
//   new entry for 120 bars, so a falling market cannot be bought into trade
//   after trade.
//
//   Costs: a full-size round trip pays ~34 bps on the dev window's pool depth
//   (4 bps fee + 2 bps slippage each way, plus ~11 bps of price impact each
//   way), so every signal demands a move far larger than that. Orders carry
//   max_slippage_bps 100 (1%) against the latest close.
//
//   Deterministic: pure BigInt arithmetic on the closes seen so far, no clock,
//   no network, no randomness, no files outside the repository.
//
//   This is a port of the Python v1 (same signals, same constants, same
//   integer math) to TypeScript, because the kit's local grader runs Node
//   bots on this machine while Python bots need Docker, which is absent.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;

// Entry signals (bps and bars; tuned on the frozen 24h dev window).
const D30_LOOK = 30;
const D30_THR_BPS = 90n;
const D30_TGT_BPS = 150n;
const D30_STOP_BPS = 200n;
const D30_HOLD_BARS = 240;

const MOM_LOOK = 2;
const MOM_THR_BPS = 40n;
const MOM_TGT_BPS = 150n;
const MOM_TRAIL_BPS = 150n;
const MOM_HOLD_BARS = 120;

const RANGE_N = 360;
const RANGE_BAND_BPS = 40n;
const RANGE_TGT_BPS = 150n;
const RANGE_TRAIL_BPS = 250n;
const RANGE_HOLD_BARS = 720;
const RANGE_LAST_BAR = 1000;

const LAST_ENTRY_BAR = 1380;
const DOWNTREND_LOOK = 240;
const DOWNTREND_CUT_BPS = -200n;
/** Bars to wait after an exit that lost money before entering again. */
const LOSS_COOLDOWN_BARS = 120;

/** Floor division for BigInt (b > 0): BigInt `/` truncates toward zero, this floors. */
function floordiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  const r = a % b;
  return r === 0n || a >= 0n ? q : q - 1n;
}

/** Return over `look` bars ending at index k, in bps, or null when k < look. */
function retBps(closes: bigint[], k: number, look: number): bigint | null {
  if (k < look) return null;
  const prev = closes[k - look]!;
  return floordiv((closes[k]! - prev) * 10000n, prev);
}

interface ExitPlan {
  targetBps: bigint;
  trailBps: bigint;
  stopBps: bigint;
  holdBars: number;
}

class Bot {
  private closes: bigint[] = [];
  // Entry state, set when a buy is decided, cleared when flat.
  private entryClose: bigint | null = null;
  private peakClose: bigint | null = null;
  private entryBar = 0;
  private plan: ExitPlan = { targetBps: 150n, trailBps: 150n, stopBps: 10000n, holdBars: 240 };
  /** First bar index at which a new entry is allowed (loss cooldown). */
  private coolUntil = -1;

  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // A fresh bar for our symbol this batch?
    let bar: Batch['bars'][number] | undefined;
    for (const b of batch.bars) {
      if (b.symbol === SYMBOL) {
        bar = b;
        break;
      }
    }
    if (bar === undefined) return [];
    if (state.warmingUp) return [];

    const close = BigInt(bar.c);
    this.closes.push(close);
    const closes = this.closes;
    const k = closes.length - 1;

    const holding = state.positions.get(SYMBOL);
    const qty = holding === undefined ? 0n : holding.qty;
    if (qty <= 0n) {
      // Flat: any stale entry state belongs to a rejected buy.
      this.entryClose = null;
      return this.maybeEnter(state, closes, k);
    }
    if (this.entryClose === null) {
      // Holding without entry state (should not happen): adopt the current
      // close as the entry and use conservative exits.
      this.entryClose = close;
      this.peakClose = close;
      this.entryBar = k;
      this.plan = { targetBps: 150n, trailBps: 150n, stopBps: 10000n, holdBars: 240 };
    }
    return this.maybeExit(closes, k, qty);
  }

  private maybeExit(closes: bigint[], k: number, qty: bigint): OrderInput[] {
    const close = closes[k]!;
    if (this.peakClose === null || close > this.peakClose) this.peakClose = close;
    const entry = this.entryClose!;
    const gainBps = floordiv((close - entry) * 10000n, entry);
    const ddBps = floordiv((this.peakClose! - close) * 10000n, this.peakClose!);
    if (
      gainBps >= this.plan.targetBps ||
      gainBps <= -this.plan.stopBps ||
      ddBps >= this.plan.trailBps ||
      k - this.entryBar >= this.plan.holdBars
    ) {
      if (gainBps < 0n) this.coolUntil = k + LOSS_COOLDOWN_BARS;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  private maybeEnter(state: BarsState, closes: bigint[], k: number): OrderInput[] {
    if (k >= LAST_ENTRY_BAR) return [];
    if (k < this.coolUntil) return [];
    const close = closes[k]!;
    let downtrend = false;
    const r240 = retBps(closes, k, DOWNTREND_LOOK);
    if (r240 !== null && r240 < DOWNTREND_CUT_BPS) downtrend = true;

    let plan: ExitPlan | null = null;
    if (!downtrend) {
      const r30 = retBps(closes, k, D30_LOOK);
      if (r30 !== null && r30 < -D30_THR_BPS) {
        plan = { targetBps: D30_TGT_BPS, trailBps: 10000n, stopBps: D30_STOP_BPS, holdBars: D30_HOLD_BARS };
      } else {
        const r2 = retBps(closes, k, MOM_LOOK);
        if (r2 !== null && r2 > MOM_THR_BPS) {
          plan = { targetBps: MOM_TGT_BPS, trailBps: MOM_TRAIL_BPS, stopBps: 10000n, holdBars: MOM_HOLD_BARS };
        } else if (k >= RANGE_N && k < RANGE_LAST_BAR) {
          let low = closes[k - RANGE_N]!;
          for (let i = k - RANGE_N + 1; i < k; i++) {
            if (closes[i]! < low) low = closes[i]!;
          }
          if (close * 10000n <= low * (10000n + RANGE_BAND_BPS)) {
            plan = { targetBps: RANGE_TGT_BPS, trailBps: RANGE_TRAIL_BPS, stopBps: 10000n, holdBars: RANGE_HOLD_BARS };
          }
        }
      }
    }
    if (plan === null) return [];

    const notional = state.cash;
    if (notional < 1_000_000n) return [];
    this.entryClose = close;
    this.peakClose = close;
    this.entryBar = k;
    this.plan = plan;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
}

await runBars(new Bot());
