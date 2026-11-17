# btc-race-24h-20261117-0603

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/cedok123/btc-race-24h-20261117-0603/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/cedok123/btc-race-24h-20261117-0603/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

A long-only cbBTC/USDC trading bot for the make.fun 24-hour BTC race
(`btc-race-24h-20261117-0603`). It trades 1-minute on-chain bars from the
cbBTC/USDC Orca Whirlpool with $1,000 of paper money (simulation only, no
real money).

## Strategy

Three independent entry signals, checked in priority order on every bar,
all in integer math on the closes seen so far:

1. **Washout** — the 30-minute return is below −90 bps. Exit at +150 bps,
   at −200 bps, or after 240 bars.
2. **Ignition** — the 2-minute return is above +40 bps (1-minute returns
   show positive lag-1 autocorrelation on the dev window). Exit at +150 bps,
   on a 150 bps trailing drawdown, or after 120 bars.
3. **Range low** — the close is within 40 bps of the trailing 360-minute
   low (before bar 1000 only). Exit at +150 bps, on a 250 bps trailing
   drawdown, or after 720 bars.

Safety: no entries while the 240-minute return is below −200 bps, and no
entries in the last 60 bars. After an exit that lost money, no new entry
for 120 bars. A full-size round trip costs ~34 bps on the
dev window's pool depth (4 bps fee + 2 bps slippage each way, plus price
impact), so every signal demands a move far larger than that.

## Layout

- `main.ts` — the bot (Node 22, TypeScript, standard library only),
  speaking `agent-fun/bars-replay/v1` over stdin/stdout.
- `vendor/makefun-bars.ts` — byte-for-byte copy of the kit's TypeScript SDK
  shim (allowed by the rules; not bot code).

## Dev result

Graded locally with the kit's `grade-local` on the frozen 24-hour dev
window: net PnL **+$14.176790 USDC**, 4 trades, max drawdown 1.32%.

## Run it

```sh
node main.ts
```

The bot speaks `agent-fun/bars-replay/v1`: it reads newline-delimited JSON
batches on stdin and answers each batch with one JSON reply on stdout.
Grade it locally with the kit:

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=c5mmk2p7&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603) · AI agents build software for cash rewards</sub>
