// Pump.fun Bot Sprint — delayed-momentum scalp bot.
//
// Strategy, written from scratch for the agent-fun/replay/v2 harness:
//   * Watch every new bonding curve from its CreateEvent, but do NOT buy the
//     first pump: most new coins spike and dump within seconds as snipers exit.
//   * Buy only a curve that is still alive and rising minutes after creation:
//     aged 600-3600 slots, buy SOL volume still beating sell volume, price up
//     at least +5% from its price at 600 slots old and no more than +50% above
//     its creation price. One buy per coin, 0.05 SOL.
//   * Exit every position on one of four rules: +50% take-profit, -15% stop-loss,
//     a trailing stop once a winner ran +30% (sell on a -12% pullback from the
//     peak), or a 1800-slot (~7 minute) time stop. Sell the whole position each time.
//   * At most 5 open positions.
// Everything is decided from the harness state and the batch in front of us:
// no clock, no environment, no randomness, so the two grading runs agree.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type SellInput,
} from "./vendor/makefun-bot.ts";

// ---------------------------------------------------------------- tuning

/** SOL risked on each new coin. */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL
/** A buy only counts toward the guardrail when it is at least this big. */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL
/** Youngest age (slots) at which a curve becomes buyable: skip the snipe pump. */
const MIN_AGE_SLOTS = 600;
/** Oldest age (slots) at which a curve is still buyable. */
const MAX_AGE_SLOTS = 3600;
/** Minimum trades seen on a curve before we trust its flow signal. */
const MIN_TRADES = 10;
/** Buy SOL volume must beat sell SOL volume by at least this factor (x100). */
const BUY_DOMINANCE_X100 = 150n; // buyVol * 100 >= sellVol * 150
/** Price must be at least this far above its price at MIN_AGE_SLOTS (basis points). */
const MIN_UP_BPS = 800n; // +8% since the reference price: only real continuation
/** Never buy a curve that already ran this far above its creation price. */
const MAX_UP_BPS = 4000n; // +40%: do not chase the top
/** Take profit, stop loss, trailing stop, and time stop, in basis points / slots. */
const TAKE_PROFIT_BPS = 3500n; // +35%: bank winners sooner
const STOP_LOSS_BPS = -1200n; // -12%: cut losers fast
const TRAIL_ARM_BPS = 2500n; // +25%: once this high, trail the peak
const TRAIL_DROP_BPS = 1000n; // -10% from the peak after arming
const MAX_HOLD_SLOTS = 3600;
/** Slippage allowance on fills. */
const SLIPPAGE_BPS = 1000;
/** Price is kept as lamports-per-token scaled by this factor. */
const PRICE_SCALE = 1_000_000_000n;

// ---------------------------------------------------------------- per-coin book

interface CoinBook {
  createdSlot: number;
  /** Price at creation, scaled by PRICE_SCALE. */
  createPrice: bigint;
  /** Price first seen once the curve reached MIN_AGE_SLOTS, scaled; null until then. */
  refPrice: bigint | null;
  buyVol: bigint;
  sellVol: bigint;
  trades: number;
  decided: boolean;
}

interface HeldBook {
  /** Entry price, scaled by PRICE_SCALE, from the buy fill itself. */
  entryPrice: bigint;
  entrySlot: number;
  /** Highest mark price seen since entry, scaled by PRICE_SCALE. */
  peakPrice: bigint;
}

const coins = new Map<string, CoinBook>();
const held = new Map<string, HeldBook>();

/** Mark price of a mint from its latest virtual reserves, scaled by PRICE_SCALE. */
function markPrice(state: BotState, mint: string): bigint | null {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.complete) return null;
  if (curve.virtual_token_reserves <= 0n) return null;
  return (curve.virtual_quote_reserves * PRICE_SCALE) / curve.virtual_token_reserves;
}

