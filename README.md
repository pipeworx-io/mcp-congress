# Congress.gov — Bills, Votes, Members

The Library of Congress's Congress.gov API. Bills (House and Senate), members of Congress, committees, votes, congressional records, treaties. The authoritative source for "what's happening on Capitol Hill" — bill status, who voted what, who sponsors what. Free, requires a free API key.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Why this matters for AI agents

For policy research, agents need to know what bills exist, who's sponsoring them, where they are in the legislative process, and how votes broke. Congress.gov is the canonical record. Pair with [Federal Register](/docs/reference/federal-register) (rules implementing legislation) and [USAspending](/docs/reference/usaspending) (where the money goes after authorization).

Common flows:

- **Bill search.** "What bills are pending on AI regulation?" → search by keyword, filter by Congress and chamber.
- **Bill detail.** "Status of HR 9876?" → get full bill record with sponsor, cosponsors, committee referrals, recent action.
- **Member lookup.** "Who represents Colorado's 1st district?" → member by state/district or by name.
- **Vote tracking.** Recorded votes by bill, member, or session.

## Auth

Congress.gov requires a free API key from https://api.congress.gov/sign-up/. Pass via `_apiKey`. Generous rate limits.

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

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

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
