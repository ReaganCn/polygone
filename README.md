# Polygone — Polymarket Straddle Bot

A TypeScript bot that monitors Polymarket crypto up/down markets for sudden price dumps, then enters a simultaneous YES + NO straddle position — guaranteeing a winner regardless of which side resolves, provided the sum of both leg prices is below 1.00 (minus fees).

---

## Strategy Overview

### Dump-and-Hedge (Straddle)

When a crypto up/down market experiences a sudden price collapse on one side (e.g. the YES token drops from 0.60 → 0.25 in under 3 seconds), the bot:

1. **Buys the dumped side (Leg 1)** at the depressed ask via FOK — locking in a cheap entry.
2. **Buys the opposite side (Leg 2)** at the prevailing ask. If `leg1Price + leg2Price ≤ sumTarget (default 0.92)`, the position is fully hedged and guaranteed profitable.

Since YES + NO always resolve to $1.00 total, buying both sides for < $1.00 locks in a risk-free spread — the winning leg pays $1.00 per share regardless of outcome.

### Entry Sequence (Sequential FOK, not simultaneous)

Leg 1 is placed first and must fill before Leg 2 is attempted. This prevents the dangerous "Promise.all" trap where Leg 2 fills but Leg 1 doesn't, leaving you directionally exposed on the expensive side.

1. Leg 1 FOK → if rejected, cancel (slot released, market untracked)
2. Recalculate Leg 2 limit: `sumTarget − leg1FillPrice`
3. If `leg1Price + currentOppositeAsk ≤ sumTarget` → try Leg 2 FOK → `entryMode: "both_fok"`
4. If Leg 2 FOK fails or sum too high → place Leg 2 GTC at the computed limit → `entryMode: "fok_then_gtc"`

### Fill Monitoring (Burst-then-Relax)

When Leg 2 is pending GTC:

```
immediately → wait 1s → wait 2s → jittered ~5s → jittered ~5s → ...
```

Each poll checks:
- **Leg 2 fill** — mark fully hedged and stop monitoring
- **DCA** — if dumped-side price drops another `DCA_THRESHOLD_PERCENT`% below the weighted average, buy more Leg 1 first, then cancel and replace Leg 2 at the new limit
- **Stop-loss** — if market closes in ≤ `STOP_LOSS_REMAINING_SECONDS`, force-buy Leg 2 at market (FOK at 0.99)

### DCA Order of Operations (Correct)

```
1. Buy more Leg 1 (FOK)   ← first, while still hedged
2. Cancel old Leg 2 GTC
3. Replace Leg 2 GTC at new limit (sumTarget − newWeightedAvg)
```

This order ensures the exposure window from an unhedged Leg 1 is minimised.

---

## Project Structure

```
polygone/
├── src/
│   ├── index.ts          # Entry point — bootstraps all modules
│   ├── config.ts         # All config (loaded from .env, hot-patchable)
│   ├── types.ts          # Shared domain types
│   ├── logger.ts         # Append-only JSON-line logger with log routing
│   ├── polymarket.ts     # Gamma API + CLOB client (market fetch, orders)
│   ├── websocket.ts      # Persistent WS connection to Polymarket CLOB
│   ├── scanner.ts        # Dump detection, price history, 4-callback API
│   ├── trader.ts         # Straddle entry, fill monitor, DCA, stop-loss
│   ├── shadow.ts         # Shadow mode: instant-fill simulated straddles
│   ├── slots.ts          # Compounding slot state machine
│   ├── redeemer.ts       # Auto-redeems winning positions → USDC
│   ├── redemptionQueue.ts# Sequential redemption queue with retry
│   ├── dailyState.ts     # Tracks daily P&L baseline for scheduler
│   ├── telegram.ts       # Telegram status alerts
│   └── api.ts            # Express control panel (localhost only)
├── data/
│   └── redemption-queue.json  # Persisted redemption queue (survives restarts)
├── logs/
│   └── activity.log      # Every event as a JSON line
├── env.example           # Template — copy to .env and fill in
├── package.json
├── tsconfig.json
└── README.md
```

---

## Prerequisites

