# Polybot — Polymarket Crypto Up/Down Trading Bot

A TypeScript bot that scans Polymarket for high-confidence crypto price direction markets (5-min, 15-min up/down) and places bets using a compounding slot strategy.

---

## Project Structure

```
polybot/
├── src/
│   ├── index.ts        # Entry point — bootstraps everything
│   ├── config.ts       # All config (loaded from .env, hot-patchable)
│   ├── types.ts        # Shared domain types
│   ├── logger.ts       # Append-only JSON-line logger
│   ├── polymarket.ts   # Polymarket API client (Gamma + CLOB)
│   ├── scanner.ts      # Scans for qualifying markets on an interval
│   ├── slots.ts        # Compounding slot state machine
│   ├── shadow.ts       # Shadow mode: simulates bets, polls real resolutions
│   ├── trader.ts       # Orchestrates scanner → slots → orders
│   └── api.ts          # Express control panel (localhost)
├── logs/
│   └── activity.log    # Every event as a JSON line (never truncated)
├── .env.example        # Template — copy to .env and fill in
├── package.json
├── tsconfig.json
└── README.md
```

---

## Prerequisites

- Node.js 20+
- A funded Polygon wallet with USDC on Polymarket
- Your wallet private key

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Open `.env` and fill in:

```env
PRIVATE_KEY=0xyour_private_key_here
POLYMARKET_FUNDER_ADDRESS=0xyour_polymarket_profile_address_here
```

Everything else has sensible defaults. Start in **shadow mode** (`SHADOW_MODE=true`) to verify the bot works before spending real money.

### 3. Get your Polymarket funder address

- If you signed up with a browser wallet (MetaMask): your funder address is the address shown on your Polymarket profile page. Use `SIGNATURE_TYPE=0`.
- If you signed up with email/Magic: export your private key from https://reveal.magic.link/polymarket and your funder address is your Polymarket proxy wallet address. Use `SIGNATURE_TYPE=1`.

### 4. Run in shadow mode first

```bash
SHADOW_MODE=true npm start
```

Watch the logs to confirm markets are being found, simulated bets are placed, and resolutions are being tracked. When you're confident, set `SHADOW_MODE=false`.

### 5. API credentials

On first run, the bot will automatically derive L2 API credentials from your private key and print them to the log. Copy them into your `.env`:

```env
POLY_API_KEY=...
POLY_SECRET=...
POLY_PASSPHRASE=...
```

This avoids the derivation step on every restart.

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

The bot runs a local REST API at `http://127.0.0.1:3000` (port configurable via `API_PORT`).

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/status` | Slot states, active bets, P&L summary |
| `GET` | `/config` | Current runtime config (sensitive fields redacted) |
| `POST` | `/config` | Hot-update config fields without restarting |
| `POST` | `/pause` | Pause scanning (active bets still resolve) |
| `POST` | `/resume` | Resume scanning |
| `GET` | `/logs?tail=N` | Last N log lines (default 100) |

### Example: update price range

```bash
curl -X POST http://localhost:3000/config \
  -H "Content-Type: application/json" \
  -d '{"priceRangeMin": 0.95, "priceRangeMax": 0.99}'
```

### Example: check status

```bash
curl http://localhost:3000/status | jq
```

### Example: switch to live mode at runtime

```bash
curl -X POST http://localhost:3000/config \
  -H "Content-Type: application/json" \
  -d '{"shadowMode": false}'
```

```bash
curl -X POST http://localhost:5000/config \
  -H "Content-Type: application/json" \
  -d '{"numSlots": 12}'
