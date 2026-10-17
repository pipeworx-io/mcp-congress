interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
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
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Congress MCP — US Congress bill/law/member data via the official
 * congress.gov API (Library of Congress, api.data.gov-fronted) plus
 * committee rosters/leadership baked from a second, public-domain source.
 *
 * Tools:
 * - search_bills: Search congressional bills by name, subject or keyword — GovInfo (GPO) full-text search over bill text, locally re-ranked by title match
 * - get_bill: Get a single bill by congress + bill type + number, from congress.gov
 * - get_public_laws: Public (or private) laws enacted in one Congress, from congress.gov
 * - get_members: Get current members of Congress, from congress.gov
 * - get_votes: NOT AVAILABLE — see note below
 * - get_recent_bills: Most recently introduced / acted-on bills, from congress.gov
 * - committee_leadership: every standing committee in a chamber with its chair + ranking member
 * - committee_members: one committee's full roster (party, rank, chair/ranking title)
 * - member_committees: one member's committee assignments by bioguide id
 *
 * MIGRATION OFF GOVTRACK (fleet #3164, 2026-10-16): govtrack.us now answers
 * EVERY endpoint — /bill, /role, /vote — with a Cloudflare "Just a moment..."
 * challenge page served as HTTP 403, confirmed live on all of search_bills,
 * get_bill, get_members, get_recent_bills. Per standing policy we do not
 * evade a bot wall (no UA spoofing, no proxies, no IP rotation), so this pack
 * now calls the official sources instead:
 *   - congress.gov (api.congress.gov/v3) for get_bill, get_recent_bills,
 *     get_public_laws and get_members — the Library of Congress's own API.
 *   - GovInfo (api.govinfo.gov), the GPO's full-text search over the BILLS
 *     collection, for search_bills — congress.gov's own /bill endpoint has NO
 *     free-text query parameter (browsing/filtering only), so a keyword
 *     search has no congress.gov equivalent; GovInfo is the GPO's official
 *     full-text index of the same bill documents and is what congress.gov's
 *     own search box uses.
 * Both are api.data.gov-umbrella APIs — the SAME key authenticates both
 * (reference_datagov_key_universal) — injected automatically as `_apiKey`
 * when this pack is wired with `platformKeyEnv: 'PLATFORM_DATAGOV_KEY'` in
 * the gateway manifest (already backing 15+ other federal packs; no new
 * secret was minted for this).
 *
 * get_votes is NOT migrated and now fails fast with an explicit "not
 * available" error instead of making a dead round-trip to GovTrack: the
 * official congress.gov API has no roll-call-vote endpoint covering BOTH
 * chambers (only a House-only one), so a partial replacement would silently
 * drop every Senate vote behind a clean 200 — worse than the current loud
 * failure. Left as a known gap for a follow-up task.
 *
 * COMMITTEE DATA (fleet #2843): neither congress.gov nor GovTrack has a
 * committee-membership or committee-leadership endpoint at all, so
 * committee_leadership/committee_members/member_committees are baked from a
 * SEPARATE source — github.com/unitedstates/congress-legislators
 * (committees-current.yaml, committee-membership-current.yaml,
 * legislators-current.yaml), CC0 1.0 Universal ("no rights reserved" per
 * that repo's own LICENSE, verified live). Refreshed by
 * scripts/refresh-congress-committees.mjs into ./committee-index-data.ts,
 * which is NEVER value-imported here (fleet #2754 — a baked table as a
 * static import blew the gateway bundle 24.4->37.8MiB and caused edge 1102s
 * on ~1/4 of requests) — it is registered in
 * workers/gateway/src/pack-baked-indexes.json, uploaded to KV at deploy, and
 * injected as `args._bakedIndex` on every call into this pack. This data
 * changes on a committee-reshuffle cadence, not daily; `data_as_of` on every
 * response is the source files' own last-commit date, not "now".
 */

import type {
  CommitteeRow,
  CommitteeSubcommitteeRow,
  CommitteeMemberRow,
  MemberCommitteeAssignment,
  MemberProfile,
} from './committee-index-data.js';

// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Congress');
}

// --- congress.gov (official, api.data.gov-fronted) ---
const CONGRESS_GOV_BASE = 'https://api.congress.gov/v3';
// --- GovInfo (GPO), used ONLY for search_bills's full-text keyword search ---
const GOVINFO_SEARCH_URL = 'https://api.govinfo.gov/search';
// --- Senate.gov (official, public, keyless) — used ONLY for get_votes's Senate side ---
const SENATE_VOTE_MENU_BASE = 'https://www.senate.gov/legislative/LIS/roll_call_lists';

// Workers have no DOMParser; this XML is small and flat/regular (same
// approach as mcps/faa-delays, mcps/edgar's Form 4 parsing).
function xmlTag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1].trim() : null;
}
function xmlBlocks(xml: string, name: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.push(m[1]);
  return out;
}

const API_KEY_HINT =
  'Pass a free api.data.gov key as `_apiKey` (https://api.data.gov/signup/) — the same key ' +
  'authenticates both congress.gov and GovInfo. Called through the Pipeworx gateway this is ' +
  'supplied automatically and this message should not be reachable there.';

/** Every GovTrack-era tool now requires an API key; say so plainly rather than calling out keyless and failing on a cryptic 403. */
function requireApiKey(args: Record<string, unknown>): string {
  const key = typeof args._apiKey === 'string' && args._apiKey.trim() ? args._apiKey.trim() : undefined;
  if (!key) {
    throw new Error(`congress: this tool requires an API key. ${API_KEY_HINT}`);
  }
  return key;
}

function congressGovUrl(path: string, params: Record<string, string | number | undefined>, apiKey: string): string {
  const url = new URL(CONGRESS_GOV_BASE + path);
  url.searchParams.set('format', 'json');
  url.searchParams.set('api_key', apiKey);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  }
  return url.toString();
}

async function congressGovFetch<T>(
  path: string,
  params: Record<string, string | number | undefined>,
  apiKey: string,
): Promise<T> {
  const res = await pwFetch(congressGovUrl(path, params, apiKey));
  if (!res.ok) throw await httpError(res, 'congress.gov API error');
  return parseJson<T>(res, 'congress.gov');
}

type GovInfoSearchResult = {
  title?: string | null;
  packageId?: string | null;
  dateIssued?: string | null;
  governmentAuthor?: string[] | null;
};

type GovInfoSearchResponse = {
  count?: number | null;
  results?: GovInfoSearchResult[] | null;
};

/** `BILLS-119hr1ih` -> {congress:119, billType:'hr', number:1, version:'ih'} */
function parsePackageId(id: string): { congress: number; billType: string; number: number; version: string } | null {
  const m = /^BILLS-(\d+)([a-z]+)(\d+)([a-z]+)$/.exec(id);
  if (!m) return null;
  return { congress: Number(m[1]), billType: m[2], number: Number(m[3]), version: m[4] };
}

async function govInfoSearchBills(query: string, apiKey: string, pageSize: number): Promise<GovInfoSearchResponse> {
  const url = new URL(GOVINFO_SEARCH_URL);
  url.searchParams.set('api_key', apiKey);
  const res = await pwFetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `collection:BILLS AND ${query}`,
      pageSize: Math.min(Math.max(1, pageSize), 100),
      offsetMark: '*',
      sorts: [{ field: 'relevancy', sortOrder: 'DESC' }],
    }),
  });
  if (!res.ok) throw await httpError(res, 'GovInfo search error');
  return parseJson<GovInfoSearchResponse>(res, 'GovInfo');
}

// --- Raw API types (congress.gov) ---

type RawCongressBill = {
  congress?: number | null;
  type?: string | null;
  number?: string | null;
  title?: string | null;
  originChamber?: string | null;
  introducedDate?: string | null;
  updateDate?: string | null;
  legislationUrl?: string | null;
  latestAction?: { actionDate?: string | null; text?: string | null } | null;
  sponsors?: Array<{
    bioguideId?: string | null;
    fullName?: string | null;
    party?: string | null;
    state?: string | null;
  }> | null;
  laws?: Array<{ number?: string | null; type?: string | null }> | null;
};

type CongressGovListResponse<T> = {
  bills?: T[] | null;
  members?: T[] | null;
  pagination?: { count?: number | null } | null;
};

type RawCongressMember = {
  bioguideId?: string | null;
  name?: string | null;
  partyName?: string | null;
  state?: string | null;
  district?: number | null;
  terms?: { item?: Array<{ chamber?: string | null; startYear?: number | null }> } | null;
  url?: string | null;
};

