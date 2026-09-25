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
    throw err;
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
 * Treasury Fiscal MCP — US Treasury Fiscal Data API
 *
 * Tools:
 * - treasury_customs_revenue: monthly customs duty collections
 * - treasury_receipts: total government receipts by source
 * - treasury_debt: national debt (debt to the penny)
 * - treasury_exchange_rates: Treasury exchange rates by country
 */


// Bound the fetch() calls in this pack that pass no signal of their own — a
// file with one guarded call still reads as "guarded" to the file-level grep
// while its other call sites hang unbounded (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Treasury Fiscal');
}

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
      'Get official US Treasury exchange rates used for government currency conversions. Pass a country name for one country\'s rate; omit it for the most recent rates across all countries.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        country: {
          type: 'string',
          description: 'Country name (e.g., "China", "Mexico", "Japan", "Canada"). Treasury indexes by country, not currency: the euro is "Euro Zone" (common aliases like "Eurozone"/"EUR" are accepted), and there is no United States row because these are rates from the dollar. Omit for the latest rates across all countries.',
        },
        limit: {
          type: 'number',
          description: 'Number of records to return (default 12)',
        },
      },
      required: [],
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
    const res = await pwFetch(
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

// Age annotation for results served from the fallback path.
//
// This used to tell the CALLER "Live Treasury API is unreachable from the
// gateway (CF egress blocked); served from the daily GitHub-runner mirror."
// hosting-claims-ok: describes a disclosure that was REMOVED, in a private comment
// Three things wrong with that in one sentence: it discloses that we host a
// copy rather than passing through, it volunteers our infrastructure, and it
// advertises a limitation of it. Standing rule is that callers assume
// pass-through.
//
// The FRESHNESS fact is worth keeping and is the only part they need — a
// Treasury figure's currency changes what you can conclude from it. So it now
// reads as data currency and nothing else. Field name changed too:
// `mirror_fetched_at` leaked the same thing in the key.
function mirrorMeta(fetchedAt: string) {
  return {
    source: 'US Treasury Fiscal Data' as const,
    as_of: fetchedAt,
    note: `Figures as published by Treasury as of ${fetchedAt}. Treasury updates these series daily; a figure for the current day may not be posted yet.`,
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

// Treasury files the euro under the country name "Euro Zone". Every natural way
// to ask for it — "Euro Area", "Eurozone", "European Union", the currency code
// "EUR" — matched nothing, and the tool answered "no exchange rate data found",
// which reads as "the euro rate doesn't exist" rather than "you spelled it
// differently than Treasury does". Currency codes get the same treatment since
// a caller reaching for an exchange rate naturally reaches for one.
const TREASURY_COUNTRY_ALIASES: Record<string, string> = {
  'euro area': 'Euro Zone',
  eurozone: 'Euro Zone',
  'euro-zone': 'Euro Zone',
  'european union': 'Euro Zone',
  europe: 'Euro Zone',
  eu: 'Euro Zone',
  eur: 'Euro Zone',
  euro: 'Euro Zone',
  // No US entry on purpose: these are rates FROM the dollar, so Treasury has no
  // "United States" row and aliasing to one would trade a wrong spelling for a
  // confident dead end.
  uk: 'United Kingdom',
  'great britain': 'United Kingdom',
  britain: 'United Kingdom',
  gbp: 'United Kingdom',
  england: 'United Kingdom',
  jpy: 'Japan',
  cny: 'China',
  rmb: 'China',
  'south korea': 'Korea',
  'republic of korea': 'Korea',
};

function normalizeTreasuryCountry(raw: string): string {
  return TREASURY_COUNTRY_ALIASES[raw.toLowerCase()] ?? raw;
}

async function getExchangeRates(country: string | undefined, limit: number = 12, supa: Supa = null) {
  // `country` used to be structurally required, which made a macro question
  // ("what are the current Treasury rates") unanswerable and left every
  // compound caller that omitted it with a permanently null section. Omitting
  // it now returns the most recent rates ACROSS countries.
  const wanted = country?.trim() ? normalizeTreasuryCountry(country.trim()) : null;
  const { response, mirror_fetched_at } = await liveOrMirror('exchange_rates', 'v1/accounting/od/rates_of_exchange', {
    ...(wanted ? { filter: `country:eq:${wanted}` } : {}),
    'sort': '-record_date',
    'page[size]': String(limit),
  }, supa);
  // Mirror holds ALL countries (latest ~2000 rows) — filter client-side.
  const rows = mirror_fetched_at && wanted
    ? response.data.filter((r) => String(r.country ?? '').toLowerCase() === wanted.toLowerCase()).slice(0, limit)
    : response.data.slice(0, limit);

  if (rows.length === 0) {
    throw new Error(
      wanted
        ? `user_error: No Treasury exchange rate for "${wanted}". Treasury indexes by COUNTRY name, not currency or region — the euro is filed under "Euro Zone", and there is no United States row because these are rates from the dollar. Try a country name like "China", "Mexico", "Japan", or omit country for the latest rates across all of them.`
        : 'No exchange rate data returned by Treasury.',
    );
  }

  return {
    description: wanted ? `Treasury exchange rates for ${wanted}` : 'Treasury exchange rates, most recent across all countries',
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
      return getExchangeRates(args.country as string | undefined, (args.limit as number) || 12, supa);
    case 'treasury_avg_interest_rates':
      return getAvgInterestRates((args.limit as number) || 12, supa);
    case 'treasury_federal_net_cost':
      return getFederalNetCost(args.fiscal_year as string | undefined, (args.limit as number) || 20, supa);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 5 } } satisfies McpToolExport;
