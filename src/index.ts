interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Treasury Fiscal MCP — US Treasury Fiscal Data API
 *
 * Tools:
 * - treasury_customs_revenue: monthly customs duty collections
 * - treasury_receipts: total government receipts by source
 * - treasury_debt: national debt (debt to the penny)
 * - treasury_exchange_rates: Treasury exchange rates by country
 */


const BASE_URL = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service';

// The Treasury Fiscal Data API returns numeric amounts as STRINGS. Our
// outputSchema declares them as numbers (the useful shape for agents), so coerce
// — otherwise the nightly full-catalog schema check fails (number vs string).
// Sub-cent float imprecision on trillion-scale debt is irrelevant for use.
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const tools: McpToolExport['tools'] = [
  {
    name: 'treasury_customs_revenue',
    description:
      'Track monthly US customs duty revenue. Returns monthly collection amounts to analyze tariff impact trends.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Number of monthly records to return (default 12 for 1 year)',
        },
      },
    },
  },
  {
    name: 'treasury_receipts',
    description:
      'Get US government receipts by source: individual income tax, corporate tax, excise taxes, customs duties, and more.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Number of records to return (default 12)',
        },
      },
    },
  },
  {
    name: 'treasury_debt',
    description:
      'Check current US national debt with historical data points. Returns total public debt outstanding over time.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Number of records to return (default 10)',
        },
      },
    },
  },
  {
    name: 'treasury_exchange_rates',
    description:
      'Get official US Treasury exchange rates for any currency (e.g., \'EUR\', \'GBP\', \'JPY\'). Returns rates used for government conversions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        country: {
          type: 'string',
          description: 'Country name (e.g., "China", "Mexico", "Japan", "Canada")',
        },
        limit: {
          type: 'number',
          description: 'Number of records to return (default 12)',
        },
      },
      required: ['country'],
    },
  },
  {
    name: 'treasury_avg_interest_rates',
    description:
      'Average interest rates on US Treasury securities by security type (bills, notes, bonds, TIPS, total marketable / non-marketable) from the Treasury Fiscal Data avg_interest_rates dataset. Returns recent monthly records.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Number of records to return (default 12)' },
      },
    },
  },
  {
    name: 'treasury_federal_net_cost',
    description:
      'US federal government net cost / spending by agency (gross cost, earned revenue, net cost) from the Treasury statement_net_cost dataset. Returns recent records; optionally filter by fiscal_year.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fiscal_year: { type: 'string', description: 'Four-digit fiscal year to filter by (e.g., "2024"). Omit for most recent.' },
        limit: { type: 'number', description: 'Number of records to return (default 20)' },
      },
    },
  },
];

interface FiscalApiResponse {
  data: Record<string, unknown>[];
  meta: {
    count: number;
    labels: Record<string, string>;
    dataTypes: Record<string, string>;
    dataFormats: Record<string, string>;
    'total-count': number;
    'total-pages': number;
  };
}

// Production analytics 2026-06-08 caught api.fiscaldata.treasury.gov throwing
// 525 (CF SSL handshake failed) on ~10 calls/day. By 06-11 the block was
// total: local curl 200 in <1s, worker 525 on every attempt — Treasury's edge
// rejects CF Worker egress (same family as usaspending). Two-layer treatment:
//   1. live fetch with timeout/retry (below) — wins whenever the block lifts;
//   2. fallback to the daily GH-runner mirror in Supabase
//      (treasury_fiscal_mirror, refreshed by scripts/treasury-refresh.sh) —
//      the gateway injects _supabaseUrl/_supabaseKey (injectSupabase flag).
// Only when BOTH fail do we throw the upstream_down envelope.
const TREASURY_TIMEOUT_MS = 8000;

type Supa = { url: string; key: string } | null;

function supaFromArgs(args: Record<string, unknown>): Supa {
  const url = (args._supabaseUrl as string | undefined)?.trim();
  const key = (args._supabaseKey as string | undefined)?.trim();
  return url && key ? { url, key } : null;
}