// --- Formatters ---

/** Shape-compatible with the old GovTrack-era `formatBill` output (same keys), so existing callers keep working — `status`/`status_label` now carry congress.gov's free-text `latestAction` since congress.gov has no coded status like GovTrack's `current_status`. */
function formatCongressBill(b: RawCongressBill) {
  const typeLower = (b.type ?? '').toLowerCase();
  return {
    id: null,
    bill_type: typeLower || null,
    bill_type_label: BILL_TYPE_LABELS[typeLower] ?? b.type ?? null,
    number: b.number != null ? Number(b.number) : null,
    congress: b.congress ?? null,
    title: b.title ?? null,
    title_without_number: b.title ?? null,
    status: null,
    status_label: b.latestAction?.text ?? null,
    status_date: b.latestAction?.actionDate ?? null,
    introduced_date: b.introducedDate ?? null,
    sponsor_name: b.sponsors?.[0]?.fullName ?? null,
    became_law: b.laws && b.laws.length > 0 ? b.laws[0] : null,
    link: b.legislationUrl ?? null,
  };
}

function formatCongressMember(m: RawCongressMember) {
  const latestTerm = m.terms?.item?.[m.terms.item.length - 1];
  return {
    bioguide_id: m.bioguideId ?? null,
    name: m.name ?? null,
    party: m.partyName ?? null,
    state: m.state ?? null,
    district: m.district ?? null,
    chamber: latestTerm?.chamber ?? null,
    term_start_year: latestTerm?.startYear ?? null,
    congress_gov_api_url: m.url ?? null,
  };
}

// --- Baked committee index (fleet #2843) ---
//
// NEVER value-import ./committee-index-data.js here — the type-only import
// above is erased from the bundle; a value import is not (same trap as
// mcps/arkansas-code/src/index.ts's AR_SECTIONS, fleet #2754).
let COMMITTEES: CommitteeRow[] = [];
let COMMITTEE_MEMBERSHIP: Record<string, CommitteeMemberRow[]> = {};
let MEMBER_COMMITTEES: Record<string, MemberCommitteeAssignment[]> = {};
let MEMBER_PROFILES: Record<string, MemberProfile> = {};
let CONGRESS_DATA_AS_OF = '';
let COMMITTEE_INDEX_LOADED = false;

function ensureCommitteeIndex(args: Record<string, unknown>): void {
  if (COMMITTEE_INDEX_LOADED) return;
  const idx = args._bakedIndex as Record<string, unknown> | null | undefined;
  const committees = idx?.COMMITTEES;
  const membership = idx?.COMMITTEE_MEMBERSHIP;
  const memberCommittees = idx?.MEMBER_COMMITTEES;
  const memberProfiles = idx?.MEMBER_PROFILES;
  const dataAsOf = idx?.CONGRESS_DATA_AS_OF;
  const ok =
    Array.isArray(committees) &&
    committees.length > 0 &&
    typeof membership === 'object' &&
    membership !== null &&
    typeof memberCommittees === 'object' &&
    memberCommittees !== null &&
    typeof memberProfiles === 'object' &&
    memberProfiles !== null &&
    typeof dataAsOf === 'string' &&
    dataAsOf.length > 0;
  if (!ok) {
    // Loud on purpose, same posture as ar-code's ensureIndex: a missing or
    // malformed baked index is a server-side KV fault, not "no committees
    // exist" — collapsing the two would be exactly the silent-empty-array
    // trap docs/silent-zero-policy.md holds every pack to.
    throw new Error(
      `congress: the baked committee index is unavailable (${idx == null ? 'not injected' : 'malformed'}). ` +
        'The gateway loads it from KV on the first call into committee_leadership/committee_members/member_committees; ' +
        'this is a server-side fault, not an empty roster — retry shortly. search_bills/get_bill/get_members/get_recent_bills/get_public_laws are unaffected (they call congress.gov/GovInfo live and never touch this index).',
    );
  }
  COMMITTEES = committees as CommitteeRow[];
  COMMITTEE_MEMBERSHIP = membership as Record<string, CommitteeMemberRow[]>;
  MEMBER_COMMITTEES = memberCommittees as Record<string, MemberCommitteeAssignment[]>;
  MEMBER_PROFILES = memberProfiles as Record<string, MemberProfile>;
  CONGRESS_DATA_AS_OF = dataAsOf;
  COMMITTEE_INDEX_LOADED = true;
}

const VALID_CHAMBERS = new Set(['house', 'senate', 'joint']);

/**
 * Chair/ranking member resolution: prefer the explicit title (handles
 * "Chair"/"Chairman"/"Chairwoman" and "Ranking Member"); fall back to
 * majority/minority rank 1 for the handful of caucuses and select
 * committees (e.g. the Senate Intelligence/Ethics committees, the Joint
 * Commission on Security and Cooperation in Europe) that the source data
 * does not label with an explicit title.
 */
function resolveLeadership(members: CommitteeMemberRow[]): {
  chair: CommitteeMemberRow | null;
  ranking_member: CommitteeMemberRow | null;
} {
  const chair =
    members.find((m) => typeof m.title === 'string' && /^Chair/i.test(m.title)) ??
    members.find((m) => m.party_role === 'majority' && m.rank === 1) ??
    null;
  const ranking =
    members.find((m) => m.title === 'Ranking Member') ??
    members.find((m) => m.party_role === 'minority' && m.rank === 1) ??
    null;
  return { chair, ranking_member: ranking };
}

/** Words that appear in nearly every committee name and carry no identifying signal. */
const COMMITTEE_NAME_STOPWORDS = new Set([
  'house', 'senate', 'joint', 'committee', 'committees', 'on', 'the', 'select',
  'permanent', 'special', 'of', 'congress', 'united', 'states', 'us', 'subcommittee',
  'and', 'for',
]);

function normalizeCommitteeName(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !COMMITTEE_NAME_STOPWORDS.has(w));
}

type NameMatchTier = 'exact' | 'all_words' | 'none';
const TIER_RANK: Record<NameMatchTier, number> = { exact: 0, all_words: 1, none: 2 };

/**
 * Word-token match: every query word must appear in (or be a prefix/suffix
 * of) a candidate word — 'exact' when that coverage is mutual (same word
 * COUNT, every candidate word also matched by some query word), 'all_words'
 * when the query is fully covered but the candidate has extra words (or vice
 * versa isn't checked — covered is query-into-candidate only).
 */
function nameMatchTier(qWords: string[], cWords: string[]): NameMatchTier {
  if (qWords.length === 0 || cWords.length === 0) return 'none';
  const matches = (a: string, b: string) => a === b || a.startsWith(b) || b.startsWith(a);
  const covered = qWords.every((w) => cWords.some((cw) => matches(cw, w)));
  if (!covered) return 'none';
  if (qWords.length !== cWords.length) return 'all_words';
  const reverseCovered = cWords.every((w) => qWords.some((qw) => matches(qw, w)));
  return reverseCovered ? 'exact' : 'all_words';
}

type CommitteeCandidate =
  | { kind: 'committee'; committee: CommitteeRow; tier: NameMatchTier }
  | { kind: 'subcommittee'; committee: CommitteeRow; sub: CommitteeSubcommitteeRow; tier: NameMatchTier };

/**
 * Word-token name search over BOTH committees and their subcommittees
 * (fleet #3203) — this used to look only at the ~230 top-level committee
 * names, so "Cybersecurity" (Senate Armed Services' Subcommittee on
 * Cybersecurity, SSAS21) came back `found: false` even though the data has
 * it, and a caller that then asked for "the chair" got the FULL committee's
 * chair (Wicker) — a wrong answer wearing a clean response, not a crash.
 *
 * Each subcommittee is scored against TWO strings and the BETTER tier is
 * kept: its own bare name ("Cybersecurity"), and its full name combined with
 * its parent committee's ("Senate Committee on Armed Services Subcommittee
 * on Cybersecurity"). The combined form lets a caller who names BOTH the
 * committee and the subcommittee ("Senate Armed Services Subcommittee on
 * Cybersecurity") land on the one subcommittee whose PARENT is also Armed
 * Services, rather than a same-named subcommittee under a different
 * committee (House Armed Services has a Cyber-named subcommittee too).
 *
 * Exact-first ranking (same shape as fleet #3169/#3193): a name that is
 * EXACTLY the subcommittee's own name ("Cybersecurity" == "Cybersecurity")
 * ranks above one that merely contains every query word among extra words
 * ("Cybersecurity, Information Technology, and Government Innovation" also
 * contains "cybersecurity") — so one unambiguous exact match wins outright
 * even when several looser matches exist, and those looser ones are
 * returned as `alternatives` rather than silently dropped or forcing an
 * `ambiguous` branch they do not belong in.
 */