- **Node.js 20+**
- A funded Polygon wallet with **USDC on Polymarket**
- Your wallet private key

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp env.example .env
```

Fill in at minimum:

```env
PRIVATE_KEY=0xyour_private_key_here
POLYMARKET_FUNDER_ADDRESS=0xyour_polymarket_profile_address_here
```

Everything else has sensible defaults. **Start in shadow mode** (`SHADOW_MODE=true`) to verify the bot works before spending real money.

### 3. Find your funder address

- **Browser wallet (MetaMask):** your funder address is shown on your Polymarket profile. Use `SIGNATURE_TYPE=0`.
- **Email/Magic login:** export your private key from https://reveal.magic.link/polymarket. Your funder address is your Polymarket proxy wallet address. Use `SIGNATURE_TYPE=1`.

### 4. Run in shadow mode

```bash
npm run dev
```

Watch the logs to confirm markets are found, shadow straddles are entered, and resolutions are tracked. When satisfied, set `SHADOW_MODE=false`.

### 5. API credentials

On first run the bot auto-derives L2 API credentials from your private key and logs them. Copy them into `.env`:

```env
POLY_API_KEY=...
POLY_SECRET=...
POLY_PASSPHRASE=...
```

This avoids re-deriving on every restart.

---

## Running the Bot

```bash
# Development (auto-restarts on file changes)
npm run dev

# Production
npm start
```

---

## Control Panel API

A local REST API runs at `http://127.0.0.1:3000` (configurable via `API_PORT`). **Localhost only — no authentication.**

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Slot states, active straddles, P&L summary |
| `GET` | `/config` | Current runtime config (sensitive fields redacted) |
| `POST` | `/config` | Hot-update mutable config fields without restarting |
| `POST` | `/pause` | Pause new straddle entries (active positions still resolve) |
| `POST` | `/resume` | Resume straddle entry |
| `GET` | `/logs?tail=N&cat=trades\|errors\|system` | Last N log lines |
| `GET` | `/logs/files` | List all log files |
| `GET` | `/redemptions` | Redemption queue status |

### Examples

```bash
# Check status
curl http://localhost:3000/status | jq

# Tune dump detection at runtime
curl -X POST http://localhost:3000/config \
  -H "Content-Type: application/json" \
  -d '{"dumpThresholdPercent": 20, "dumpEntryMaxPrice": 0.30}'

# Tighten sum target (more conservative, higher fee buffer)
curl -X POST http://localhost:3000/config \
  -H "Content-Type: application/json" \
  -d '{"sumTarget": 0.88}'

# Pause trading
curl -X POST http://localhost:3000/pause

# Tail recent trades
curl "http://localhost:3000/logs?tail=50&cat=trades" | jq '.entries[]'

# Go live without restarting
curl -X POST http://localhost:3000/config \
  -H "Content-Type: application/json" \
  -d '{"shadowMode": false}'
```

---

## Configuration Reference

All values are set in `.env`. Values marked ✏️ can be changed at runtime via `POST /config`.

### Credentials

| Variable | Default | Description |
|---|---|---|
| `PRIVATE_KEY` | — | Your EOA private key |
| `POLYMARKET_FUNDER_ADDRESS` | — | Your Polymarket profile/proxy wallet address |
| `SIGNATURE_TYPE` | `0` | `0`=EOA, `1`=Magic/Email |
| `POLY_API_KEY` / `POLY_SECRET` / `POLY_PASSPHRASE` | — | L2 API credentials (auto-derived if blank) |
| `POLY_BUILDER_API_KEY` / `POLY_BUILDER_SECRET` / `POLY_BUILDER_PASSPHRASE` | — | Builder program credentials (required for auto-redemption) |
| `POLYGON_RPC_URL` | `https://polygon-rpc.com` | Polygon RPC for on-chain resolution checks |

### Scanning

| Variable | Default | Mutable | Description |
|---|---|---|---|
| `SCAN_INTERVAL_MS` | `4000` | ✏️ | Heartbeat market-list refresh interval (ms) |
| `TARGET_ASSETS` | `BTC,ETH,SOL,MATIC,DOGE,XRP` | ✏️ | Comma-separated crypto assets to watch |
| `ENABLE_5M` | `true` | ✏️ | Watch 5-minute markets |
| `ENABLE_15M` | `true` | ✏️ | Watch 15-minute markets |
| `MAX_TIME_REMAINING_5M` | `150` | ✏️ | Only enter 5m markets with ≤ this many seconds left |
| `MAX_TIME_REMAINING_15M` | `450` | ✏️ | Only enter 15m markets with ≤ this many seconds left |

