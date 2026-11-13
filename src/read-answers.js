// Reads the answers of one batch, in the order they were asked, and decides
// per answer: found, rejected (with the reason), duplicate, or try again.
// One item comes out: the state for the next round.
//
// Response shape (OpenAI Responses API with web search):
//   output[]: { type: 'web_search_call', action: { type: 'search', sources: [{ url }] } }
//             { type: 'message', content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', url }] }] }
//   usage:    { input_tokens, output_tokens, total_tokens }
const batch = $('Next batch').all();
const answers = $input.all();
const state = JSON.parse(JSON.stringify(batch[0].json.state));
const s = state.settings;

/* __KEYS__ */

const DAY = 24 * 3600 * 1000;
const started = Date.parse(state.started_at);
const cutoff = Date.parse(state.cutoff_at);
const domains = new Map(state.domains.map(([key, where]) => [key, where]));
const names = new Map(state.names.map(([key, where, hasDomain]) => [key, { where, hasDomain }]));

// The JSON object in the answer text. Code fences, text around the JSON and a
// comma before a closing bracket are repaired; anything else is not usable.
function readJson(text) {
  const trimmed = String(text ?? '').trim();
  const attempts = [trimmed];
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
  if (fenced) attempts.push(fenced.trim());
  const body = fenced ?? trimmed;
  const from = body.search(/[{[]/);
  const to = Math.max(body.lastIndexOf('}'), body.lastIndexOf(']'));
  if (from !== -1 && to > from) attempts.push(body.slice(from, to + 1), body.slice(from, to + 1).replace(/,\s*([}\]])/g, '$1'));
  for (const attempt of attempts) {
    try {
      let value = JSON.parse(attempt);
      if (value && Array.isArray(value.companies)) value = value.companies;
      if (Array.isArray(value)) value = value[0] ?? {};
      if (value && typeof value === 'object') return value;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

// A page address without the parts that differ between two links to the same page.
function pageKey(url) {
  const match = /^https?:\/\/([^/?#]+)([^?#]*)/i.exec(String(url ?? '').trim());
  if (!match) return '';
  return `${match[1].toLowerCase().replace(/^www\./, '')}${match[2].replace(/\/+$/, '')}`;
}
const hostOf = (url) => pageKey(url).split('/')[0];

// When the source was published, in milliseconds. A date without a time counts
// as the end of that day, so a source from the edge of the window is kept.
function publishedAt(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) return Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])) + DAY - 1;
  const time = Date.parse(text);
  if (Number.isNaN(time)) return null;
  return /\d:\d\d/.test(text) ? time : time + DAY - 1;
}

const clean = (value) => (typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim());

// Returns { outcome: 'found' | 'rejected' | 'duplicate', reason, row }
function judge(body, angle) {
  const output = Array.isArray(body?.output) ? body.output : [];
  const searches = output.filter((entry) => entry?.type === 'web_search_call');
  const parts = output.filter((entry) => entry?.type === 'message').flatMap((entry) => (Array.isArray(entry.content) ? entry.content : []));
  if (parts.some((part) => part?.type === 'refusal')) return { outcome: 'rejected', reason: 'refused' };
  const texts = parts.filter((part) => part?.type === 'output_text');
  const answer = readJson(texts.map((part) => part.text ?? '').join('\n'));
  if (!answer) return { outcome: 'bad_json' };

  const row = {
    company: clean(answer.company),
    website: clean(answer.website),
    signal: clean(answer.signal),
    source_url: clean(answer.source_url),
    source_date: clean(answer.source_date),
  };
  if (!row.company) return { outcome: 'rejected', reason: 'nothing_found', row };
  if (!/^https?:\/\/[^\s/]+\.[^\s/]+/i.test(row.source_url)) return { outcome: 'rejected', reason: 'no_source', row };

  if (s.cited_source_check !== 'off') {
    if (searches.length === 0) return { outcome: 'rejected', reason: 'no_web_search', row };
    const cited = [
      ...texts.flatMap((part) => (Array.isArray(part.annotations) ? part.annotations : [])).filter((note) => note?.type === 'url_citation').map((note) => note.url),
      ...searches.flatMap((search) => (Array.isArray(search.action?.sources) ? search.action.sources : [])).map((source) => source?.url),
    ].filter(Boolean);
    const ok = s.cited_source_check === 'domain' ? cited.some((url) => hostOf(url) === hostOf(row.source_url)) : cited.some((url) => pageKey(url) === pageKey(row.source_url));
    if (!ok) return { outcome: 'rejected', reason: 'source_not_in_search', row };
  }

  const published = publishedAt(row.source_date);
  if (published === null) return { outcome: 'rejected', reason: 'no_source_date', row };
  if (published < cutoff) return { outcome: 'rejected', reason: 'stale_source', row };
  if (published > started + 2 * DAY) return { outcome: 'rejected', reason: 'source_date_in_future', row };

  // Same company? The website's domain decides. The name decides only when
  // one of the two has no usable website.
  row.domain_key = domainKey(row.website);
  row.name_key = nameKey(row.company);
  let known = null;
  if (row.domain_key && domains.has(row.domain_key)) known = domains.get(row.domain_key);
  else if (row.name_key && names.has(row.name_key) && (!row.domain_key || !names.get(row.name_key).hasDomain)) known = names.get(row.name_key).where;
  if (known) return { outcome: 'duplicate', reason: known === 'earlier' ? 'found_in_earlier_run' : 'found_in_this_run', row };

  if (row.domain_key) domains.set(row.domain_key, 'run');
  if (row.name_key && !names.has(row.name_key)) names.set(row.name_key, { where: 'run', hasDomain: Boolean(row.domain_key) });
  row.angle = `${angle.area} · ${angle.industry} · ${angle.source} · ${angle.wording}`;
  return { outcome: 'found', row };
}

state.batch += 1;
let wait = 0;
let slowDown = false;
const again = [];
const asked = new Set();

answers.forEach((item, position) => {
  const entry = batch[position].json;
  const index = entry.angle_index;
  const angle = state.angles[index];
  asked.add(index);
  state.attempts[index] = entry.attempt;
  state.model_calls += 1;

  const status = item.json.statusCode;
  let body = item.json.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = null;
    }
  }
  const usage = body?.usage ?? {};
  state.input_tokens += Number(usage.input_tokens) || 0;
  state.output_tokens += Number(usage.output_tokens) || 0;
  state.total_tokens += Number(usage.total_tokens) || (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0);
  if (Array.isArray(body?.output)) state.web_searches += body.output.filter((part) => part?.type === 'web_search_call').length;

  const line = { angle: index + 1, batch: state.batch, attempt: entry.attempt };
  const retry = (reason, seconds) => {
    again.push(index);
    wait = Math.max(wait, seconds);
    state.log.push({ ...line, outcome: 'retry', reason });
  };
  const backoff = Math.min(s.retry_wait_seconds * 2 ** (entry.attempt - 1), s.max_wait_seconds);

  if (status === 429 || status === undefined || status >= 500) {
    // Too many requests, API down or not reachable: wait and ask again.
    const reason = status === 429 ? 'rate_limited' : status === undefined ? 'api_unreachable' : `api_error_${status}`;
    if (status === 429) slowDown = true;
    const header = Number(item.json.headers?.['retry-after']);
    const seconds = Number.isFinite(header) && header > 0 ? Math.min(header, s.max_wait_seconds) : backoff;
    if (entry.attempt < s.max_attempts) retry(reason, seconds);
    else state.log.push({ ...line, outcome: 'rejected', reason });
    return;
  }
  if (status !== 200) {
    // 400, 401, 403, 404: the request itself is wrong (key, model, address). Asking 49 more times will not help.
    state.fatal = `the model API answered HTTP ${status}${body?.error?.message ? `: ${String(body.error.message).slice(0, 200)}` : ''}`;
    state.log.push({ ...line, outcome: 'rejected', reason: `api_error_${status}` });
    return;
  }

  const verdict = judge(body, angle);
  if (verdict.outcome === 'bad_json') {
    // Not usable JSON: one more try, then give up on this angle.
    if (entry.attempt < Math.min(2, s.max_attempts)) retry('bad_json', 0);
    else state.log.push({ ...line, outcome: 'rejected', reason: 'bad_json' });
    return;
  }
  const note = { ...line, outcome: verdict.outcome };
  if (verdict.reason) note.reason = verdict.reason;
  if (verdict.row?.company) note.company = verdict.row.company;
  if (verdict.row?.source_url) note.source_url = verdict.row.source_url;
  if (verdict.row?.source_date) note.source_date = verdict.row.source_date;
  state.log.push(note);
  if (verdict.outcome === 'found') state.found.push({ ...verdict.row, angle_number: index + 1 });
});

// Angles to ask again go back to the front of the queue.
state.queue = [...again, ...state.queue.filter((index) => !asked.has(index))];
// After a "too many requests" the batches are half as big for the rest of the run.
if (slowDown) state.concurrency = Math.max(1, Math.floor(state.concurrency / 2));
state.wait_seconds = Math.max(wait, state.queue.length ? s.pause_seconds : 0);
state.domains = [...domains].map(([key, where]) => [key, where]);
state.names = [...names].map(([key, value]) => [key, value.where, value.hasDomain]);

if (state.fatal) state.stopped = 'api_error';
else if (state.found.length >= s.target) state.stopped = 'target_reached';
else if (state.queue.length === 0) state.stopped = 'angles_used_up';
state.more = !state.stopped;

return [{ json: state }];
