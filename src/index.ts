interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
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

const tools: McpToolExport['tools'] = [
  {
    name: 'treasury_customs_revenue',
    description:
      'Get monthly US customs duty revenue collections from the Treasury. Useful for tracking tariff revenue impact over time.',
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
      'Get total US government receipts broken down by source (individual income tax, corporate tax, excise taxes, customs duties, etc.).',
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
      'Get the current US national debt (debt to the penny). Returns total public debt outstanding with historical data points.',
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
      'Get Treasury exchange rates for a specific country. Shows the official rates used by the US government for currency conversion.',
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

async function fetchTreasury(endpoint: string, params: Record<string, string> = {}): Promise<FiscalApiResponse> {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': 'Pipeworx/1.0 (gateway.pipeworx.io)' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Treasury Fiscal API error: ${res.status} ${res.statusText} — ${text}`);
  }

  const data = (await res.json()) as FiscalApiResponse;
  return data;
}

async function getCustomsRevenue(limit: number = 12) {
  const response = await fetchTreasury('v1/accounting/mts/mts_table_9', {
    'filter': 'line_code_nbr:eq:830',
    'sort': '-record_date',
    'page[size]': String(limit),
  });

  return {
    description: 'Monthly US customs duty revenue',
    count: response.data.length,
    total_available: response.meta['total-count'],
    records: response.data.map((r) => ({
      record_date: r.record_date,
      classification: r.classification_desc || r.classification,
      current_month_gross: r.current_month_gross_rcpt_amt,
      current_month_refund: r.current_month_refund_amt,
      current_month_net: r.current_month_net_rcpt_amt,
      fiscal_year_gross: r.fiscal_year_gross_rcpt_amt,
      fiscal_year_refund: r.fiscal_year_refund_amt,
      fiscal_year_net: r.fiscal_year_net_rcpt_amt,
    })),
  };
}

async function getReceipts(limit: number = 12) {
  const response = await fetchTreasury('v1/accounting/mts/mts_table_4', {
    'sort': '-record_date',
    'page[size]': String(limit),
  });

  return {
    description: 'US government receipts by source category',
    count: response.data.length,
    total_available: response.meta['total-count'],
    records: response.data.map((r) => ({
      record_date: r.record_date,
      classification: r.classification_desc || r.classification,
      current_month_amt: r.current_month_rcpt_outly_amt,
      fiscal_year_amt: r.fiscal_year_rcpt_outly_amt,
      line_code: r.line_code_nbr,
      table_name: r.table_nm,
    })),
  };
}

async function getDebt(limit: number = 10) {
  const response = await fetchTreasury('v2/accounting/od/debt_to_penny', {
    'sort': '-record_date',
    'page[size]': String(limit),
  });

  return {
    description: 'US national debt (Debt to the Penny)',
    count: response.data.length,
    records: response.data.map((r) => ({
      record_date: r.record_date,
      total_public_debt_outstanding: r.tot_pub_debt_out_amt,
      debt_held_by_public: r.debt_held_public_amt,
      intragovernmental_holdings: r.intragov_hold_amt,
    })),
  };
}

async function getExchangeRates(country: string, limit: number = 12) {
  const response = await fetchTreasury('v1/accounting/od/rates_of_exchange', {
    'filter': `country:eq:${country}`,
    'sort': '-record_date',
    'page[size]': String(limit),
  });

  if (response.data.length === 0) {
    throw new Error(`No exchange rate data found for country: "${country}". Try the full country name (e.g., "China", "Mexico", "Japan").`);
  }

  return {
    description: `Treasury exchange rates for ${country}`,
    country,
    count: response.data.length,
    records: response.data.map((r) => ({
      record_date: r.record_date,
      country: r.country,
      currency: r.currency,
      exchange_rate: r.exchange_rate,
      effective_date: r.effective_date,
    })),
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'treasury_customs_revenue':
      return getCustomsRevenue((args.limit as number) || 12);
    case 'treasury_receipts':
      return getReceipts((args.limit as number) || 12);
    case 'treasury_debt':
      return getDebt((args.limit as number) || 10);
    case 'treasury_exchange_rates':
      return getExchangeRates(args.country as string, (args.limit as number) || 12);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