async function readMirror(dataset: string, supa: Supa): Promise<{ payload: FiscalApiResponse; fetched_at: string } | null> {
  if (!supa) return null;
  try {
    const res = await fetch(
      `${supa.url}/rest/v1/treasury_fiscal_mirror?dataset=eq.${encodeURIComponent(dataset)}&select=payload,fetched_at`,
      { headers: { apikey: supa.key, Authorization: `Bearer ${supa.key}` } },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ payload: FiscalApiResponse; fetched_at: string }>;
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

// Live first; on any live failure serve the mirror. When a mirror exists we
// skip the live retry (attempt=2 → no second try) so the fallback path stays
// fast (~8s worst case instead of 16.5s). Rethrows the live error if no mirror.
//
// Pack-level live circuit: once a live attempt fails, skip live for 5 min in
// this isolate and go mirror-first. Without it, a router fan-out hitting
// several treasury tools serially pays 8s EACH waiting on the blocked egress
// — enough wall-clock for CF to kill the worker (surfaces as error 1102; see
// the usaspending hang incident). Only the first call pays the 8s probe.
let liveBlockedUntil = 0;
const LIVE_CIRCUIT_MS = 5 * 60_000;

async function liveOrMirror(
  dataset: string,
  endpoint: string,
  params: Record<string, string>,
  supa: Supa,
): Promise<{ response: FiscalApiResponse; mirror_fetched_at?: string }> {
  if (supa && Date.now() < liveBlockedUntil) {
    const m = await readMirror(dataset, supa);
    if (m) return { response: m.payload, mirror_fetched_at: m.fetched_at };
    // mirror unavailable — fall through and try live after all
  }
  try {
    const response = await fetchTreasury(endpoint, params, supa ? 2 : 1);
    liveBlockedUntil = 0;
    return { response };
  } catch (e) {
    liveBlockedUntil = Date.now() + LIVE_CIRCUIT_MS;
    const m = await readMirror(dataset, supa);
    if (!m) throw e;
    return { response: m.payload, mirror_fetched_at: m.fetched_at };
  }
}

// Annotation added to results served from the mirror so agents (and the
// data-quality monitor) can see the data's true provenance + age.
function mirrorMeta(fetchedAt: string) {
  return {
    source: 'mirror' as const,
    mirror_fetched_at: fetchedAt,
    note: 'Live Treasury API is unreachable from the gateway (CF egress blocked); served from the daily GitHub-runner mirror.',
  };
}
async function fetchTreasury(endpoint: string, params: Record<string, string> = {}, attempt = 1): Promise<FiscalApiResponse> {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TREASURY_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'Pipeworx/1.0 (gateway.pipeworx.io)' },
      signal: controller.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 500));
        return fetchTreasury(endpoint, params, 2);
      }
      throw new Error(`upstream_down: Treasury Fiscal API timeout — api.fiscaldata.treasury.gov did not respond within ${TREASURY_TIMEOUT_MS}ms on either attempt.`);
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
  if (res.status >= 500 && res.status < 600 && attempt === 1) {
    await new Promise((r) => setTimeout(r, 500));
    return fetchTreasury(endpoint, params, 2);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const attemptNote = attempt > 1 ? ` (after ${attempt} attempts)` : '';
    const prefix = res.status >= 500 ? 'upstream_down: ' : '';
    throw new Error(`${prefix}Treasury Fiscal API error: ${res.status} ${res.statusText}${attemptNote} — ${text.slice(0, 100)}`);
  }

  const data = (await res.json()) as FiscalApiResponse;
  return data;
}

// Treasury's 2026 MTS restructure: customs moved off line 830 (now 100) and
// gross/refund/net live on table 4, not 9 — the old mapping returned undefined
// for every amount. Filter by classification_desc (renumbering-proof).
async function getCustomsRevenue(limit: number = 12, supa: Supa = null) {
  const { response, mirror_fetched_at } = await liveOrMirror('customs_revenue', 'v1/accounting/mts/mts_table_4', {
    'filter': 'classification_desc:eq:Customs Duties',
    'sort': '-record_date',
    'page[size]': String(limit),
  }, supa);
  // Mirror payload is pre-filtered to Customs Duties but holds 60 rows — apply limit.
  const rows = mirror_fetched_at ? response.data.slice(0, limit) : response.data;

  return {
    description: 'Monthly US customs duty revenue',
    count: rows.length,
    total_available: response.meta['total-count'],
    ...(mirror_fetched_at ? mirrorMeta(mirror_fetched_at) : {}),
    records: rows.map((r) => ({
      record_date: r.record_date,
      classification: r.classification_desc,
      current_month_gross: num(r.current_month_gross_rcpt_amt),
      current_month_refund: num(r.current_month_refund_amt),
      current_month_net: num(r.current_month_net_rcpt_amt),
      fiscal_year_gross: num(r.current_fytd_gross_rcpt_amt),
      fiscal_year_refund: num(r.current_fytd_refund_amt),
      fiscal_year_net: num(r.current_fytd_net_rcpt_amt),
    })),
  };
}

async function getReceipts(limit: number = 12, supa: Supa = null) {
  const { response, mirror_fetched_at } = await liveOrMirror('receipts', 'v1/accounting/mts/mts_table_4', {
    'sort': '-record_date',
    'page[size]': String(limit),
  }, supa);
  const rows = mirror_fetched_at ? response.data.slice(0, limit) : response.data;

  return {
    description: 'US government receipts by source category',
    count: rows.length,
    total_available: response.meta['total-count'],
    ...(mirror_fetched_at ? mirrorMeta(mirror_fetched_at) : {}),
    // 2026 MTS restructure: table 4 now carries gross/refund/net (the old
    // rcpt_outly / table_nm fields are gone — they mapped to undefined).
    records: rows.map((r) => ({
      record_date: r.record_date,
      classification: r.classification_desc,
      current_month_gross: num(r.current_month_gross_rcpt_amt),
      current_month_refund: num(r.current_month_refund_amt),
      current_month_net: num(r.current_month_net_rcpt_amt),
      fiscal_year_net: num(r.current_fytd_net_rcpt_amt),
      line_code: r.line_code_nbr,
    })),
  };
}