### Dump Detection

| Variable | Default | Mutable | Description |
|---|---|---|---|
| `DUMP_LOOKBACK_SECONDS` | `3` | ✏️ | Rolling price history window for dump calculation |
| `DUMP_THRESHOLD_PERCENT` | `15` | ✏️ | Minimum price drop % to trigger dump signal |
| `DUMP_ENTRY_MAX_PRICE` | `0.35` | ✏️ | Only enter if the dumped ask is ≤ this value |

### Straddle Entry

| Variable | Default | Mutable | Description |
|---|---|---|---|
| `SUM_TARGET` | `0.92` | ✏️ | Target sum of Leg 1 + Leg 2 prices. Lower = more conservative, higher fee buffer. Polymarket taker fees can reach ~1.8%. |
| `HEDGE_TIMEOUT_SECONDS` | `120` | ✏️ | Max seconds to wait for Leg 2 GTC fill before stop-loss escalation |

### DCA (Dollar-Cost Averaging on Leg 1)

| Variable | Default | Mutable | Description |
|---|---|---|---|
| `ENABLE_DCA` | `true` | ✏️ | Allow DCA buys on Leg 1 |
| `DCA_THRESHOLD_PERCENT` | `5` | ✏️ | Leg 1 ask must drop this % below weighted avg to trigger DCA |
| `MAX_DCA_COUNT` | `3` | ✏️ | Max DCA rounds per straddle |

### Fill Monitoring

| Variable | Default | Mutable | Description |
|---|---|---|---|
| `FILL_POLL_INTERVAL_MS` | `5000` | ✏️ | Base poll interval for Leg 2 fill checks (±20% jitter applied) |
| `STOP_LOSS_REMAINING_SECONDS` | `300` | ✏️ | Force-buy Leg 2 at market when market closes within this many seconds |

### Slots & Compounding

| Variable | Default | Mutable | Description |
|---|---|---|---|
| `NUM_SLOTS` | `5` | ✏️ | Max simultaneous active straddles |
| `SLOT_INITIAL_USD` | `10` | ✏️ | Starting USDC per slot |
| `SLOT_PROFIT_MULTIPLIER` | `1.2` | ✏️ | Extract profit when balance reaches `initial × this` |
| `ENABLE_COMPOUNDING` | `true` | ✏️ | Reinvest winnings; if false, profits are always extracted immediately |

### Order Execution

| Variable | Default | Mutable | Description |
|---|---|---|---|
| `ORDER_TYPE` | `FOK` | ✏️ | Default order type for legs. `FOK` recommended for Leg 1. |

### Mode & Logging

| Variable | Default | Mutable | Description |
|---|---|---|---|
| `SHADOW_MODE` | `true` | ✏️ | Simulate without placing real orders |
| `LOG_FILE_PATH` | `./logs/activity.log` | No | Log file path |
| `RESOLUTION_POLL_INTERVAL_MS` | `5000` | No | HTTP fallback resolution poll interval |
| `API_PORT` | `3000` | No | Control panel port |

### Scheduler

| Variable | Default | Mutable | Description |
|---|---|---|---|
| `TRADING_START_TIME` | `00:00` | ✏️ | UTC trading window start (`HH:MM`) |
| `TRADING_END_TIME` | `23:59` | ✏️ | UTC trading window end (`HH:MM`) |
| `DAILY_PROFIT_TARGET` | — | ✏️ | Pause when today's net P&L reaches this USDC value |
| `DAILY_LOSS_LIMIT` | — | ✏️ | Pause when today's net P&L drops to `-this` value |

### Telegram

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | — | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | — | Your chat/channel ID |

---

## Slot / Compounding Strategy

The bot maintains N independent slots, each with its own USDC balance.

**On a WIN:**
- The net profit (payout − total cost of both legs) is added to the slot balance.
- If `enableCompounding=true` and balance ≥ `initial × profitMultiplier`, excess profit is extracted and the slot resets to `SLOT_INITIAL_USD`.