function findCommitteeCandidates(name: string, chamber: string | undefined): CommitteeCandidate[] {
  const qWords = normalizeCommitteeName(name);
  if (qWords.length === 0) return [];
  const out: CommitteeCandidate[] = [];
  for (const c of COMMITTEES) {
    if (chamber && c.chamber !== chamber) continue;
    const parentWords = normalizeCommitteeName(c.name);
    const committeeTier = nameMatchTier(qWords, parentWords);
    if (committeeTier !== 'none') out.push({ kind: 'committee', committee: c, tier: committeeTier });
    // The combined (parent + sub) form is only useful when the query has
    // content the PARENT's own name does not already explain — otherwise
    // every one of a matched committee's subcommittees would inherit the
    // same coverage via the parent's words baked into the combined string,
    // producing a false tie between the committee and ALL of its
    // subcommittees for a query that only ever named the committee (e.g.
    // "Ways" matching House Ways and Means all_words-ties every one of its
    // 6 subcommittees too, since "Ways and Means Subcommittee on X" still
    // contains "ways"). Skipping the combined form here, not the bare one,
    // is what lets a bare committee-level query resolve to the committee
    // alone.
    const parentCoversQuery = qWords.every((w) => parentWords.some((pw) => pw === w || pw.startsWith(w) || w.startsWith(pw)));
    for (const sub of c.subcommittees) {
      const bareTier = nameMatchTier(qWords, normalizeCommitteeName(sub.name));
      const combinedTier = parentCoversQuery
        ? 'none'
        : nameMatchTier(qWords, normalizeCommitteeName(`${c.name} Subcommittee on ${sub.name}`));
      const tier = TIER_RANK[bareTier] <= TIER_RANK[combinedTier] ? bareTier : combinedTier;
      if (tier !== 'none') out.push({ kind: 'subcommittee', committee: c, sub, tier });
    }
  }
  return out.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier]);
}

/** A short, labelled summary of a candidate for `alternatives`/`matches` arrays — never the full roster, so disclosing an alternative does not cost another full payload. */
function candidateSummary(cand: CommitteeCandidate): Record<string, unknown> {
  if (cand.kind === 'committee') {
    return { kind: 'committee', id: cand.committee.id, name: cand.committee.name, chamber: cand.committee.chamber };
  }
  return {
    kind: 'subcommittee',
    id: cand.sub.id,
    name: `${cand.committee.name} Subcommittee on ${cand.sub.name}`,
    chamber: cand.committee.chamber,
    parent_committee_id: cand.committee.id,
  };
}

function findCommitteeById(id: string): CommitteeRow | undefined {
  const norm = id.trim().toUpperCase();
  return COMMITTEES.find((c) => c.id.toUpperCase() === norm);
}

function buildFullCommittee(c: CommitteeRow) {
  const members = COMMITTEE_MEMBERSHIP[c.id] ?? [];
  const { chair, ranking_member } = resolveLeadership(members);
  return {
    id: c.id,
    name: c.name,
    chamber: c.chamber,
    url: c.url,
    minority_url: c.minority_url,
    jurisdiction: c.jurisdiction,
    chair,
    ranking_member,
    member_count: members.length,
    members,
    subcommittees: c.subcommittees,
  };
}

/**
 * The subcommittee's OWN chair/ranking member, resolved from ITS OWN
 * membership roster (`COMMITTEE_MEMBERSHIP[sub.id]`) — never the parent
 * committee's. `parent_committee_id`/`parent_committee_name` name the parent
 * as separate fields so nothing downstream can mistake one for the other
 * (fleet #3203 — this was the bug: a caller who could not find the
 * subcommittee by name fell back to the FULL committee and its chair, which
 * `buildFullCommittee` never claims to be a subcommittee, but a name search
 * that returned the parent silently, under a question shaped like a
 * subcommittee lookup, let the wrong attribution happen one level up).
 */
function buildSubcommittee(c: CommitteeRow, sub: CommitteeSubcommitteeRow) {
  const members = COMMITTEE_MEMBERSHIP[sub.id] ?? [];
  const { chair, ranking_member } = resolveLeadership(members);
  return {
    id: sub.id,
    name: `${c.name} Subcommittee on ${sub.name}`,
    chamber: c.chamber,
    parent_committee_id: c.id,
    parent_committee_name: c.name,
    chair,
    ranking_member,
    member_count: members.length,
    members,
  };
}

function committeeLeadership(args: Record<string, unknown>) {
  ensureCommitteeIndex(args);
  const chamberArg = typeof args.chamber === 'string' ? args.chamber.trim().toLowerCase() : undefined;
  if (chamberArg && !VALID_CHAMBERS.has(chamberArg)) {
    return { error: `chamber must be "house", "senate" or "joint" — got ${JSON.stringify(args.chamber)}`, chamber: args.chamber ?? null };
  }
  const committees = COMMITTEES.filter((c) => !chamberArg || c.chamber === chamberArg);
  return {
    chamber: chamberArg ?? 'all',
    congress: 119,
    data_as_of: CONGRESS_DATA_AS_OF,
    source: 'github.com/unitedstates/congress-legislators (public domain, CC0 1.0 Universal)',
    total: committees.length,
    committees: committees.map((c) => {
      const members = COMMITTEE_MEMBERSHIP[c.id] ?? [];
      const { chair, ranking_member } = resolveLeadership(members);
      return {
        id: c.id,
        name: c.name,
        chamber: c.chamber,
        url: c.url,
        chair,
        ranking_member,
        member_count: members.length,
      };
    }),
  };
}

function committeeMembers(args: Record<string, unknown>) {
  ensureCommitteeIndex(args);
  const chamberArg = typeof args.chamber === 'string' ? args.chamber.trim().toLowerCase() : undefined;
  if (chamberArg && !VALID_CHAMBERS.has(chamberArg)) {
    return { error: `chamber must be "house", "senate" or "joint" — got ${JSON.stringify(args.chamber)}`, chamber: args.chamber ?? null };
  }
  const idArg = typeof args.committee_id === 'string' && args.committee_id.trim() ? args.committee_id.trim() : undefined;
  const nameArg = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : undefined;
  if (!idArg && !nameArg) {
    return { error: 'Pass committee_id (e.g. "HSWM") or name (e.g. "Ways and Means", "Appropriations") — call committee_leadership first to see every valid id/name.' };
  }

  if (idArg) {
    const top = findCommitteeById(idArg);
    if (top) return { data_as_of: CONGRESS_DATA_AS_OF, ...buildFullCommittee(top) };
    for (const c of COMMITTEES) {
      const sub = c.subcommittees.find((s) => s.id.toUpperCase() === idArg.toUpperCase());
      if (sub) return { data_as_of: CONGRESS_DATA_AS_OF, ...buildSubcommittee(c, sub) };
    }
    return {
      found: false,
      error: `No committee or subcommittee with id "${idArg}". Call committee_leadership to list valid ids.`,
      committee_id: idArg,
    };
  }

  // Name search over BOTH committees and subcommittees, exact-first ranked
  // (fleet #3203 — see findCommitteeCandidates).
  const candidates = findCommitteeCandidates(nameArg!, chamberArg);
  if (candidates.length === 0) {
    return {
      found: false,
      error: `No committee or subcommittee name matched "${nameArg}"${chamberArg ? ` in the ${chamberArg}` : ''}. Try a shorter name (e.g. "Appropriations", "Judiciary", "Ways and Means"), or pass chamber to disambiguate.`,
      name: nameArg,
    };
  }

  const topTier = candidates[0].tier;
  const top = candidates.filter((cand) => cand.tier === topTier);
  const rest = candidates.filter((cand) => cand.tier !== topTier);

  if (top.length > 1) {
    // True ambiguity — more than one committee/subcommittee is an equally
    // good match (e.g. bare "Appropriations" names both chambers' committee
    // exactly). Return every tied candidate's FULL record, same shape as
    // before this fix, now drawn from the unified committee+subcommittee pool.
    return {
      data_as_of: CONGRESS_DATA_AS_OF,
      ambiguous: true,
      note:
        `"${nameArg}" matched ${top.length} committees/subcommittees equally well` +
        (topTier === 'exact' ? ' (all by an exact name match)' : '') +
        ' — pass chamber, or call again by committee_id, to pick one.',
      matches: top.map((cand) =>
        cand.kind === 'committee'
          ? { data_as_of: CONGRESS_DATA_AS_OF, ...buildFullCommittee(cand.committee) }
          : { data_as_of: CONGRESS_DATA_AS_OF, ...buildSubcommittee(cand.committee, cand.sub) },
      ),
    };
  }

  const winner = top[0];
  const record =
    winner.kind === 'committee'
      ? { data_as_of: CONGRESS_DATA_AS_OF, ...buildFullCommittee(winner.committee) }
      : { data_as_of: CONGRESS_DATA_AS_OF, ...buildSubcommittee(winner.committee, winner.sub) };

  // "A name that matches only a parent must say so" (fleet #3203): the
  // winner is the PARENT committee itself, but the query had word(s) its own
  // name doesn't cover (tier all_words, not exact) — the caller likely meant
  // a more specific subcommittee that does not exist under that name. Say so
  // explicitly rather than silently handing back the parent's own chair under
  // a question shaped like a narrower one.
  const parentOnlyNote =
    winner.kind === 'committee' && winner.tier === 'all_words'
      ? `"${nameArg}" matched only the parent committee "${winner.committee.name}" — no subcommittee name matched it as well or better. ` +
        'See this response\'s `subcommittees` list for the valid subcommittee names/ids under this committee.'
      : null;

  return {
    ...record,
    ...(parentOnlyNote ? { parent_only_match: true, note: parentOnlyNote } : {}),
    ...(rest.length > 0
      ? {
          alternatives: rest.slice(0, 8).map(candidateSummary),
          alternatives_note:
            `${rest.length} other committee(s)/subcommittee(s) also matched every word of "${nameArg}" but less exactly than the result above — ` +
            'listed in case this was not the one you meant; call again with committee_id to get one of these instead.',
        }
      : {}),
  };
}

