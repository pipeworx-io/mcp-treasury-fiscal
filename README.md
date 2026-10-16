# US Treasury Fiscal Data

The U.S. Department of Treasury's Fiscal Data API. Daily Treasury cash, public debt outstanding, federal receipts and outlays, customs revenue, exchange rates, and savings bonds redemption data. The actual numbers behind "the federal deficit" and "the national debt." Free, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1819+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Why this matters for AI agents

For macro questions about the US fiscal stance — debt level, daily cash position, monthly receipts, customs revenue — Treasury Fiscal Data is the authoritative live source. Where FRED publishes monthly aggregates, Treasury publishes the underlying daily ledger.

Common flows:

- **National debt.** "What's the public debt right now?" → `treasury_debt` → outstanding total broken into intragovernmental vs. public-held.
- **Customs revenue.** "How much tariff revenue did Treasury collect in 2024?" → `treasury_customs_revenue({year: 2024})`.
- **Receipts / outlays.** Daily Treasury cash position (deposits vs. withdrawals) by source.
- **Exchange rates.** Treasury reporting rate for foreign-currency transactions (used by federal contractors and grant recipients).
- **Auction results.** "What was the high yield at the last 10-year note auction?" → `treasury_auction_results({security_type: "Note", term: "10-Year"})` → high yield, bid-to-cover ratio, CUSIP, offering/accepted amounts for the most recent settled auction. Covers bills, notes, bonds, TIPS, and floating-rate notes (FRNs).

Used by the `trade_bilateral_analysis` compound for tariff context.

## Auth

None. Treasury Fiscal Data is fully public, free, no key.

## Datasets worth knowing

| Dataset | Cadence | Use |
|---|---|---|
| Daily Treasury Statement | Daily | Cash position, deposits, withdrawals |
| Monthly Treasury Statement | Monthly | Receipts, outlays, deficit |
| Public Debt Outstanding | Daily | Total debt, intragovernmental vs. public-held |
| Customs Revenue | Monthly | Tariff collections |
| Treasury Reporting Rates of Exchange | Quarterly | Official rates for federal accounting |
| Savings Bond Securities | Monthly | Issuance, redemption |
| Auctions | Per auction (daily-ish) | High yield/rate, bid-to-cover, CUSIP for bills/notes/bonds/TIPS/FRNs |

## Update cadence

- Daily Treasury Statement: ~3 PM Eastern, T+1 (next business day)
- Monthly statements: ~mid-month, for prior month
- Public debt: daily
- Exchange rates: quarterly (recalibrated; not real-time market rates — use FX/forex packs for live rates)

Pipeworx caches with TTLs matching these.

## Common pitfalls

- **Public debt vs. gross debt.** "Public-held debt" excludes intragovernmental holdings (Social Security trust fund, etc.). Headlines usually quote the gross debt; analysts care about public-held. Both are in the data.
- **Customs revenue ≠ tariffs only.** Includes anti-dumping, countervailing duties, fees. For pure tariff revenue, filter by item code in the call response.
- **Treasury exchange rates aren't market rates.** They're quarterly-recalibrated rates used for federal accounting. For real-time FX, use the dedicated `exchange-rate` or `frankfurter` packs.
- **Daily cash position is not GDP.** The Treasury's cash position is a stock measure; GDP is a flow. Don't confuse.
- **Fiscal year vs. calendar year.** Federal fiscal year is October 1 – September 30. Receipts and outlays default to fiscal-year reporting. Filter explicitly if you need calendar-year numbers.
- **Auctions are often reopenings, not new issues.** Treasury reopens an existing note/bond CUSIP at a shorter remaining maturity (e.g. a "10-year note" auctioned 2 months after issuance shows up as a "9-Year 10-Month" term). `treasury_auction_results`'s `term` filter matches the security's ORIGINAL nominal term (`original_term` in the response) so "10-Year" still finds it — use `term`/`original_term` in the response to tell a fresh issue from a reopening.
- **TIPS and FRNs aren't their own `security_type` in the source data.** Treasury files them under `Note`/`Bond` with an inflation-indexed or floating-rate flag. Pass `security_type: "TIPS"` or `"FRN"` and the tool resolves this for you; the raw API's own `security_type:eq:TIPS` filter returns zero rows.
- **Bills report a rate, not a yield.** `high_yield_pct` is null for bills — use `high_investment_rate_pct` (the bond-equivalent yield) or `high_discount_rate_pct` (the discount rate actually bid).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "treasury-fiscal": {
      "url": "https://gateway.pipeworx.io/treasury-fiscal/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/treasury-fiscal/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1819+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/treasury_customs_revenue \
  -H 'Content-Type: application/json' \
  -d '{"limit":12}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/treasury_customs_revenue`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "treasury-fiscal": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-treasury-fiscal"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-treasury-fiscal
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Treasury Fiscal data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