**On a LOSS:**
- The net loss (total cost − winning leg payout) is recorded.
- The slot balance resets to `SLOT_INITIAL_USD`.

A single loss never wipes more than one slot.

---

## WebSocket Architecture

Real-time price feeds come from `wss://ws-subscriptions-clob.polymarket.com/ws/market`. The bot subscribes to YES and NO token IDs for every known market. Events received:

- **`book`** — order book snapshot with `bestBid`/`bestAsk` per token. Used for dump detection and DCA price checks.
- **`price_change`** — price updates. Triggers `checkForDump()` on untracked markets, or `onPriceUpdate()` on tracked (active straddle) markets.
- **`market_resolved`** — fires when a market settles. Routes to `handleWsResolution()` in trader.ts.
- **`new_market`** — triggers a heartbeat refresh to pick up newly listed markets.

A PING text frame is sent every 10 seconds. The connection auto-reconnects with exponential backoff (max 20 attempts, 30s cap) on disconnection.

---

## Auto-Redemption

After every live win, the market position is enqueued for automatic redemption. The redemption queue:

1. Waits for on-chain settlement (polls `payoutDenominator` via Polygon RPC)
2. Submits `redeemPositions` via the Polymarket Builder relayer
3. Retries on failure with exponential backoff
4. Persists to `data/redemption-queue.json` so pending redemptions survive a restart

Builder program credentials (`POLY_BUILDER_*`) are required for this step.

---

## Log File

Every action is written as a single JSON line. Files rotate hourly and are cleaned up after 24 hours.

```json
{
  "ts": "2026-04-11T10:23:45.123Z",
  "level": "INFO",
  "event": "STRADDLE_ENTRY_START",
  "shadow": false,
  "data": { ... full context ... }
}
```

### Useful log filters

```bash
# Monitor in real-time
tail -f logs/activity.log | jq .

# All straddle entries
grep '"event":"STRADDLE_ENTRY_START"' logs/activity.log | jq .

# All resolutions
grep '"event":"RESOLUTION"' logs/activity.log | jq '{ts:.ts, profit:.data.profit}'

# Dump signals
grep '"event":"DUMP_DETECTED"' logs/activity.log | jq '{asset:.data.asset, dumpAsk:.data.dumpAsk}'

# Profit extractions
grep '"event":"SLOT_PROFIT_EXTRACTED"' logs/activity.log | jq '[.data.profitExtracted] | add'

# DCA events
grep '"event":"DCA_TRIGGERED"' logs/activity.log | jq .
```

### Log categories (for `/logs` API)

| Category | Events |
|---|---|
| `trades` | Straddle lifecycle, order responses, fills, DCA, stop-loss, slot wins/losses |
| `system` | Dump detection, scanner ticks, bot start/pause/resume, config changes |
| `errors` | Order failures, resolution errors, redemption failures |

---

## Before Live Trading

1. **Approve USDC** — Polymarket's CLOB requires a one-time USDC allowance on Polygon. The easiest way is to place a manual trade on polymarket.com, which sets the approvals automatically.

2. **Run shadow mode for hours** — Verify dump signals fire on real market events, straddles are constructed correctly, resolutions track, and compounding works as expected.

3. **Start small** — Set `SLOT_INITIAL_USD=1` and `NUM_SLOTS=1` for your first live position.

4. **Understand fee risk** — Polymarket taker fees can reach ~1.8% per leg. With two legs, total fee drag can be ~3.6%. The default `SUM_TARGET=0.92` provides an 8% spread buffer. Lower it further (`0.88`–`0.90`) for extra safety.

5. **Geographic restrictions** — Polymarket restricts certain regions. Ensure your jurisdiction permits prediction markets.

---

## Architecture Notes

- **No database** — all state is in-memory. Logs are the audit trail. Redemption queue is persisted to disk.
- **On restart** — active straddles are lost; slots reset. Pending redemptions in `data/redemption-queue.json` resume automatically.
- **Jitter** — each straddle's fill poll interval is independently jittered ±20% to avoid pattern-based rate limiting across multiple concurrent positions.
- **Shadow → Live** — flip `shadowMode` via `POST /config` without restarting the process.
- **TypeScript + tsx** — runs natively with no compile step. `npm run dev` hot-reloads on file changes.