async function getDebt(limit: number = 10, supa: Supa = null) {
  const { response, mirror_fetched_at } = await liveOrMirror('debt_to_penny', 'v2/accounting/od/debt_to_penny', {
    'sort': '-record_date',
    'page[size]': String(limit),
  }, supa);
  const rows = mirror_fetched_at ? response.data.slice(0, limit) : response.data;

  return {
    description: 'US national debt (Debt to the Penny)',
    count: rows.length,
    ...(mirror_fetched_at ? mirrorMeta(mirror_fetched_at) : {}),
    records: rows.map((r) => ({
      record_date: r.record_date,
      total_public_debt_outstanding: num(r.tot_pub_debt_out_amt),
      debt_held_by_public: num(r.debt_held_public_amt),
      intragovernmental_holdings: num(r.intragov_hold_amt),
    })),
  };
}

async function getExchangeRates(country: string, limit: number = 12, supa: Supa = null) {
  const { response, mirror_fetched_at } = await liveOrMirror('exchange_rates', 'v1/accounting/od/rates_of_exchange', {
    'filter': `country:eq:${country}`,
    'sort': '-record_date',
    'page[size]': String(limit),
  }, supa);
  // Mirror holds ALL countries (latest ~2000 rows) — filter client-side.
  const rows = mirror_fetched_at
    ? response.data.filter((r) => String(r.country ?? '').toLowerCase() === country.toLowerCase()).slice(0, limit)
    : response.data;

  if (rows.length === 0) {
    throw new Error(`No exchange rate data found for country: "${country}". Try the full country name (e.g., "China", "Mexico", "Japan").`);
  }

  return {
    description: `Treasury exchange rates for ${country}`,
    country,
    count: rows.length,
    ...(mirror_fetched_at ? mirrorMeta(mirror_fetched_at) : {}),
    records: rows.map((r) => ({
      record_date: r.record_date,
      country: r.country,
      currency: r.currency,
      exchange_rate: num(r.exchange_rate),
      effective_date: r.effective_date,
    })),
  };
}

async function getAvgInterestRates(limit: number = 12, supa: Supa = null) {
  const { response, mirror_fetched_at } = await liveOrMirror('avg_interest_rates', 'v2/accounting/od/avg_interest_rates', {
    'sort': '-record_date',
    'page[size]': String(limit),
  }, supa);
  const rows = mirror_fetched_at ? response.data.slice(0, limit) : response.data;
  return {
    description: 'Average interest rates on US Treasury securities by security type',
    count: rows.length,
    total_available: response.meta['total-count'],
    ...(mirror_fetched_at ? mirrorMeta(mirror_fetched_at) : {}),
    records: rows.map((r) => ({
      record_date: r.record_date,
      security_type: r.security_type_desc,
      security_description: r.security_desc,
      avg_interest_rate: num(r.avg_interest_rate_amt),
    })),
  };
}

async function getFederalNetCost(fiscalYear?: string, limit: number = 20, supa: Supa = null) {
  const params: Record<string, string> = { 'sort': '-record_date', 'page[size]': String(limit) };
  if (fiscalYear) params.filter = `record_fiscal_year:eq:${fiscalYear}`;
  const { response, mirror_fetched_at } = await liveOrMirror('statement_net_cost', 'v2/accounting/od/statement_net_cost', params, supa);
  const rows = mirror_fetched_at ? response.data.slice(0, limit) : response.data;
  return {
    description: 'US federal net cost / spending by agency',
    filter_fiscal_year: fiscalYear ?? null,
    count: rows.length,
    ...(mirror_fetched_at ? mirrorMeta(mirror_fetched_at) : {}),
    records: rows.map((r) => ({
      record_date: r.record_date,
      fiscal_year: r.record_fiscal_year ?? r.fiscal_year,
      agency: r.agency_nm,
      gross_cost: num(r.gross_cost_amt),
      earned_revenue: num(r.earned_revenue_amt),
      net_cost: num(r.net_cost_amt),
    })),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const supa = supaFromArgs(args); // injected by the gateway (injectSupabase)
  switch (name) {
    case 'treasury_customs_revenue':
      return getCustomsRevenue((args.limit as number) || 12, supa);
    case 'treasury_receipts':
      return getReceipts((args.limit as number) || 12, supa);
    case 'treasury_debt':
      return getDebt((args.limit as number) || 10, supa);
    case 'treasury_exchange_rates':
      return getExchangeRates(args.country as string, (args.limit as number) || 12, supa);
    case 'treasury_avg_interest_rates':
      return getAvgInterestRates((args.limit as number) || 12, supa);
    case 'treasury_federal_net_cost':
      return getFederalNetCost(args.fiscal_year as string | undefined, (args.limit as number) || 20, supa);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