function memberCommittees(args: Record<string, unknown>) {
  ensureCommitteeIndex(args);
  const bioguide = typeof args.bioguide_id === 'string' ? args.bioguide_id.trim().toUpperCase() : undefined;
  if (!bioguide) {
    return { error: 'Pass bioguide_id — a Congress.gov/GovInfo "bioguide" id, e.g. "N000015" for Richard Neal, "G000386" for Chuck Grassley.' };
  }
  const assignments = MEMBER_COMMITTEES[bioguide];
  if (!assignments || assignments.length === 0) {
    return {
      found: false,
      error: `No committee assignments found for bioguide "${bioguide}". This covers the current (119th) Congress only; check the id is correct and the member currently serves.`,
      bioguide_id: bioguide,
    };
  }
  return {
    data_as_of: CONGRESS_DATA_AS_OF,
    bioguide_id: bioguide,
    profile: MEMBER_PROFILES[bioguide] ?? null,
    total: assignments.length,
    committees: assignments,
  };
}

// --- Tool definitions ---

const tools: McpToolExport['tools'] = [
  {
    name: 'search_bills',
    description:
      'ANSWERS "what bills about X has Congress introduced" / "recent congressional bills on X" / "federal legislation about X" / "find the <Named> Act" — searches US FEDERAL congressional bills (US House & Senate, national laws) BY BILL NAME, SUBJECT OR KEYWORD, including recently introduced ones. Full-text search is via GovInfo (the GPO\'s index of the same bill documents congress.gov itself searches — congress.gov\'s own /bill endpoint has no keyword query at all), then RE-RANKED locally by how well each bill\'s title matches the query — exact title first, then a title containing the phrase, then all query words, then partial overlap — so the first result is the best title match and each bill carries its match tier. Pass `congress` to restrict to one Congress (filtered locally against the search results — may miss a match if it falls outside GovInfo\'s own top results for that query). Prefer this over a date-sorted recent-bills listing whenever the question names a topic or a bill. Returns bill type, number, title, status, sponsor, and introduction date (via congress.gov). Use get_bill with congress + bill_type + number for full details. Requires an API key (see get_bill). NOTE: this is the US Congress (federal) ONLY — for STATE legislature bills (e.g. California, Texas, New York, or any US state legislation) use legiscan or openstates instead, not this tool.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Bill name, keywords or subject to match against bill titles, e.g. "Lower Energy Costs Act" or "crypto"',
        },
        limit: { type: 'number', description: 'Number of results to return (default: 10, max: 100)' },
        congress: {
          type: 'number',
          description: 'Optional Congress number (e.g. 111) to restrict results to, filtered locally against the search results.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_bill',
    description:
      'Look up one congressional bill from congress.gov (the Library of Congress\'s official API) by its real-world identifier — congress number, bill type and bill number, e.g. the 118th Congress H.R. 1. Returns title, sponsor, current status (congress.gov\'s free-text `latestAction`) with its date, introduced date, whether/which law it became, and the congress.gov link. Does NOT return bill text, cosponsors, committee assignments or vote history. Requires an API key: a free api.data.gov key works — supplied automatically when called through the Pipeworx gateway.',
    inputSchema: {
      type: 'object',
      properties: {
        congress: { type: 'number', description: 'Congress number, e.g. 118' },
        bill_type: {
          type: 'string',
          description:
            "Bill type: hr, s, hres, sres, hjres, sjres, hconres or sconres (congress.gov's own short codes). The long GovTrack-era forms (house_bill, senate_bill, ...) and 'h.r.' are also accepted.",
        },
        number: { type: 'number', description: 'Bill number within that congress, e.g. 1 for H.R. 1' },
      },
      required: ['congress', 'bill_type', 'number'],
    },
  },
  {
    name: 'get_public_laws',
    description:
      'ANSWERS "how many public laws has the 119th Congress passed" / "most recent public law" / "list of laws enacted this Congress" — returns public (or private) laws enacted in one Congress, from congress.gov\'s official /law endpoint. GovTrack never had an equivalent endpoint at all. Returns the total count, the most recent law (number, originating bill, title, enactment date), and the list of laws (newest first). Requires an API key (see get_bill).',
    inputSchema: {
      type: 'object',
      properties: {
        congress: { type: 'number', description: 'Congress number, e.g. 119 for the 119th Congress (2025–2026).' },
        law_type: { type: 'string', description: '"pub" (default, public laws) or "priv" (private laws).' },
        limit: { type: 'number', description: 'Number of laws to return (default: 20, max: 100).' },
      },
      required: ['congress'],
    },
  },
  {
    name: 'get_members',
    description:
      'Get current members of Congress with their name, party, state, district (for representatives), chamber and first term-start year, from congress.gov. Requires an API key (see get_bill).',
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
      'ANSWERS "how did the Senate vote on X" / "recent House roll calls" / "cloture vote tally" — recent roll-call votes for ONE chamber, newest first within that chamber + session. House votes come from the Clerk of the House\'s own records (via congress.gov\'s official API); Senate votes come from the Secretary of the Senate\'s own published roll-call vote records (public, no credentials). Pass chamber: "house" or "senate" — the two chambers number their votes independently, so there is no combined listing. Returns question, result, yes/no tallies and date for each vote; every response names its own chamber, congress, session and source. Pass congress + session to look at a specific past session (session can only be left out for the CURRENT Congress); omit both for the current session. A chamber/congress/session nothing has been published for returns a named reason, never a silent empty list.',
    inputSchema: {
      type: 'object',
      properties: {
        chamber: { type: 'string', description: 'Required: "house" or "senate".' },
        congress: { type: 'number', description: 'Congress number, e.g. 119. Omit for the current Congress.' },
        session: {
          type: 'number',
          description:
            '1 or 2 — each Congress has exactly two sessions, one per calendar year. Can be omitted only when congress is also omitted, or is the current Congress (it is then inferred from today\'s date).',
        },
        limit: { type: 'number', description: 'Number of votes to return (default 20, max 100).' },
      },
      required: ['chamber'],
    },
  },
  {
    name: 'get_recent_bills',
    description:
      'List the most recent congressional bills — newest first by introduction date or by latest update — from congress.gov. This tool takes NO subject or keyword: it returns whatever Congress touched most recently, so it can only answer OPEN-ENDED recency questions — "what bills were introduced this week", "latest bills in Congress", "what is Congress working on now", "recent activity on bills". PREFER OVER congress_search_bills for exactly those (it ranks by keyword relevance and surfaces older bills). If the question NAMES a bill, act, or subject — "status of the NDAA", "the defense authorization bill", "bills about crypto" — use congress_search_bills instead, even when it asks for the CURRENT status: a named subject cannot be found in an unfiltered recency list, which is mostly routine post-office namings. Returns bill type, number, title, status, sponsor, and dates. Requires an API key (see get_bill).',
    inputSchema: {
      type: 'object',
      properties: {
        by: {
          type: 'string',
          description: 'Recency basis: "introduced" (default, newest introductions) or "activity" (most recent update / latest action).',
        },
        congress: { type: 'number', description: 'Congress number to filter by (e.g., 119 for 2025–2026). Omit for all.' },
        limit: { type: 'number', description: 'Number of bills to return (default: 20, max: 100)' },
      },
    },
  },
  {
    name: 'committee_leadership',
    description:
      'ANSWERS "who chairs X committee" / "who are the ranking members of every House committee" / "list of committee chairs in Congress" — returns EVERY standing committee in one chamber (or all three chambers) of the 119th Congress with its chair and ranking member (name, party, bioguide id). Pass chamber to scope to "house", "senate" or "joint"; omit it for all three. For one committee\'s FULL roster (every member, not just the chair/ranking pair) use committee_members instead. SOURCE: github.com/unitedstates/congress-legislators (public domain), baked periodically — NOT GovTrack, which has no committee-leadership endpoint at all. data_as_of in the response is the source data\'s own last-update date.',
    inputSchema: {
      type: 'object',
      properties: {
        chamber: { type: 'string', description: '"house", "senate" or "joint". Omit to return every chamber.' },
      },
    },
  },
  {
    name: 'committee_members',
    description:
      'ANSWERS "who is on the House Appropriations committee" / "roster of the Senate Judiciary committee" / "Democratic members of Ways and Means" / "chair of the Armed Services Subcommittee on Cybersecurity" — returns one committee OR SUBCOMMITTEE\'s full membership with each member\'s party, rank and title (Chair / Ranking Member / plain member), plus its own chair and ranking member. Identify it by committee_id (the exact id from committee_leadership, e.g. "HSWM" for House Ways and Means, or a subcommittee id like "SSAS21") OR by name — name matching searches SUBCOMMITTEE names too (bare, e.g. "Cybersecurity", or combined with the parent committee, e.g. "Senate Armed Services Subcommittee on Cybersecurity"), ranked exact-name-first; a looser match is disclosed as `alternatives` rather than silently dropped. A name matching only the parent committee (no subcommittee) is returned as the committee with `parent_only_match: true` and a note — never as if it were the more specific thing you asked for. A name with no chamber that matches equally well in BOTH the House and Senate (e.g. bare "Appropriations") returns both as `matches` rather than guessing; pass chamber to pick one directly. A subcommittee response names its parent separately (`parent_committee_id`/`parent_committee_name`) — its `chair`/`ranking_member` are its OWN, never the parent\'s. For the chair/ranking member of EVERY (top-level) committee at once, use committee_leadership instead — it is cheaper when you do not need the full roster, but does not search subcommittees. SOURCE: github.com/unitedstates/congress-legislators (public domain), baked periodically, current (119th) Congress only.',
    inputSchema: {
      type: 'object',
      properties: {
        committee_id: { type: 'string', description: 'Exact committee or subcommittee id, e.g. "HSWM" (House Ways and Means) or "SSJU" (Senate Judiciary). Takes priority over name.' },
        name: { type: 'string', description: 'Committee name or partial name to search for, e.g. "Appropriations", "Judiciary", "Foreign Affairs".' },
        chamber: { type: 'string', description: 'Optional: "house", "senate" or "joint" — disambiguates a name that matches more than one chamber.' },
      },
    },
  },
  {
    name: 'member_committees',
    description:
      'ANSWERS "what committees is X on" / "committee assignments for Senator X" — returns every committee and subcommittee assignment (committee name, chamber, rank, title) for one member of the 119th Congress, identified by their bioguide id (the standard Congress.gov/GovInfo member identifier, e.g. "N000015" for Richard Neal — committee_leadership and committee_members both return bioguide ids for the members they list, so look a member up there first if you only have a name). SOURCE: github.com/unitedstates/congress-legislators (public domain), baked periodically, current Congress only.',
    inputSchema: {
      type: 'object',
      properties: {
        bioguide_id: { type: 'string', description: 'The member\'s bioguide id, e.g. "N000015".' },
      },
      required: ['bioguide_id'],
    },
  },
];