```

### Example: tail logs

```bash
curl "http://localhost:3000/logs?tail=50" | jq '.entries[]'
```

---

## Configuration Reference

All values are set in `.env`. Mutable values (marked ✏️) can also be changed at runtime via `POST /config`.

| Variable | Default | Mutable | Description |
|---|---|---|---|
| `PRIVATE_KEY` | — | No | Your EOA private key |
| `POLYMARKET_FUNDER_ADDRESS` | — | No | Your Polymarket profile address |
| `SIGNATURE_TYPE` | `0` | No | 0=EOA, 1=Magic/Email |
| `POLY_API_KEY/SECRET/PASSPHRASE` | — | No | L2 API credentials (auto-derived if blank) |
| `SCAN_INTERVAL_MS` | `4000` | ✏️ | How often to scan for markets (ms) |
| `TARGET_ASSETS` | `BTC,ETH,SOL` | ✏️ | Comma-separated crypto assets to watch |
| `MARKET_DURATIONS` | `5-minute,15-minute` | ✏️ | Duration strings to match in market titles |
| `PRICE_RANGE_MIN` | `0.90` | ✏️ | Minimum win-side price to qualify (0–1) |
| `PRICE_RANGE_MAX` | `0.99` | ✏️ | Maximum win-side price to qualify (0–1) |
| `FALLBACK_TIME_REMAINING_S` | `40` | ✏️ | Seconds remaining for fallback rule |
| `FALLBACK_MAX_PRICE` | `0.99` | ✏️ | Max price for fallback rule |
| `ORDER_TYPE` | `GTC` | ✏️ | `GTC` / `GTD` / `FOK` / `FAK` |
| `NUM_SLOTS` | `5` | ✏️ | Max simultaneous active bets |
| `SLOT_INITIAL_USD` | `10` | ✏️ | Starting USDC per slot |
| `SLOT_PROFIT_MULTIPLIER` | `1.2` | ✏️ | Extract profit when balance hits `initial × this` |
| `SHADOW_MODE` | `true` | ✏️ | `true` = simulate only, no real orders |
| `LOG_FILE_PATH` | `./logs/activity.log` | No | Path to the log file |
| `RESOLUTION_POLL_INTERVAL_MS` | `5000` | No | How often to poll for market resolution |
| `API_PORT` | `3000` | No | Control panel port |

---

## Slot / Compounding Strategy

The bot maintains N independent "slots", each starting with `SLOT_INITIAL_USD`.

**On a WIN:**
- The profit is added to the slot's balance (compounding).
- If the balance reaches `SLOT_INITIAL_USD × SLOT_PROFIT_MULTIPLIER`, the profit above the initial is extracted and the slot resets to `SLOT_INITIAL_USD`.
- This locks in profits automatically.

**On a LOSS:**
- Losses on 99¢ markets are always 100% of the stake.
- The slot resets to `SLOT_INITIAL_USD`.

This means a slot can compound wins indefinitely until the profit-extraction threshold is hit, but a single loss never wipes out more than one slot's initial amount.

---

## Order Types

| Type | Behaviour | Best for |
|------|-----------|---------|
| `GTC` | Good-Till-Cancelled limit order at the current price | Most liquid markets |
| `GTD` | Good-Till-Date limit order | Same as GTC with expiry |
| `FOK` | Fill-Or-Kill market order — must fill entirely immediately | High urgency / near expiry |
| `FAK` | Fill-And-Kill market order — partial fills accepted | Same as FOK but more flexible |

For high-price (99¢) markets with limited liquidity, `FOK` may result in many rejected orders. `GTC` with a price at the current ask is usually the most reliable.

---

## Log File

Every action is written as a single JSON line to `./logs/activity.log`. Nothing is ever truncated. Fields always present:

```json
{
  "ts": "2025-01-15T10:23:45.123Z",
  "level": "INFO",
  "event": "BET_PLACED",
  "shadow": false,
  "data": { ... full context ... }
}
```

To monitor in real-time:
```bash
tail -f logs/activity.log | jq .
```

To filter for wins only:
```bash
grep '"event":"RESOLUTION_WIN"' logs/activity.log | jq .
```

To get a P&L summary from logs:
```bash
grep '"event":"SLOT_PROFIT_EXTRACTED"' logs/activity.log | jq '[.data.profitExtracted] | add'
```

---

## IMPORTANT: Before Live Trading

1. **Approve USDC for the Exchange contract** — Polymarket's CLOB requires a USDC allowance. You need to set this once via the Polygon network. The easiest way is to place a manual trade on polymarket.com first, which sets the approvals automatically.

2. **Test thoroughly in shadow mode** — Run for several hours in shadow mode and verify that the resolution polling, slot compounding, and profit extraction all log correctly.

3. **Start small** — Set `SLOT_INITIAL_USD` to the minimum (e.g. $1–2) for your first live trades.

4. **Geographic restrictions** — Polymarket restricts certain regions. Ensure your jurisdiction permits use of prediction markets.

---

## Architecture Notes

- **No database** — all state is in-memory. Logs are the audit trail. On restart, slots reset.
- **Performance** — `tsx` runs TypeScript natively with no compile step. Single async loop per scanner. Network I/O is the bottleneck, not CPU.
- **Shadow → Live** — flip `shadowMode` via `POST /config` without restarting the process.
