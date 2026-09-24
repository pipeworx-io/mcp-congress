# US Congress — Bills, Votes, Members (GovTrack)

US federal bills (House and Senate), members of Congress and roll-call votes, served from GovTrack's public API (`www.govtrack.us/api/v2`), which mirrors the Library of Congress record from the 93rd Congress (1973) onward. Bill status, who voted what, who sponsors what. Free, no API key.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1679+ live data sources.

## Why this matters for AI agents

For policy research, agents need to know what bills exist, who's sponsoring them, where they are in the legislative process, and how votes broke. Congress.gov is the canonical record. Pair with [Federal Register](/docs/reference/federal-register) (rules implementing legislation) and [USAspending](/docs/reference/usaspending) (where the money goes after authorization).

Common flows:

- **Bill search.** "What bills are pending on AI regulation?" → search by keyword, filter by Congress and chamber.
- **Bill detail.** "Status of HR 9876?" → get full bill record with sponsor, cosponsors, committee referrals, recent action.
- **Member lookup.** "Who represents Colorado's 1st district?" → member by state/district or by name.
- **Vote tracking.** Recorded votes by bill, member, or session.

## Auth

None. GovTrack's API is public and keyless; this pack sends no credential.

## Search ranking (`search_bills`)

GovTrack's `q` parameter is a loose keyword match with no relevance ordering — for "Lower Energy Costs Act" it reports ~4,300 matches and puts a 2014 salmon bill first, while H.R. 1 (118th), the bill literally so named, sits 86th inside its own Congress's matches and beyond the 1,000-row offset GovTrack allows. `order_by=relevance` is rejected. So `search_bills` gathers candidates itself and ranks them locally:

- **Candidates.** One unfiltered page (100 rows) plus one page for each of the three most recent Congresses. If nothing yet contains the query phrase, it pages deeper into those Congresses (up to 300 rows each), then takes one page from each of the six Congresses before them. Pass `congress` to search a single Congress exhaustively (up to ~1,100 rows) — do this for a bill older than about six years.
- **Ranking.** Every title a bill has ever carried (display, short, short-partial, official) is scored: exact title, then a title containing the phrase (shorter wins), then all query words present (prefix-tolerant, so "lower" matches "Lowering"), then partial overlap. Ties go to the newer Congress. Each returned bill carries `match` (`exact` / `phrase` / `all_words` / `partial` / `none`) and `matched_title`.
- **`total`** is GovTrack's loose-match count, not the number of bills about the subject; `total_note` says so in the payload, and `ranking` states that upstream order was not used.

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

- **Bill status nuance.** "Introduced" is the start. "Reported" by committee is meaningful progress. "Engrossed" / "passed chamber" matters. "Enrolled" / "presented to president" is near-final. Most bills die quietly in committee; "introduced" alone is weak signal.
- **Companion bills.** Identical legislation often introduced in both chambers as paired bills (HR 1234 + S 567). Both must pass. The Congress.gov API has cross-references; use them.
- **Roll-call votes only.** Many congressional decisions happen by voice vote or unanimous consent. Those don't appear in roll-call records. "No vote against" doesn't mean unanimous support.
- **Committee referrals.** A bill can be referred to multiple committees (sequential, joint, or split). It must clear all to advance. The committee structure matters more than the introduction.
- **Member-vote alignment.** Don't equate "voted yes" with "supports." Procedural votes (motion to recommit, cloture) often have substantive meaning that surface text doesn't capture.
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

Both URLs reach the same gateway and the same 1679+ data sources. The
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