// --- callTool dispatcher ---

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_bills':
      return searchBills(args);
    case 'get_bill':
      return getBill(args);
    case 'get_public_laws':
      return getPublicLaws(args);
    case 'get_members':
      return getMembers(args);
    case 'get_votes':
      return getVotes(args);
    case 'get_recent_bills':
      return getRecentBills(args);
    case 'committee_leadership':
      return committeeLeadership(args);
    case 'committee_members':
      return committeeMembers(args);
    case 'member_committees':
      return memberCommittees(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- Tool implementations ---

// --- search_bills: GovInfo full-text search + local title re-ranking ---
//
// congress.gov's own /bill endpoint has NO free-text query parameter — it is
// browse/filter only (congress, bill type, date range, sort), confirmed live
// against its OpenAPI-documented parameters (fleet #3164). A Congress holds
// ~20,000 bills, so there is no way to find one by keyword through that
// endpoint short of paging through nearly all of them. GovInfo
// (api.govinfo.gov), the GPO's full-text index of the same bill documents —
// what congress.gov's own search box is built on — DOES support a query, so
// that is what this calls; congress.gov itself is still used for every
// detail field GovInfo's search result doesn't carry (sponsor, status).
//
// GovInfo's relevancy sort is already decent (verified live: "Lower Energy
// Costs Act" puts H.R. 1 118th first), but each bill appears once PER
// published version (introduced, reported, engrossed, enrolled, ...), so this
// still dedupes by (congress, bill_type, number) and re-ranks locally by
// title match, same tiers as before GovTrack: exact > phrase > all-words >
// partial.

/** Words that appear in nearly every bill title and carry no signal about WHICH bill is meant. */
const TITLE_STOPWORDS = new Set([
  'a', 'an', 'the', 'of', 'and', 'or', 'for', 'to', 'in', 'on', 'by', 'with',
  'act', 'bill', 'resolution', 'amendment', 'amendments',
]);

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function queryTerms(normalizedQuery: string): string[] {
  const words = normalizedQuery.split(' ').filter(Boolean);
  const content = words.filter((w) => !TITLE_STOPWORDS.has(w));
  return content.length > 0 ? content : words;
}

/** A title word matches a query term exactly, or by prefix once the term is long enough ("lower" ~ "lowering", "crypto" ~ "cryptocurrency"). */
function wordMatches(term: string, words: string[]): boolean {
  return words.some((w) => w === term || (term.length >= 4 && w.startsWith(term)));
}

type MatchTier = 'exact' | 'phrase' | 'all_words' | 'partial' | 'none';

/** GovInfo's `title` sometimes joins several short titles with "; " — score against each. */
function candidateTitles(title: string | null | undefined): string[] {
  if (!title) return [];
  return title.split(';').map((t) => t.trim()).filter(Boolean);
}

/**
 * Score one result's titles against the query. Tiers do not overlap: exact
 * 400 > phrase 300–399 > all_words 200–299 > partial 1–199 > none 0.
 */
function scoreTitle(titles: string[], qNorm: string, terms: string[]): { score: number; tier: MatchTier; matched_title: string | null } {
  let best: { score: number; tier: MatchTier; matched_title: string | null } = { score: 0, tier: 'none', matched_title: null };
  for (const raw of titles) {
    const t = normalizeTitle(raw);
    if (!t) continue;
    let score = 0;
    let tier: MatchTier = 'none';
    if (t === qNorm) {
      score = 400;
      tier = 'exact';
    } else if (qNorm && ` ${t} `.includes(` ${qNorm} `)) {
      score = 300 + Math.round((99 * qNorm.length) / t.length); // the shorter the containing title, the closer to exact
      tier = 'phrase';
    } else {
      const words = t.split(' ');
      const hits = terms.filter((term) => wordMatches(term, words)).length;
      if (terms.length > 0 && hits === terms.length) {
        score = 200 + Math.round((99 * terms.length) / Math.max(words.length, 1));
        tier = 'all_words';
      } else if (hits > 0) {
        score = Math.max(1, Math.round((199 * hits) / terms.length));
        tier = 'partial';
      }
    }
    if (score > best.score) best = { score, tier, matched_title: raw };
  }
  return best;
}

const SEARCH_RANKING_NOTE =
  'Re-ranked locally by title match over GovInfo\'s full-text search results — exact title, then a title containing the phrase, then all query words, then partial overlap; ties go to GovInfo\'s own relevancy order.';
const SEARCH_SOURCE_NOTE =
  'Keyword matching is against GovInfo\'s full-text index of bill documents (congress.gov\'s own /bill endpoint has no free-text search); sponsor/status on each result come from congress.gov.';

async function searchBills(args: Record<string, unknown>) {
  const apiKey = requireApiKey(args);
  const query = typeof args.query === 'string' ? args.query : '';
  const limit = typeof args.limit === 'number' ? args.limit : 10;
  const congress = typeof args.congress === 'number' ? args.congress : undefined;
  const count = Math.min(Math.max(1, limit), 100);
  if (!query.trim()) return { error: 'Pass `query` — bill name, keywords or subject, e.g. "Lower Energy Costs Act" or "crypto".' };

  const qNorm = normalizeTitle(query);
  const terms = queryTerms(qNorm);
  const resp = await govInfoSearchBills(query, apiKey, 100);
  const results = resp.results ?? [];

  // Dedupe by (congress, bill_type, number) — one GovInfo hit per published
  // version — keeping whichever version scores best against the query.
  // `congress` filters LOCALLY (not a documented GovInfo query field) by
  // discarding non-matching packageIds before scoring.
  const best = new Map<string, { parsed: { congress: number; billType: string; number: number }; titles: string[]; score: ReturnType<typeof scoreTitle> }>();
  for (const r of results) {
    const parsed = r.packageId ? parsePackageId(r.packageId) : null;
    if (!parsed) continue;
    if (congress != null && parsed.congress !== congress) continue;
    const titles = candidateTitles(r.title);
    const score = scoreTitle(titles, qNorm, terms);
    const key = `${parsed.congress}/${parsed.billType}/${parsed.number}`;
    const existing = best.get(key);
    if (!existing || score.score > existing.score.score) {
      best.set(key, { parsed, titles, score });
    }
  }

  const ranked = [...best.values()].sort((x, y) => y.score.score - x.score.score || y.parsed.congress - x.parsed.congress);
  const top = ranked.slice(0, count);

  // Enrich with congress.gov's own detail (sponsor, status, introduced date) —
  // GovInfo's search result carries only title/date, not these fields.
  const detailed = await Promise.all(
    top.map(async ({ parsed, score }) => {
      try {
        const data = await congressGovFetch<{ bill: RawCongressBill }>(
          `/bill/${parsed.congress}/${parsed.billType}/${parsed.number}`,
          {},
          apiKey,
        );
        return { ...formatCongressBill(data.bill), match: score.tier, matched_title: score.matched_title };
      } catch {
        // congress.gov detail fetch failed for this one result (rare — e.g. a
        // transient 5xx) — still report the match from GovInfo rather than
        // dropping it silently.
        return {
          bill_type: parsed.billType,
          number: parsed.number,
          congress: parsed.congress,
          title: score.matched_title,
          match: score.tier,
          matched_title: score.matched_title,
          detail_fetch_failed: true,
        };
      }
    }),
  );

  return {
    query,
    total: resp.count ?? results.length,
    source_note: SEARCH_SOURCE_NOTE,
    returned: detailed.length,
    ranking: SEARCH_RANKING_NOTE,
    candidates_ranked: best.size,
    bills: detailed,
  };
}

async function getRecentBills(args: Record<string, unknown>) {
  const apiKey = requireApiKey(args);
  const by = typeof args.by === 'string' ? args.by : 'introduced';
  const congress = typeof args.congress === 'number' ? args.congress : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 20;
  const count = Math.min(Math.max(1, limit), 100);
  // `sort=updateDate+desc` is verified live (fleet #3164, 2026-10-16: 200 OK,
  // pagination.count 19,696 for congress 119). `sort=introducedDate+desc`
  // follows the same documented asc/desc convention (LOC's BillEndpoint.md
  // names `introducedDate` as a sort field) but was NOT independently
  // live-verified — DEMO_KEY's 10/hr quota was exhausted first. If this ever
  // 400s, that is the field to check first.
  const sort = by === 'activity' ? 'updateDate+desc' : 'introducedDate+desc';
  const path = congress != null ? `/bill/${congress}` : '/bill';

  const data = await congressGovFetch<CongressGovListResponse<RawCongressBill>>(
    path,
    { limit: count, sort },
    apiKey,
  );
  const bills = data.bills ?? [];

  return {
    sort_by: by === 'activity' ? 'latest_update' : 'introduced_date',
    congress: congress ?? null,
    total: data.pagination?.count ?? bills.length,
    returned: bills.length,
    bills: bills.map(formatCongressBill),
  };
}

/**
 * congress.gov bill types (lowercase path segments), plus the long GovTrack-era
 * forms and the short forms every caller actually types, so this migration does
 * not break an existing caller's `bill_type` value.
 *
 * `hr` is what a person writes; congress.gov's path segment is also `hr`, so
 * this is now mostly a no-op for the short forms — but a caller who sends the
 * long `house_bill` form (what this pack asked for before this migration)
 * still needs to land on the right congress.gov segment, and a caller who
 * sends a bad value should get a named error, not a silent zero-result list.
 */
const BILL_TYPE_ALIASES: Record<string, string> = {
  hr: 'hr',
  'h.r.': 'hr',
  'h.r': 'hr',
  house_bill: 'hr',
  s: 's',
  'senate bill': 's',
  senate_bill: 's',
  hres: 'hres',
  house_resolution: 'hres',
  sres: 'sres',
  senate_resolution: 'sres',
  hjres: 'hjres',
  house_joint_resolution: 'hjres',
  sjres: 'sjres',
  senate_joint_resolution: 'sjres',
  hconres: 'hconres',
  house_concurrent_resolution: 'hconres',
  sconres: 'sconres',
  senate_concurrent_resolution: 'sconres',
};

const BILL_TYPE_LABELS: Record<string, string> = {
  hr: 'House Bill',
  s: 'Senate Bill',
  hres: 'House Resolution',
  sres: 'Senate Resolution',
  hjres: 'House Joint Resolution',
  sjres: 'Senate Joint Resolution',
  hconres: 'House Concurrent Resolution',
  sconres: 'Senate Concurrent Resolution',
};

/**
 * Bills are addressed by congress + type + number — congress.gov's own path
 * shape, e.g. /v3/bill/118/hr/1 for H.R. 1 of the 118th Congress.
 *
 * `id`, a GovTrack-internal numeric key this tool used to also accept, is
 * dropped: congress.gov has no such id and never did, so there is nothing to
 * look it up against now that GovTrack is gone (fleet #3164).
 */
async function getBill(args: Record<string, unknown>) {
  const apiKey = requireApiKey(args);
  const congress = typeof args.congress === 'number' ? Math.floor(args.congress) : NaN;
  const number = typeof args.number === 'number' ? Math.floor(args.number) : NaN;
  const rawType = typeof args.bill_type === 'string' ? args.bill_type.trim().toLowerCase() : '';
  const billType = BILL_TYPE_ALIASES[rawType];

  if (!Number.isFinite(congress) || !Number.isFinite(number) || !billType) {
    return {
      error:
        'Identify the bill by congress, bill_type and number — e.g. {"congress":118,"bill_type":"hr","number":1} for H.R. 1 of the 118th Congress.' +
        (rawType && !billType
          ? ` "${rawType}" is not a bill type I recognise; use one of ${Object.keys(BILL_TYPE_ALIASES).join(', ')}.`
          : ''),
      congress: Number.isFinite(congress) ? congress : null,
      bill_type: rawType || null,
      number: Number.isFinite(number) ? number : null,
    };
  }

  const res = await pwFetch(congressGovUrl(`/bill/${congress}/${billType}/${number}`, {}, apiKey));
  if (res.status === 404) {
    // Say which of the two it is. A caller cannot act on "not found" without
    // knowing whether the bill is absent or the congress/number is out of range.
    return {
      found: false,
      error: `No bill matching congress ${congress}, ${billType}, number ${number} on congress.gov. Check the congress and bill number.`,
      congress,
      bill_type: billType,
      number,
    };
  }
  if (!res.ok) throw await httpError(res, 'congress.gov API error');
  const data = await parseJson<{ bill: RawCongressBill }>(res, 'congress.gov');
  return formatCongressBill(data.bill);
}

async function getMembers(args: Record<string, unknown>) {
  const apiKey = requireApiKey(args);
  const limit = typeof args.limit === 'number' ? args.limit : 50;
  const count = Math.min(Math.max(1, limit), 600);

  const data = await congressGovFetch<CongressGovListResponse<RawCongressMember>>(
    '/member',
    { currentMember: 'true', limit: count },
    apiKey,
  );
  const members = data.members ?? [];

  return {
    total: data.pagination?.count ?? members.length,
    returned: members.length,
    members: members.map(formatCongressMember),
  };
}

// --- get_votes: House (congress.gov) + Senate (senate.gov, keyless) ---
// (fleet #3183 — follow-up to #3164, which left get_votes refusing outright
// because congress.gov's roll-call-vote endpoint is House-only.)

const HOUSE_VOTE_SOURCE = 'Clerk of the House of Representatives, roll call vote records (via congress.gov)';
const SENATE_VOTE_SOURCE = 'Secretary of the Senate, roll call vote records';

/**
 * The Congress sitting on `now`. A Congress convenes on Jan 3 of every odd
 * year. (Reintroduces the helper #3164 removed along with the rest of the
 * old GovTrack-era search_bills — needed again here for "default to the
 * current session" when no congress/session is named.)
 */
function currentCongressNumber(now: Date): number {
  const year = now.getUTCFullYear();
  const oddYear = year % 2 === 1 ? year : year - 1;
  let congress = (oddYear - 1789) / 2 + 1;
  if (year % 2 === 1 && now < new Date(Date.UTC(year, 0, 3))) congress -= 1;
  return congress;
}

/** Session 1 = a Congress's first calendar year, session 2 = its second — fixed by calendar year, not by actual adjournment. */
function currentSessionNumber(now: Date, congress: number): 1 | 2 {
  const firstYear = 1789 + (congress - 1) * 2;
  return now.getUTCFullYear() === firstYear ? 1 : 2;
}

/**
 * congress/session can only be safely DEFAULTED for the current Congress —
 * for any other one, guessing which of its two sessions "now" implies would
 * be wrong (today's date has no relationship to a past Congress's own
 * calendar). So a named past/future congress without a session is a named
 * argument error, not a guess.
 */
function resolveCongressSession(
  congressArg: number | undefined,
  sessionArg: 1 | 2 | undefined,
): { congress: number; session: 1 | 2 } | { error: string } {
  const now = new Date();
  const nowCongress = currentCongressNumber(now);
  if (congressArg == null) {
    return { congress: nowCongress, session: sessionArg ?? currentSessionNumber(now, nowCongress) };
  }
  if (sessionArg != null) return { congress: congressArg, session: sessionArg };
  if (congressArg === nowCongress) return { congress: congressArg, session: currentSessionNumber(now, congressArg) };
  return {
    error: `Pass session (1 or 2) along with congress ${congressArg} — it can only be inferred for the current Congress (${nowCongress}).`,
  };
}

const VALID_VOTE_CHAMBERS = new Set(['house', 'senate']);

async function getVotes(args: Record<string, unknown>) {
  const chamber = typeof args.chamber === 'string' ? args.chamber.trim().toLowerCase() : '';
  if (!VALID_VOTE_CHAMBERS.has(chamber)) {
    return {
      error:
        'Pass chamber: "house" or "senate" — the House and Senate number their roll-call votes independently, ' +
        'so there is no single combined listing for "Congress".',
    };
  }
  const congressArg = typeof args.congress === 'number' ? Math.floor(args.congress) : undefined;
  const sessionArgRaw = typeof args.session === 'number' ? Math.floor(args.session) : undefined;
  if (sessionArgRaw != null && sessionArgRaw !== 1 && sessionArgRaw !== 2) {
    return { error: `session must be 1 or 2 (each Congress has exactly two sessions, one per calendar year) — got ${sessionArgRaw}.` };
  }
  const resolved = resolveCongressSession(congressArg, sessionArgRaw as 1 | 2 | undefined);
  if ('error' in resolved) return resolved;
  const { congress, session } = resolved;
  const limit = typeof args.limit === 'number' ? args.limit : 20;
  const count = Math.min(Math.max(1, limit), 100);

  return chamber === 'house' ? getHouseVotes(args, congress, session, count) : getSenateVotes(congress, session, count);
}

type RawHouseVote = {
  congress?: number | null;
  sessionNumber?: number | null;
  rollCallNumber?: number | null;
  startDate?: string | null;
  result?: string | null;
  voteType?: string | null;
  legislationType?: string | null;
  legislationNumber?: string | null;
  legislationUrl?: string | null;
  voteQuestion?: string | null;
  votePartyTotal?: Array<{
    yeaTotal?: number | null;
    nayTotal?: number | null;
    presentTotal?: number | null;
    notVotingTotal?: number | null;
  }> | null;
};

function sumHouseVoteTotals(parties: RawHouseVote['votePartyTotal']): { yea: number; nay: number; present: number; notVoting: number } {
  const totals = { yea: 0, nay: 0, present: 0, notVoting: 0 };
  for (const p of parties ?? []) {
    totals.yea += p.yeaTotal ?? 0;
    totals.nay += p.nayTotal ?? 0;
    totals.present += p.presentTotal ?? 0;
    totals.notVoting += p.notVotingTotal ?? 0;
  }
  return totals;
}

function formatHouseVote(v: RawHouseVote): Record<string, unknown> {
  const totals = v.votePartyTotal ? sumHouseVoteTotals(v.votePartyTotal) : null;
  return {
    chamber: 'house',
    congress: v.congress ?? null,
    session: v.sessionNumber ?? null,
    number: v.rollCallNumber ?? null,
    date: v.startDate ?? null,
    question: v.voteQuestion ?? null,
    vote_type: v.voteType ?? null,
    result: v.result ?? null,
    yes_votes: totals?.yea ?? null,
    no_votes: totals?.nay ?? null,
    present_votes: totals?.present ?? null,
    not_voting: totals?.notVoting ?? null,
    other_votes: totals ? totals.present + totals.notVoting : null,
    related_bill: v.legislationType && v.legislationNumber ? `${v.legislationType} ${v.legislationNumber}` : null,
    link: v.legislationUrl ?? null,
  };
}

/**
 * congress.gov's house-vote LIST endpoint (verified live, 2026-10-16) carries
 * no `question` or vote totals — only the DETAIL endpoint
 * (/house-vote/{congress}/{session}/{number}) does, so each returned vote
 * needs its own follow-up fetch (same N+1 shape already used by
 * search_bills). The list also has no documented sort parameter (checked
 * against the API's own OpenAPI spec) and was NOT observed coming back
 * date-ordered live, so results are re-sorted locally by `startDate` before
 * taking the top `count` — the same defensive re-ranking this pack already
 * does for search_bills/GovInfo.
 *
 * NOTE: the detail endpoint's exact wrapper key (`houseRollCallVote`,
 * singular) follows this API's consistent list/detail naming convention
 * (bills: "bills"/"bill"; members: "members"/"member") but was NOT
 * independently live-verified for this specific endpoint — DEMO_KEY's 10/hr
 * quota was exhausted before it could be checked. `formatHouseVote` is
 * called with a fallback to the raw object if that key is absent, so a wrong
 * guess degrades to missing question/totals rather than throwing.
 */
async function getHouseVotes(args: Record<string, unknown>, congress: number, session: number, count: number) {
  const apiKey = requireApiKey(args);
  const fetchLimit = Math.min(250, Math.max(count * 3, 50));
  const list = await congressGovFetch<{ houseRollCallVotes?: RawHouseVote[] }>(
    `/house-vote/${congress}/${session}`,
    { limit: fetchLimit },
    apiKey,
  );
  const raw = list.houseRollCallVotes ?? [];
  if (raw.length === 0) {
    return {
      found: false,
      chamber: 'house',
      source: HOUSE_VOTE_SOURCE,
      error:
        `No House roll-call votes found for congress ${congress}, session ${session} on congress.gov. ` +
        'That session may not have started yet, may genuinely have recorded none so far, or may be outside this source\'s coverage.',
      congress,
      session,
    };
  }
  const top = [...raw].sort((a, b) => (b.startDate ?? '').localeCompare(a.startDate ?? '')).slice(0, count);
  const detailed = await Promise.all(
    top.map(async (v) => {
      try {
        const detail = await congressGovFetch<Record<string, unknown>>(
          `/house-vote/${v.congress}/${v.sessionNumber}/${v.rollCallNumber}`,
          {},
          apiKey,
        );
        const inner = (detail.houseRollCallVote as RawHouseVote | undefined) ?? (detail as RawHouseVote);
        return formatHouseVote(inner);
      } catch {
        // The per-vote detail fetch failed (rare — e.g. a transient 5xx) —
        // still report the vote from the list row rather than dropping it
        // silently; it will be missing question/totals, which is visibly
        // different from a vote that never existed.
        return { ...formatHouseVote(v), detail_fetch_failed: true };
      }
    }),
  );
  return {
    chamber: 'house',
    source: HOUSE_VOTE_SOURCE,
    congress,
    session,
    total: raw.length,
    returned: detailed.length,
    votes: detailed,
  };
}

const SENATE_MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/** "18-Dec" + the menu's own `<congress_year>` -> "2025-12-18". Falls back to the raw string if either doesn't parse — never throws on an odd date. */
function formatSenateVoteDate(dateStr: string | null, congressYear: string | null): string | null {
  if (!dateStr || !congressYear) return dateStr;
  const m = /^(\d{1,2})-([A-Za-z]{3})$/.exec(dateStr);
  const mm = m ? SENATE_MONTHS[m[2]] : undefined;
  if (!m || !mm) return dateStr;
  return `${congressYear}-${mm}-${m[1].padStart(2, '0')}`;
}

function numOrNull(s: string | null): number | null {
  if (s == null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * One <vote> block from the Senate's vote-menu XML. Most votes carry a flat
 * <issue>/<question>; an "en bloc" vote (several nominations confirmed
 * together) nests them under <en_bloc><matter> instead and has no top-level
 * <issue>/<question> — handled by falling back to a count of <matter>
 * elements rather than leaving `question` null (verified live: vote 655,
 * 119th Congress 1st session, "En Bloc Nominations... S. Res. 532").
 */
function formatSenateVoteRow(block: string, congress: number, session: number, congressYear: string | null): Record<string, unknown> {
  const enBlocMatters = xmlBlocks(block, 'matter');
  // An en-bloc vote's own <matter> children each carry a <question>/<issue>
  // too (e.g. "On the Nomination" repeated per nominee) — strip the whole
  // <en_bloc>...</en_bloc> span before looking for a TOP-LEVEL <question>/
  // <issue>, or a non-global xmlTag() on the raw block finds the FIRST
  // matter's question and silently reports it as if it were the vote's own
  // (caught by a test fixture built from the real en-bloc XML, vote 655).
  const topLevel = block.replace(/<en_bloc>[\s\S]*?<\/en_bloc>/i, '');
  const question = xmlTag(topLevel, 'question') ?? (enBlocMatters.length > 0 ? `En bloc confirmation of ${enBlocMatters.length} matters` : null);
  const tallyBlock = xmlTag(block, 'vote_tally') ?? '';
  return {
    chamber: 'senate',
    congress,
    session,
    number: xmlTag(block, 'vote_number'),
    date: formatSenateVoteDate(xmlTag(block, 'vote_date'), congressYear),
    question,
    issue: xmlTag(topLevel, 'issue'),
    // Not falling back to a nested <matter>'s own <result> here (unlike
    // `question`'s count-based fallback above) — an en-bloc vote's matters
    // could in principle have mixed individual results, so null is more
    // honest than attributing one matter's outcome to the whole vote.
    result: xmlTag(topLevel, 'result'),
    yes_votes: numOrNull(xmlTag(tallyBlock, 'yeas')),
    no_votes: numOrNull(xmlTag(tallyBlock, 'nays')),
    title: xmlTag(block, 'title'),
    en_bloc_matter_count: enBlocMatters.length > 0 ? enBlocMatters.length : null,
  };
}

/**
 * Senate.gov publishes one XML "menu" per Congress+session listing every
 * roll-call vote that session (newest first — verified live, 2026-10-16: the
 * 119th Congress 2nd session menu opens with vote 256, 30-Sep-2026, and
 * counts down). Public, no credentials, no rate limit observed. Per-vote
 * detail XML (with the full member-by-member breakdown) also exists at
 * roll_call_votes/vote{congress}{session}/vote_{congress}_{session}_{number}.xml
 * but is not fetched here — the menu already carries yea/nay totals,
 * question and result, which is everything get_votes's House side also
 * returns; a per-member breakdown is a different, heavier question than
 * "how did the vote go."
 */
async function getSenateVotes(congress: number, session: number, count: number) {
  const url = `${SENATE_VOTE_MENU_BASE}/vote_menu_${congress}_${session}.xml`;
  const res = await pwFetch(url);
  if (res.status === 404) {
    return {
      found: false,
      chamber: 'senate',
      error: `senate.gov has no roll-call vote menu for congress ${congress}, session ${session} — that session may not exist or may not have started yet.`,
      congress,
      session,
    };
  }
  if (!res.ok) throw await httpError(res, 'Senate roll-call vote menu error');
  const xml = await res.text();
  if (!xml.includes('<vote_summary')) {
    throw new Error(
      `senate.gov answered congress ${congress} session ${session}'s vote menu with something other than the expected XML — senate.gov may be degraded. Retrying later is reasonable.`,
    );
  }
  const congressYear = xmlTag(xml, 'congress_year');
  const rows = xmlBlocks(xml, 'vote');
  if (rows.length === 0) {
    return {
      found: false,
      chamber: 'senate',
      source: SENATE_VOTE_SOURCE,
      error:
        `senate.gov's vote menu for congress ${congress}, session ${session} lists zero roll-call votes — ` +
        'that session may not have started yet, or genuinely recorded none so far.',
      congress,
      session,
    };
  }
  const top = rows.slice(0, count);
  return {
    chamber: 'senate',
    source: SENATE_VOTE_SOURCE,
    congress,
    session,
    total: rows.length,
    returned: top.length,
    votes: top.map((b) => formatSenateVoteRow(b, congress, session, congressYear)),
  };
}

type RawLaw = {
  congress?: number | null;
  type?: string | null;
  number?: string | null;
  title?: string | null;
  originChamber?: string | null;
  latestAction?: { actionDate?: string | null; text?: string | null } | null;
  laws?: Array<{ number?: string | null; type?: string | null }> | null;
};

/**
 * NEW capability (fleet #3164) — GovTrack never had a laws endpoint at all,
 * so this is not a migration of an existing tool. congress.gov's own /law
 * endpoint: /law/{congress} (public + private), /law/{congress}/pub,
 * /law/{congress}/priv. Verified live (DEMO_KEY): 119th Congress has 121
 * public laws + 2 private = 123 total; the most recent public law is PL
 * 119-121 (S.195, "Became Public Law No: 119-121" on 2026-10-09).
 */
async function getPublicLaws(args: Record<string, unknown>) {
  const apiKey = requireApiKey(args);
  const congress = typeof args.congress === 'number' ? Math.floor(args.congress) : NaN;
  if (!Number.isFinite(congress)) {
    return { error: 'Pass `congress` — the Congress number, e.g. 119 for the 119th Congress (2025–2026).' };
  }
  const lawTypeArg = typeof args.law_type === 'string' ? args.law_type.trim().toLowerCase() : 'pub';
  const lawType = lawTypeArg === 'priv' || lawTypeArg === 'private' ? 'priv' : 'pub';
  const limit = typeof args.limit === 'number' ? args.limit : 20;
  const count = Math.min(Math.max(1, limit), 100);

  // No `sort` param here — verified live (DEMO_KEY, 2026-10-16) that /law's
  // default order is already most-recent-law-first (119/pub's first row was
  // PL 119-121, enacted 2026-10-09, the newest at the time), and `sort` on
  // this endpoint is unverified (DEMO_KEY's 10/hr quota was exhausted before
  // it could be checked) — safer to rely on the observed default than guess.
  const data = await congressGovFetch<CongressGovListResponse<RawLaw>>(
    `/law/${congress}/${lawType}`,
    { limit: count },
    apiKey,
  );
  const laws = data.bills ?? [];

  return {
    congress,
    law_type: lawType === 'pub' ? 'public' : 'private',
    total: data.pagination?.count ?? laws.length,
    returned: laws.length,
    most_recent: laws[0]
      ? {
          law_number: laws[0].laws?.[0]?.number ?? null,
          bill: `${(laws[0].type ?? '').toUpperCase()} ${laws[0].number ?? ''}`.trim(),
          title: laws[0].title ?? null,
          became_law_date: laws[0].latestAction?.actionDate ?? null,
        }
      : null,
    laws: laws.map((l) => ({
      law_number: l.laws?.[0]?.number ?? null,
      congress: l.congress ?? congress,
      bill_type: (l.type ?? '').toLowerCase() || null,
      bill_number: l.number != null ? Number(l.number) : null,
      title: l.title ?? null,
      origin_chamber: l.originChamber ?? null,
      became_law_date: l.latestAction?.actionDate ?? null,
    })),
  };
}

export default { tools, callTool } satisfies McpToolExport;
