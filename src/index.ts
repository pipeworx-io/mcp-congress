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
 * Congress MCP — US Congress data via GovTrack API (free, no auth required)
 *
 * Tools:
 * - search_bills: Search congressional bills by keyword
 * - get_bill: Get a single bill by GovTrack bill ID
 * - get_members: Get current members of Congress
 * - get_votes: Get recent congressional votes
 */


const BASE_URL = 'https://www.govtrack.us/api/v2';

// --- Raw API types ---

type RawBill = {
  id: number;
  bill_type?: string | null;
  bill_type_label?: string | null;
  number?: number | null;
  congress?: number | null;
  title?: string | null;
  title_without_number?: string | null;
  current_status?: string | null;
  current_status_label?: string | null;
  current_status_date?: string | null;
  introduced_date?: string | null;
  link?: string | null;
  sponsor?: {
    id?: number | null;
    name?: string | null;
    sortname?: string | null;
  } | null;
};

type RawMemberRole = {
  id?: number | null;
  person?: {
    id?: number | null;
    name?: string | null;
    sortname?: string | null;
    gender?: string | null;
    gender_label?: string | null;
    birthday?: string | null;
    link?: string | null;
  } | null;
  role_type?: string | null;
  role_type_label?: string | null;
  state?: string | null;
  state_name?: string | null;
  district?: number | null;
  party?: string | null;
  title?: string | null;
  title_long?: string | null;
  startdate?: string | null;
  enddate?: string | null;
  congress_numbers?: number[] | null;
  current?: boolean | null;
};

type RawVote = {
  id?: number | null;
  congress?: number | null;
  session?: number | null;
  chamber?: string | null;
  chamber_label?: string | null;
  number?: number | null;
  question?: string | null;
  question_details?: string | null;
  result?: string | null;
  category?: string | null;
  category_label?: string | null;
  created?: string | null;
  total_plus?: number | null;
  total_minus?: number | null;
  total_other?: number | null;
  link?: string | null;
  related_bill?: {
    id?: number | null;
    title?: string | null;
  } | null;
};

type GovTrackListResponse<T> = {
  meta?: { total_count?: number; offset?: number; limit?: number } | null;
  objects: T[];
};

// --- Formatters ---

function formatBill(b: RawBill) {
  return {
    id: b.id,
    bill_type: b.bill_type ?? null,
    bill_type_label: b.bill_type_label ?? null,
    number: b.number ?? null,
    congress: b.congress ?? null,
    title: b.title ?? null,
    title_without_number: b.title_without_number ?? null,
    status: b.current_status ?? null,
    status_label: b.current_status_label ?? null,
    status_date: b.current_status_date ?? null,
    introduced_date: b.introduced_date ?? null,
    sponsor_name: b.sponsor?.name ?? null,
    link: b.link ?? null,
  };
}

function formatMember(r: RawMemberRole) {
  return {
    role_id: r.id ?? null,
    person_id: r.person?.id ?? null,
    name: r.person?.name ?? null,
    sortname: r.person?.sortname ?? null,
    gender: r.person?.gender_label ?? null,
    birthday: r.person?.birthday ?? null,
    role_type: r.role_type ?? null,
    title: r.title_long ?? r.title ?? null,
    party: r.party ?? null,
    state: r.state ?? null,
    state_name: r.state_name ?? null,
    district: r.district ?? null,
    startdate: r.startdate ?? null,
    enddate: r.enddate ?? null,
    link: r.person?.link ?? null,
  };
}

function formatVote(v: RawVote) {
  return {
    id: v.id ?? null,
    congress: v.congress ?? null,
    session: v.session ?? null,
    chamber: v.chamber_label ?? v.chamber ?? null,
    number: v.number ?? null,
    question: v.question ?? null,
    question_details: v.question_details ?? null,
    result: v.result ?? null,
    category: v.category_label ?? v.category ?? null,
    created: v.created ?? null,
    yes_votes: v.total_plus ?? null,
    no_votes: v.total_minus ?? null,
    other_votes: v.total_other ?? null,
    related_bill_title: v.related_bill?.title ?? null,
    link: v.link ?? null,
  };
}

// --- Tool definitions ---

const tools: McpToolExport['tools'] = [
  {
    name: 'search_bills',
    description:
      'Search US congressional bills by keyword. Returns bill type, number, title, status, sponsor, and introduction date.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords to search for in bill titles' },
        limit: { type: 'number', description: 'Number of results to return (default: 10, max: 100)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_bill',
    description:
      'Get full details for a single congressional bill by its GovTrack bill ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number', description: 'GovTrack bill ID (numeric)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'get_members',
    description:
      'Get current members of Congress (senators and representatives). Returns name, party, state, district, and title.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of results to return (default: 50, max: 600)' },
      },
    },
  },
  {
    name: 'get_votes',
    description:
      'Get recent congressional votes. Returns question, result, chamber, vote counts, and related bill if any.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of votes to return (default: 20, max: 100)' },
        congress: { type: 'number', description: 'Congress number to filter by (e.g., 119)' },
      },
    },
  },
];

// --- callTool dispatcher ---

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_bills':
      return searchBills(args.query as string, (args.limit as number) ?? 10);
    case 'get_bill':
      return getBill(args.id as number);
    case 'get_members':
      return getMembers((args.limit as number) ?? 50);
    case 'get_votes':
      return getVotes((args.limit as number) ?? 20, args.congress as number | undefined);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- Tool implementations ---

async function searchBills(query: string, limit: number) {
  const count = Math.min(Math.max(1, limit), 100);
  const params = new URLSearchParams({
    q: query,
    limit: String(count),
  });

  const res = await fetch(`${BASE_URL}/bill?${params}`);
  if (!res.ok) throw new Error(`GovTrack API error: ${res.status}`);

  const data = (await res.json()) as GovTrackListResponse<RawBill>;

  return {
    query,
    total: data.meta?.total_count ?? data.objects.length,
    returned: data.objects.length,
    bills: data.objects.map(formatBill),
  };
}

async function getBill(id: number) {
  const res = await fetch(`${BASE_URL}/bill/${id}`);
  if (!res.ok) throw new Error(`GovTrack API error: ${res.status}`);

  const data = (await res.json()) as RawBill;
  return formatBill(data);
}

async function getMembers(limit: number) {
  const count = Math.min(Math.max(1, limit), 600);
  const params = new URLSearchParams({
    current: 'true',
    limit: String(count),
  });

  const res = await fetch(`${BASE_URL}/role?${params}`);
  if (!res.ok) throw new Error(`GovTrack API error: ${res.status}`);

  const data = (await res.json()) as GovTrackListResponse<RawMemberRole>;

  return {
    total: data.meta?.total_count ?? data.objects.length,
    returned: data.objects.length,
    members: data.objects.map(formatMember),
  };
}

async function getVotes(limit: number, congress?: number) {
  const count = Math.min(Math.max(1, limit), 100);
  const params = new URLSearchParams({ limit: String(count) });
  if (congress != null) params.set('congress', String(congress));

  const res = await fetch(`${BASE_URL}/vote?${params}`);
  if (!res.ok) throw new Error(`GovTrack API error: ${res.status}`);

  const data = (await res.json()) as GovTrackListResponse<RawVote>;

  return {
    total: data.meta?.total_count ?? data.objects.length,
    returned: data.objects.length,
    votes: data.objects.map(formatVote),
  };
}

export default { tools, callTool } satisfies McpToolExport;
