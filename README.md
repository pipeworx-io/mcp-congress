# US Congress — Bills, Laws, Members (congress.gov)

US federal bills (House and Senate), enacted public/private laws, and members of Congress, served from the Library of Congress's official congress.gov API, plus a full-text keyword search over the GPO's GovInfo index of the same bill documents. Bill status, sponsors, enacted laws, member rosters. Requires a free api.data.gov key.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1819+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Why this matters for AI agents

For policy research, agents need to know what bills exist, who's sponsoring them, where they are in the legislative process, and which laws have actually been enacted. Congress.gov is the canonical record. Pair with [Federal Register](/docs/reference/federal-register) (rules implementing legislation) and [USAspending](/docs/reference/usaspending) (where the money goes after authorization).

Common flows:

- **Bill search.** "What bills are pending on AI regulation?" → search by keyword, filter by Congress.
- **Bill detail.** "Status of HR 9876?" → get the bill record with sponsor, current status and whether it became law.
- **Public laws.** "How many laws has the 119th Congress enacted? What's the most recent?" → `get_public_laws`.
- **Member lookup.** "Current members of the House" → `get_members`.

## Auth

**Requires an API key.** A free api.data.gov key (https://api.data.gov/signup/) authenticates every tool in this pack — the same key works for congress.gov and GovInfo both. Called through the Pipeworx gateway this is supplied automatically; called directly, pass it as `_apiKey`.

## 2026-10-16: moved off GovTrack

This pack used to call GovTrack's public API. GovTrack now answers every endpoint it has — bills, members, votes — with a Cloudflare bot-challenge page served as HTTP 403, so every tool that relied on it failed on every call. `search_bills`, `get_bill`, `get_recent_bills` and `get_members` now call the official sources instead (congress.gov, plus GovInfo for `search_bills`'s keyword search — see below). `get_votes` now serves the House from congress.gov and the Senate from senate.gov's own records (see "Roll-call votes" below) — it briefly refused outright between #3164 and #3183 because congress.gov's roll-call endpoint is House-only.

## Search ranking (`search_bills`)

