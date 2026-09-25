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
 * Congress MCP — US Congress data via GovTrack API (free, no auth required)
 *
 * Tools:
 * - search_bills: Search congressional bills by name, subject or keyword, ranked locally by title match
 * - get_bill: Get a single bill by GovTrack bill ID
 * - get_members: Get current members of Congress
 * - get_votes: Get recent congressional votes (newest first)
 * - get_recent_bills: Most recently introduced / acted-on bills
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Congress');
}


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
  /** [kind, as_of_status, text] triples — display, short, short-partial and official titles. */
  titles?: Array<Array<string | null>> | null;
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
      'ANSWERS "what bills about X has Congress introduced" / "recent congressional bills on X" / "federal legislation about X" / "find the <Named> Act" — searches US FEDERAL congressional bills (US House & Senate, national laws) BY BILL NAME, SUBJECT OR KEYWORD, including recently introduced ones. Results are RANKED by how well each bill\'s titles match the query — exact title first, then a title containing the phrase, then all query words, then partial overlap, newer Congress first on ties — so the first result is the best title match and each bill carries its match tier. The current Congress and the two before it are searched in depth plus the first page of matches from every earlier Congress; pass `congress` to search one Congress exhaustively (e.g. a bill from the 111th). Prefer this over a date-sorted recent-bills listing whenever the question names a topic or a bill, since only this tool can filter by it. Returns bill type, number, title, status, sponsor, and introduction date. Use get_bill with congress + bill_type + number for full details. NOTE: this is the US Congress (federal) ONLY — for STATE legislature bills (e.g. California, Texas, New York, or any US state legislation) use legiscan or openstates instead, not this tool.',
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
          description:
            'Optional Congress number (e.g. 111) to search exhaustively. Without it the three most recent Congresses are searched in depth and every earlier one only shallowly, so name a Congress when the bill is older than about six years.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_bill',
    description:
      'Look up one congressional bill from GovTrack by its real-world identifier — congress number, bill type and bill number, e.g. the 118th Congress H.R. 1. Returns title, sponsor, current status with its date, introduced date and the GovTrack link. Does NOT return bill text, cosponsors, committee assignments or vote history.',
    inputSchema: {
      type: 'object',
      properties: {
        congress: { type: 'number', description: 'Congress number, e.g. 118' },
        bill_type: {
          type: 'string',
          description:
            "GovTrack bill type: house_bill, senate_bill, house_resolution, senate_resolution, house_joint_resolution, senate_joint_resolution, house_concurrent_resolution or senate_concurrent_resolution. 'hr' and 'h.r.' are accepted as house_bill, 's' as senate_bill.",
        },
        number: { type: 'number', description: 'Bill number within that congress, e.g. 1 for H.R. 1' },
        id: {
          type: 'number',
          description:
            'GovTrack internal numeric bill id. Legacy — v2 no longer returns it on any endpoint, so prefer congress + bill_type + number.',
        },
      },
      required: ['congress', 'bill_type', 'number'],
    },
  },
  {
    name: 'get_members',
    description:
      'Get current members of Congress with their name, party, state, district (for representatives), and contact information.',
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
      'Get recent congressional votes on bills, newest first. Returns question, result, chamber, vote counts (yes/no/abstain), date, and related bill.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of votes to return (default: 20, max: 100)' },
        congress: { type: 'number', description: 'Congress number to filter by (e.g., 119)' },
      },
    },
  },
  {
    name: 'get_recent_bills',
    description:
      'List the most recent congressional bills — newest first by introduction date or by latest action. This tool takes NO subject or keyword: it returns whatever Congress touched most recently, so it can only answer OPEN-ENDED recency questions — "what bills were introduced this week", "latest bills in Congress", "what is Congress working on now", "recent activity on bills". PREFER OVER congress_search_bills for exactly those (it ranks by keyword relevance and surfaces older bills). If the question NAMES a bill, act, or subject — "status of the NDAA", "the defense authorization bill", "bills about crypto" — use congress_search_bills instead, even when it asks for the CURRENT status: a named subject cannot be found in an unfiltered recency list, which is mostly routine post-office namings. Returns bill type, number, title, status, sponsor, and dates.',
    inputSchema: {
      type: 'object',
      properties: {
        by: {
          type: 'string',
          description: 'Recency basis: "introduced" (default, newest introductions) or "activity" (most recent status change / latest action).',
        },
        congress: { type: 'number', description: 'Congress number to filter by (e.g., 119 for 2025–2026). Omit for all.' },
        limit: { type: 'number', description: 'Number of bills to return (default: 20, max: 100)' },
      },
    },
  },
];