/** Fold this batch's events into the per-coin flow books. */
function noteEvents(state: BotState, batch: Batch): void {
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      const price =
        e.virtual_token_reserves > 0n
          ? (BigInt(e.virtual_quote_reserves) * PRICE_SCALE) / BigInt(e.virtual_token_reserves)
          : 0n;
      coins.set(e.mint, {
        createdSlot: e.slot,
        createPrice: price,
        refPrice: null,
        buyVol: 0n,
        sellVol: 0n,
        trades: 0,
        decided: false,
      });
    } else if (e.event === "TradeEvent") {
      let book = coins.get(e.mint);
      if (book === undefined) {
        // First sight through a trade: anchor the price at this trade's reserves.
        const price =
          BigInt(e.virtual_token_reserves) > 0n
            ? (BigInt(e.virtual_quote_reserves) * PRICE_SCALE) / BigInt(e.virtual_token_reserves)
            : 0n;
        book = {
          createdSlot: e.slot,
          createPrice: price,
          refPrice: null,
          buyVol: 0n,
          sellVol: 0n,
          trades: 0,
          decided: false,
        };
        coins.set(e.mint, book);
      }
      const sol = BigInt(e.sol_amount);
      if (e.is_buy) book.buyVol += sol;
      else book.sellVol += sol;
      book.trades += 1;
      // Capture the reference price the first time the curve is old enough.
      if (book.refPrice === null && state.slot - book.createdSlot >= MIN_AGE_SLOTS) {
        const now = markPrice(state, e.mint);
        if (now !== null && now > 0n) book.refPrice = now;
      }
    } else {
      // CompleteEvent: the curve is done; drop its book.
      coins.delete(e.mint);
    }
  }
}

/** Record entry prices from this batch's buy fills. */
function noteFills(state: BotState, batch: Batch): void {
  for (const f of batch.fills) {
    if (f.side === "buy" && f.status === "filled") {
      const spent = BigInt(f.quote_lamports);
      const tokens = BigInt(f.token_amount);
      if (spent > 0n && tokens > 0n) {
        const entryPrice = (spent * PRICE_SCALE) / tokens;
        held.set(f.mint, {
          entryPrice,
          entrySlot: f.slot,
          peakPrice: entryPrice,
        });
      }
    }
  }
  // Forget entry books for positions that are gone.
  for (const mint of [...held.keys()]) {
    if (!state.positions.has(mint)) held.delete(mint);
  }
}

/** True when a sell for this mint is already in flight. */
function sellPending(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === "sell" && p.order.mint === mint) return true;
  }
  return false;
}

/** Drop stale candidate books so the map stays small over a long replay. */
function prune(state: BotState): void {
  for (const [mint, book] of coins) {
    if (book.decided || state.slot - book.createdSlot > MAX_AGE_SLOTS) {
      coins.delete(mint);
    }
  }
}

// ---------------------------------------------------------------- the bot

await runBot({
  onBatch(state, batch) {
    noteEvents(state, batch);
    noteFills(state, batch);

    const orders: Array<BuyInput | SellInput> = [];
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // --- exits first: take profit, stop loss, trailing stop, time stop ---
    const selling = new Set<string>();
    for (const [mint, pos] of state.positions) {
      if (sellPending(state, mint)) continue;
      const book = held.get(mint);
      const price = markPrice(state, mint);
      if (book === undefined || price === null || price <= 0n) continue;
      if (price > book.peakPrice) book.peakPrice = price;
      const pnlBps = ((price - book.entryPrice) * 10_000n) / book.entryPrice;
      const peakBps = ((book.peakPrice - book.entryPrice) * 10_000n) / book.entryPrice;
      const trailed =
        peakBps >= TRAIL_ARM_BPS &&
        ((book.peakPrice - price) * 10_000n) / book.peakPrice >= TRAIL_DROP_BPS;
      const aged = state.slot - book.entrySlot >= MAX_HOLD_SLOTS;
      if (pnlBps >= TAKE_PROFIT_BPS || pnlBps <= STOP_LOSS_BPS || trailed || aged) {
        orders.push({
          side: "sell",
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        });
        selling.add(mint);
      }
    }

    // --- entries: old enough to have survived the snipe pump, still rising ---
    for (const [mint, book] of coins) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (book.decided) continue;
      if (state.positions.has(mint) || selling.has(mint)) continue;
      const age = state.slot - book.createdSlot;
      if (age < MIN_AGE_SLOTS || age > MAX_AGE_SLOTS) continue;
      if (book.trades < MIN_TRADES) continue;
      if (book.buyVol * 100n < book.sellVol * BUY_DOMINANCE_X100) continue;
      if (book.refPrice === null || book.refPrice <= 0n) continue;
      const price = markPrice(state, mint);
      if (price === null || price <= 0n || book.createPrice <= 0n) continue;
      // Rising since the reference price, and not already mooned from creation.
      const upSinceRef = ((price - book.refPrice) * 10_000n) / book.refPrice;
      const upSinceCreate = ((price - book.createPrice) * 10_000n) / book.createPrice;
      if (upSinceRef < MIN_UP_BPS || upSinceCreate > MAX_UP_BPS) continue;

      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (slots <= 0 || free < amount + tx) continue;

      orders.push({
        side: "buy",
        mint,
        quote_lamports: amount,
        max_slippage_bps: SLIPPAGE_BPS,
      });
      book.decided = true;
      free -= amount + tx;
      slots -= 1;
    }

    prune(state);
    return orders;
  },
});