congress.gov's own bill listing has no free-text search parameter at all — it only browses/filters by Congress, type and date. The GPO's GovInfo index of the same bill documents (what congress.gov's own search box is built on) does support a keyword query, so `search_bills` searches there and re-ranks the results locally:

- **Candidates.** One GovInfo full-text search (up to 100 results), which already returns a reasonable relevancy order.
- **Dedup.** A bill shows up once per PUBLISHED VERSION (introduced, reported, engrossed, enrolled, ...) — these are collapsed to one row per (Congress, bill type, number), keeping whichever version scores best.
- **Ranking.** Every candidate's title is scored: exact title match, then a title containing the phrase (shorter wins), then all query words present (prefix-tolerant, so "lower" matches "Lowering"), then partial overlap. Each returned bill carries `match` (`exact` / `phrase` / `all_words` / `partial` / `none`) and `matched_title`.
- **`congress` filter.** Applied LOCALLY against the search results (not a documented GovInfo query field) — a match outside GovInfo's own top 100 results for that query may be missed. Pass it to narrow, not to guarantee exhaustive coverage of one Congress the way the old GovTrack-backed version did.
- Sponsor, status and introduced-date on each result come from congress.gov (a follow-up lookup per candidate), since GovInfo's search result carries only title and date.

## Public laws (`get_public_laws`) — new

GovTrack never had an endpoint for enacted laws. congress.gov does: pass a Congress number (and optionally `law_type: "priv"` for private laws) to get the count, the most recent law, and the list — newest first.

## Committees and subcommittees (`committee_leadership`, `committee_members`)

Baked from a SEPARATE public-domain source (github.com/unitedstates/congress-legislators) — neither congress.gov nor GovTrack has a committee-membership or committee-leadership endpoint at all. `data_as_of` on every response is that source's own last-update date.

`committee_members` identifies a committee OR a subcommittee by `committee_id` (exact) or by `name`. Name search (fleet #3203, 2026-10-16) looks at SUBCOMMITTEE names too, not just the ~230 top-level committees — "Cybersecurity" alone finds the Senate Armed Services Subcommittee on Cybersecurity (SSAS21) directly, and so does the fuller "Senate Armed Services Subcommittee on Cybersecurity" (disambiguating it from House Armed Services' own Cyber-named subcommittee). Matching is word-token (every query word must appear in, or be a prefix/suffix of, a candidate word) and exact-first ranked: an unambiguous exact name match wins outright even when several looser matches exist, and those are disclosed as `alternatives` rather than silently dropped. A name that matches only the PARENT committee (no subcommittee) is returned as the committee, with `parent_only_match: true` and a note — never presented as if it were a more specific subcommittee. A subcommittee's own record always names its parent separately (`parent_committee_id`/`parent_committee_name`); its `chair`/`ranking_member` are its OWN, resolved from its own roster, never the parent's.

## Roll-call votes (`get_votes`) — two sources, one tool

(fleet #3183, 2026-10-16 — follow-up to #3164, which left this tool refusing outright.) Pass `chamber: "house"` or `"senate"`; the two chambers number their roll-call votes independently, so there is no single combined listing.

- **House** — the Clerk of the House's own roll-call vote records, via congress.gov's official API. Requires the same API key as the rest of this pack.
- **Senate** — the Secretary of the Senate's own published roll-call vote records (senate.gov), public and keyless. Dates in the source are day-month only ("18-Dec"); this pack reconstructs the year from the source's own per-session header.

Every response names its own `chamber`, `congress`, `session` and `source`. Omit `congress`/`session` for the CURRENT session; `session` (1 or 2 — each Congress has exactly two, one per calendar year) can only be inferred for the current Congress — naming a different, past Congress without a session is a named argument error, not a guess. A chamber/congress/session nothing has been published for returns a named reason, never a silent empty list.

An "en bloc" Senate vote (several nominees confirmed together, e.g. under a standing order) has no single `question`/`issue` of its own — `question` becomes "En bloc confirmation of N matters" and `en_bloc_matter_count` carries the count, rather than silently reporting one nominee's own question as if it were the whole vote's.

`total` (House) is congress.gov's own session vote count (`pagination.count`), the same at any `limit` — the House list endpoint carries no sort and this pack fetches/re-ranks only enough rows to satisfy `limit`, so `total` is read from the API's own count, never backfilled from however many rows this one call happened to fetch (fleet #3215). If congress.gov ever omits that count, `total` is left out entirely with a `note`, rather than silently reporting the fetched-row count as the real total. `other_votes` was dropped from House vote records (fleet #3215) — it was a sum of `present_votes` + `not_voting` that, on every observed live vote, read identically to `not_voting` alone (present votes are rare); sum the two yourself if you want that figure.

House votes are NOT read from the list endpoint at all, at any offset — confirmed live, 2026-10-17: even a page fetched from the TAIL of the list (an earlier attempt at this fix) can have holes (one real session's `limit:10` came back `314..307, 304, 303` — rolls 306 and 305 were simply missing from that page). House roll-call numbers are sequential 1..`pagination.count` within a session, so the newest votes are addressed DIRECTLY by number (`count`, `count-1`, ...) via the single-vote detail endpoint — no list page, no jitter, no holes. This is capped at **25 per call** for House (each vote costs its own upstream request); a higher `limit` is clamped with a note. A roll number congress.gov has no record of (vacated/stricken and never reused) is skipped and named in `note` — `total` itself is unaffected, since it already comes from `pagination.count`, not from counting what was successfully fetched.

## Congress numbering

Congresses are numbered sequentially: 119th Congress = 2025-2027 (started Jan 2025), 118th = 2023-2025, etc. Bills carry their Congress number — `HR1` of the 119th is a different bill than `HR1` of the 118th.

## Bill type prefixes

| Prefix | What it is | Chamber |
|---|---|---|
| HR | House Bill | House |
| HRES | House Resolution (procedural) | House |
| HJRES | House Joint Resolution | House |
| HCONRES | House Concurrent Resolution | House |
| S | Senate Bill | Senate |
| SRES | Senate Resolution | Senate |
| SJRES | Senate Joint Resolution | Senate |
| SCONRES | Senate Concurrent Resolution | Senate |

For "regular legislation" purposes, HR and S are the meaningful types. Resolutions don't have force of law (HRES, SRES) or are limited (HJRES, SJRES — the latter can amend the Constitution if ratified).

## Common pitfalls

- **Bill status nuance.** "Introduced" is the start. "Reported" by committee is meaningful progress. "Engrossed" / "passed chamber" matters. "Enrolled" / "presented to president" is near-final. Most bills die quietly in committee; "introduced" alone is weak signal. `status_label` on each bill is congress.gov's free-text `latestAction`, not a coded status — read it rather than pattern-matching it.
- **Companion bills.** Identical legislation often introduced in both chambers as paired bills (HR 1234 + S 567). Both must pass.
- **Roll-call votes only.** `get_votes` covers recorded roll calls — many congressional decisions happen by voice vote or unanimous consent and never appear in either chamber's roll-call records at all.
- **Committee referrals.** A bill can be referred to multiple committees (sequential, joint, or split). It must clear all to advance. The committee structure matters more than the introduction.
- **Cosponsorship is cheap.** Members cosponsor freely. A 100-cosponsor bill is meaningful; a 5-cosponsor bill in a 435-member House isn't necessarily.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "congress": {
      "url": "https://gateway.pipeworx.io/congress/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/congress/mcp` returns the tools in the table
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
curl -X POST https://gateway.pipeworx.io/v1/tools/congress_search_bills \
  -H 'Content-Type: application/json' \
  -d '{"query":"Lower Energy Costs Act","limit":10}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/congress_search_bills`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "congress": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-congress"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-congress
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Congress data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
