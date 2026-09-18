# US Treasury Fiscal Data

The U.S. Department of Treasury's Fiscal Data API. Daily Treasury cash, public debt outstanding, federal receipts and outlays, customs revenue, exchange rates, and savings bonds redemption data. The actual numbers behind "the federal deficit" and "the national debt." Free, no auth.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Why this matters for AI agents

For macro questions about the US fiscal stance — debt level, daily cash position, monthly receipts, customs revenue — Treasury Fiscal Data is the authoritative live source. Where FRED publishes monthly aggregates, Treasury publishes the underlying daily ledger.

Common flows:

- **National debt.** "What's the public debt right now?" → `treasury_debt` → outstanding total broken into intragovernmental vs. public-held.
- **Customs revenue.** "How much tariff revenue did Treasury collect in 2024?" → `treasury_customs_revenue({year: 2024})`.
- **Receipts / outlays.** Daily Treasury cash position (deposits vs. withdrawals) by source.
- **Exchange rates.** Treasury reporting rate for foreign-currency transactions (used by federal contractors and grant recipients).

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

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

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

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/treasury_customs_revenue \
  -H 'Content-Type: application/json' \
  -d '{"limit":12}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/treasury_customs_revenue`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.