// --- callTool dispatcher ---

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'search_bills':
      return searchBills(args.query as string, (args.limit as number) ?? 10, args.congress as number | undefined);
    case 'get_bill':
      return getBill(args);
    case 'get_members':
      return getMembers((args.limit as number) ?? 50);
    case 'get_votes':
      return getVotes((args.limit as number) ?? 20, args.congress as number | undefined);
    case 'get_recent_bills':
      return getRecentBills(
        typeof args.by === 'string' ? args.by : 'introduced',
        args.congress as number | undefined,
        (args.limit as number) ?? 20,
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- Tool implementations ---

// --- search_bills: candidate gathering + local ranking ---
//
// GovTrack's `q` is a loose keyword match with NO relevance ordering. For
// "Lower Energy Costs Act" it reports 4,348 matches and puts a 2014 salmon bill
// first, while H.R. 1 (118th) — the bill literally so named — sits at position
// 86 of the 285 matches inside its own Congress and outside the first 1,100 of
// the unfiltered list. `order_by=relevance` is rejected outright and offsets
// above 1000 are refused, so the unfiltered list can never be walked to it. A
// model reads element 0 as the best match, so the old pass-through answered
// about a DIFFERENT bill with a clean 200 (fleet #2170).
//
// So: gather candidates per recent Congress (each Congress's own match set is
// small enough to page), re-rank locally by title match, and say so in the
// payload. Waves 2 and 3 only run while nothing yet matches the phrase, so a
// subject query ("crypto") costs four upstream requests and a named bill that
// is hiding deep costs at most sixteen.

const GOVTRACK_PAGE = 100;
const GOVTRACK_MAX_OFFSET = 1000; // GovTrack: "Offset > 1000 is not permitted."
const RECENT_CONGRESSES = 3; // current + the two before it ≈ six years
const DEEP_PAGES_PER_CONGRESS = 3; // wave 2: up to 300 candidates per recent Congress
const OLDER_CONGRESSES = 6; // wave 3: one page each for the six Congresses before that
const FIRST_GOVTRACK_CONGRESS = 93; // GovTrack's bill corpus starts at the 93rd (1973)
const PINNED_MAX_PAGES = Math.floor(GOVTRACK_MAX_OFFSET / GOVTRACK_PAGE) + 1; // 11 pages ≈ 1,100 rows

/**
 * The Congress sitting on `now`. A Congress convenes on Jan 3 of every odd
 * year; the 119th convened 2025-01-03. Takes the date as an argument because a
 * module-scope `new Date()` is 1970 in a Worker isolate.
 */
function currentCongress(now: Date): number {
  const year = now.getUTCFullYear();
  const oddYear = year % 2 === 1 ? year : year - 1;
  let congress = (oddYear - 1789) / 2 + 1;
  if (year % 2 === 1 && now < new Date(Date.UTC(year, 0, 3))) congress -= 1;
  return congress;
}

async function fetchBillPage(params: Record<string, string>): Promise<GovTrackListResponse<RawBill>> {
  const res = await pwFetch(`${BASE_URL}/bill?${new URLSearchParams(params)}`);
  if (!res.ok) throw await httpError(res, 'GovTrack API error');
  return (await res.json()) as GovTrackListResponse<RawBill>;
}

/** Offsets of the pages AFTER the first, for a match set of `total` rows, capped at `maxPages` pages in all. */
function laterPageOffsets(total: number, maxPages: number): number[] {
  const offsets: number[] = [];
  for (let off = GOVTRACK_PAGE; off < total && off <= GOVTRACK_MAX_OFFSET && offsets.length < maxPages - 1; off += GOVTRACK_PAGE) {
    offsets.push(off);
  }
  return offsets;
}

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

function billTitles(b: RawBill): string[] {
  const out = new Set<string>();
  if (b.title_without_number) out.add(b.title_without_number);
  for (const t of b.titles ?? []) {
    const text = t?.[2];
    if (typeof text === 'string' && text) out.add(text);
  }
  return [...out];
}

/**
 * Score one bill against the query over ALL of its titles (display, short,
 * short-partial and official), so an alias like "TAPP American Resources Act"
 * finds H.R. 1 too. Tiers do not overlap: exact 400 > phrase 300–399 >
 * all_words 200–299 > partial 1–199 > none 0.
 */
function scoreBill(b: RawBill, qNorm: string, terms: string[]): { score: number; tier: MatchTier; matched_title: string | null } {
  let best: { score: number; tier: MatchTier; matched_title: string | null } = { score: 0, tier: 'none', matched_title: null };
  for (const raw of billTitles(b)) {
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

function billKey(b: RawBill): string {
  return `${b.congress ?? '?'}/${b.bill_type ?? '?'}/${b.number ?? '?'}`;
}

const SEARCH_RANKING_NOTE =
  "Re-ranked locally by title match — exact title, then a title containing the phrase, then all query words, then partial overlap; ties go to the newer Congress. GovTrack's own result order is NOT by relevance and is not used.";
const SEARCH_TOTAL_NOTE =
  'GovTrack loose keyword-match count (any query word may match any of a bill\'s titles), not the number of bills about this subject or bearing this name.';

async function searchBills(query: string, limit: number, congress: number | undefined) {
  const count = Math.min(Math.max(1, limit), 100);
  const base = { q: query, limit: String(GOVTRACK_PAGE) };
  const qNorm = normalizeTitle(query);
  const terms = queryTerms(qNorm);

  const candidates = new Map<string, RawBill>();
  const add = (pages: GovTrackListResponse<RawBill>[]) => {
    for (const page of pages) {
      for (const b of page.objects) {
        const key = billKey(b);
        if (!candidates.has(key)) candidates.set(key, b);
      }
    }
  };
  const phraseFound = () => {
    for (const b of candidates.values()) if (scoreBill(b, qNorm, terms).score >= 300) return true;
    return false;
  };

  let total: number;
  let congressesSearched: Record<string, unknown>;

  if (congress != null) {
    const pinned = { ...base, congress: String(congress) };
    const first = await fetchBillPage(pinned);
    total = first.meta?.total_count ?? first.objects.length;
    const rest = await Promise.all(
      laterPageOffsets(total, PINNED_MAX_PAGES).map((off) => fetchBillPage({ ...pinned, offset: String(off) })),
    );
    add([first, ...rest]);
    congressesSearched = {
      exhaustive: [congress],
      coverage:
        candidates.size >= total
          ? 'every loose match in this Congress was ranked'
          : `first ${candidates.size} of ${total} loose matches were ranked — GovTrack refuses offsets above ${GOVTRACK_MAX_OFFSET}; narrow the query`,
    };
  } else {
    const current = currentCongress(new Date());
    const recent = Array.from({ length: RECENT_CONGRESSES }, (_, i) => current - i);

    // Wave 1: one page unfiltered (whatever GovTrack puts first, any Congress) + one page per recent Congress.
    const [unfiltered, ...recentFirst] = await Promise.all([
      fetchBillPage(base),
      ...recent.map((c) => fetchBillPage({ ...base, congress: String(c) })),
    ]);
    total = unfiltered.meta?.total_count ?? unfiltered.objects.length;
    add([unfiltered, ...recentFirst]);

    // Wave 2: a named bill can sit deep inside its own Congress's match set (H.R. 1 was 86th of 285).
    if (!phraseFound()) {
      const deeper = recent.flatMap((c, i) =>
        laterPageOffsets(recentFirst[i].meta?.total_count ?? 0, DEEP_PAGES_PER_CONGRESS).map((off) =>
          fetchBillPage({ ...base, congress: String(c), offset: String(off) }),
        ),
      );
      add(await Promise.all(deeper));
    }

    // Wave 3: the six Congresses before the recent window, one page each.
    let older: number[] = [];
    if (!phraseFound()) {
      older = Array.from({ length: OLDER_CONGRESSES }, (_, i) => current - RECENT_CONGRESSES - i).filter(
        (c) => c >= FIRST_GOVTRACK_CONGRESS,
      );
      add(await Promise.all(older.map((c) => fetchBillPage({ ...base, congress: String(c) }))));
    }

    congressesSearched = {
      in_depth: recent,
      one_page: older,
      plus: 'the first page of loose matches across every Congress',
      hint: 'A bill older than the in-depth window may be missing; pass `congress` to search that Congress exhaustively.',
    };
  }

  const ranked = [...candidates.values()]
    .map((b) => ({ b, m: scoreBill(b, qNorm, terms) }))
    .sort(
      (x, y) =>
        y.m.score - x.m.score ||
        (y.b.congress ?? 0) - (x.b.congress ?? 0) ||
        (y.b.introduced_date ?? '').localeCompare(x.b.introduced_date ?? ''),
    );
  const top = ranked.slice(0, count);

  return {
    query,
    total,
    total_note: SEARCH_TOTAL_NOTE,
    returned: top.length,
    ranking: SEARCH_RANKING_NOTE,
    candidates_ranked: candidates.size,
    congresses_searched: congressesSearched,
    bills: top.map(({ b, m }) => ({ ...formatBill(b), match: m.tier, matched_title: m.matched_title })),
  };
}

async function getRecentBills(by: string, congress: number | undefined, limit: number) {
  const count = Math.min(Math.max(1, limit), 100);
  const orderBy = by === 'activity' ? '-current_status_date' : '-introduced_date';
  const params = new URLSearchParams({ limit: String(count), order_by: orderBy });
  if (congress != null) params.set('congress', String(congress));

  const res = await pwFetch(`${BASE_URL}/bill?${params}`);
  if (!res.ok) throw await httpError(res, 'GovTrack API error');

  const data = (await res.json()) as GovTrackListResponse<RawBill>;

  return {
    sort_by: by === 'activity' ? 'latest_action' : 'introduced_date',
    congress: congress ?? null,
    total: data.meta?.total_count ?? data.objects.length,
    returned: data.objects.length,
    bills: data.objects.map(formatBill),
  };
}

/**
 * GovTrack bill types, plus the short forms every caller actually types.
 *
 * `hr` is what a person writes and `house_bill` is what the API wants; a caller
 * who sends the former gets a silent zero-result list, which is the worse of the
 * two failures because it reads as "no such bill".
 */
const BILL_TYPE_ALIASES: Record<string, string> = {
  hr: 'house_bill',
  'h.r.': 'house_bill',
  'h.r': 'house_bill',
  house_bill: 'house_bill',
  s: 'senate_bill',
  'senate bill': 'senate_bill',
  senate_bill: 'senate_bill',
  hres: 'house_resolution',
  house_resolution: 'house_resolution',
  sres: 'senate_resolution',
  senate_resolution: 'senate_resolution',
  hjres: 'house_joint_resolution',
  house_joint_resolution: 'house_joint_resolution',
  sjres: 'senate_joint_resolution',
  senate_joint_resolution: 'senate_joint_resolution',
  hconres: 'house_concurrent_resolution',
  house_concurrent_resolution: 'house_concurrent_resolution',
  sconres: 'senate_concurrent_resolution',
  senate_concurrent_resolution: 'senate_concurrent_resolution',
};

/**
 * Bills are addressed by congress + type + number, not by an internal id.
 *
 * This tool used to require `id`, a GovTrack-internal numeric key, and that
 * made it UNCALLABLE rather than merely awkward: GovTrack v2 does not return
 * `id` on any endpoint any more — not on /bill, not with an explicit
 * `fields=id` — so `search_bills` emits nothing for it either (its formatter's
 * `id: b.id` has been `undefined`, and therefore absent from the JSON, for as
 * long as that has been true). There was no path through this pack, or any
 * other, by which a caller could obtain the one argument the tool demanded.
 *
 * Measured 2026-09-16: a REGISTERED account called it three times in a week and
 * got three `400 id is required`. I reached for congress/bill_type/number
 * myself before reading the schema, which is the same mistake from a different
 * direction and is the reason this is a defect rather than a documentation gap —
 * the natural key is what everyone reaches for because it is how bills are
 * identified in the world.
 *
 * `id` is still accepted so nothing that somehow had one breaks.
 */
async function getBill(args: Record<string, unknown>) {
  if (typeof args.id === 'number' && Number.isFinite(args.id)) {
    const res = await pwFetch(`${BASE_URL}/bill/${args.id}`);
    if (!res.ok) throw await httpError(res, 'GovTrack API error');
    return formatBill((await res.json()) as RawBill);
  }

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

  const params = new URLSearchParams({
    congress: String(congress),
    bill_type: billType,
    number: String(number),
  });
  const res = await pwFetch(`${BASE_URL}/bill?${params}`);
  if (!res.ok) throw await httpError(res, 'GovTrack API error');

  const data = (await res.json()) as GovTrackListResponse<RawBill>;
  const bill = Array.isArray(data.objects) ? data.objects[0] : undefined;
  if (!bill) {
    // Say which of the two it is. A caller cannot act on "not found" without
    // knowing whether the bill is absent or the congress is out of range.
    return {
      found: false,
      error: `No bill matching congress ${congress}, ${billType}, number ${number}. GovTrack covers the 93rd Congress onward, so check the congress number as well as the bill number.`,
      congress,
      bill_type: billType,
      number,
    };
  }
  return formatBill(bill);
}

async function getMembers(limit: number) {
  const count = Math.min(Math.max(1, limit), 600);
  const params = new URLSearchParams({
    current: 'true',
    limit: String(count),
  });

  const res = await pwFetch(`${BASE_URL}/role?${params}`);
  if (!res.ok) throw await httpError(res, 'GovTrack API error');

  const data = (await res.json()) as GovTrackListResponse<RawMemberRole>;

  return {
    total: data.meta?.total_count ?? data.objects.length,
    returned: data.objects.length,
    members: data.objects.map(formatMember),
  };
}

async function getVotes(limit: number, congress?: number) {
  const count = Math.min(Math.max(1, limit), 100);
  // Without explicit ordering GovTrack returns votes oldest-first (back to 1789),
  // which contradicts this tool's purpose ("recent votes"). Sort newest-first.
  const params = new URLSearchParams({ limit: String(count), order_by: '-created' });
  if (congress != null) params.set('congress', String(congress));

  const res = await pwFetch(`${BASE_URL}/vote?${params}`);
  if (!res.ok) throw await httpError(res, 'GovTrack API error');

  const data = (await res.json()) as GovTrackListResponse<RawVote>;

  return {
    total: data.meta?.total_count ?? data.objects.length,
    returned: data.objects.length,
    votes: data.objects.map(formatVote),
  };
}

export default { tools, callTool } satisfies McpToolExport;
