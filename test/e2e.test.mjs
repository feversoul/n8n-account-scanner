// End-to-end tests: the real workflows on a real n8n, started over HTTP through
// the webhook and the form. test/stand-in.mjs plays the model API with web
// search (see the list of what it does wrong on purpose at its top). No real
// model and no real web search is involved.

import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

const N8N = process.env.N8N_URL ?? 'http://localhost:55700';
const STANDIN = process.env.STANDIN_URL ?? 'http://localhost:58098';
const KEY = { 'x-scanner-key': 'test-scanner-key', 'content-type': 'application/json' };
const SIGNAL = 'announced a new funding round';

// Named by the stand-in, but must never be saved with the default 96 hours.
const NEVER = ['Stale Corp', 'Sourceless Ltd', 'Invented GmbH', 'Memory Only Inc', 'Dateless Partners', 'Tomorrow Ventures'];

const standin = async () => (await fetch(`${STANDIN}/__state`)).json();
const steer = (change) => fetch(`${STANDIN}/__set`, { method: 'POST', body: JSON.stringify(change) });
const total = (object) => Object.values(object).reduce((sum, value) => sum + value, 0);
const sum = (list, field) => list.reduce((all, entry) => all + (entry[field] ?? 0), 0);
const plain = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

async function post(path, body, headers = KEY) {
  const response = await fetch(`${N8N}/webhook/scanner/${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON, for example n8n's "starting up" page */
  }
  return { status: response.status, json, text };
}

const rows = async () => (await post('rows')).json;

// One run of the scanner, with the calls the stand-in got during it.
async function scan(input) {
  const earlier = (await standin()).calls.length;
  const started = Date.now();
  const answer = await post('run', input);
  assert.equal(answer.status, 200, answer.text);
  return { result: answer.json, seconds: (Date.now() - started) / 1000, calls: (await standin()).calls.slice(earlier) };
}

async function until(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = false;
    try {
      value = await check();
    } catch {
      /* connection refused or reset while n8n starts */
    }
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await sleep(1000);
  }
}

// The numbers of a run summary must agree with each other, with its own log
// and with what the stand-in counted.
function checkSums(result, calls) {
  const log = result.log;
  assert.equal(result.model_calls, calls.length, 'model calls: summary = stand-in');
  assert.equal(log.length, calls.length, 'one log line per model call');
  assert.equal(result.retries, log.filter((line) => line.outcome === 'retry').length);
  assert.equal(result.found, log.filter((line) => line.outcome === 'found').length);
  assert.equal(result.rejected, log.filter((line) => line.outcome === 'rejected').length);
  assert.equal(result.duplicates, log.filter((line) => line.outcome === 'duplicate').length);
  assert.equal(result.model_calls, result.angles_tried + result.retries, 'model calls = angles tried + retries');
  assert.equal(result.angles_tried, result.found + result.rejected + result.duplicates, 'angles tried = found + rejected + duplicates');
  assert.equal(result.angles_planned, result.angles_tried + result.angles_not_needed);
  assert.equal(total(result.rejected_why), result.rejected, 'the reasons add up to the rejected');
  assert.equal(total(result.duplicates_why), result.duplicates);
  assert.equal(total(result.retries_why), result.retries);
  assert.equal(result.companies.length, result.found);
  assert.equal(result.saved, result.found, 'every found company came back from the save step');
  assert.equal(result.logged, true, 'a row in scanner_runs');
  assert.equal(result.input_tokens, sum(calls, 'input_tokens'), 'input tokens are what the API reported');
  assert.equal(result.output_tokens, sum(calls, 'output_tokens'));
  assert.equal(result.total_tokens, result.input_tokens + result.output_tokens);
  assert.equal(result.web_searches, calls.filter((call) => call.searched).length);
  assert.equal(new Set(log.filter((line) => line.outcome !== 'retry').map((line) => line.angle)).size, result.angles_tried, 'each angle has one final outcome');
}

// Every call must list what the batches before it found (and what earlier
// runs found), and nothing else.
function checkExclusions(result, calls, earlierCompanies) {
  const batchOf = (call) => result.log.find((line) => line.angle === call.angle && line.attempt === call.attempt).batch;
  const foundBefore = (batch) => result.log.filter((line) => line.outcome === 'found' && line.batch < batch).map((line) => line.company);
  for (const call of calls) {
    const expected = [...earlierCompanies, ...foundBefore(batchOf(call))].map(plain).sort();
    assert.deepEqual(call.excluded.map(plain).sort(), expected, `angle ${call.angle}, batch ${batchOf(call)}: the exclusion list in the prompt`);
  }
}

function checkUnique(companies) {
  const domains = companies.map((row) => row.domain_key).filter(Boolean);
  const names = companies.map((row) => row.name_key);
  assert.equal(new Set(domains).size, domains.length, 'no website twice');
  assert.equal(new Set(names).size, names.length, 'no name twice');
}

const runs = {}; // results of earlier tests, for the later ones

before(async () => {
  await until(async () => (await fetch(`${STANDIN}/__state`)).ok, 60_000);
  // The webhook answers once n8n is up and the workflows are published.
  await until(async () => {
    const answer = await post('rows');
    return answer.status === 200 && Array.isArray(answer.json?.companies);
  }, 240_000);
});

test('the webhooks need the key', async () => {
  const answer = await post('run', { location: 'Testville', intent_signal: SIGNAL, runs: 2, target: 1 }, { 'content-type': 'application/json' });
  assert.equal(answer.status, 403);
  assert.equal((await standin()).calls.length, 0, 'no model call was made');
});

test('input that makes no sense is refused before any model call', async () => {
  const { result, calls } = await scan({ location: 'Testville', intent_signal: SIGNAL, runs: 0, target: 5 });
  assert.equal(result.ok, false);
  assert.equal(result.stopped, 'invalid_input');
  assert.match(result.error, /runs must be 1 or more/);
  assert.equal(calls.length, 0);
  assert.equal(result.logged, true);
});

test('run 1: 24 angles, a model that misbehaves in every way; only checked, unique companies are saved', async (t) => {
  const { result, calls, seconds } = await scan({ location: 'Testville', intent_signal: SIGNAL, lookback_hours: 96, runs: 24, target: 50, concurrency: 4 });
  runs.first = result;
  t.diagnostic(`${seconds.toFixed(1)} s. ${result.text}`);
  t.diagnostic(`rejected: ${JSON.stringify(result.rejected_why)}; duplicates: ${JSON.stringify(result.duplicates_why)}; retries: ${JSON.stringify(result.retries_why)}`);

  assert.equal(result.ok, true);
  assert.equal(result.stopped, 'angles_used_up', 'the target of 50 is out of reach, so every angle is tried');
  assert.equal(result.angles_planned, 24);
  assert.equal(result.angles_tried, 24);
  checkSums(result, calls);

  // The request is in the documented shape: Responses API, web search tool, sources, JSON schema.
  for (const call of calls) {
    assert.equal(call.model, 'stand-in-search');
    assert.deepEqual(call.shape, { web_search: true, tool_choice: 'required', include: ['web_search_call.action.sources'], format: 'json_schema', strict: true, required: ['company', 'website', 'signal', 'source_url', 'source_date'] });
    assert.notEqual(call.status, 400, 'the stand-in accepted the request shape');
    assert.notEqual(call.status, 401);
  }

  // The angles really differ.
  const angles = [...new Map(calls.map((call) => [call.angle, call.parts])).entries()].sort((a, b) => a[0] - b[0]).map(([, parts]) => parts);
  assert.equal(angles.length, 24);
  assert.equal(new Set(angles.map((parts) => JSON.stringify(parts))).size, 24, 'no angle twice');
  for (let i = 1; i < angles.length; i++) for (const part of ['area', 'industry', 'source', 'wording']) assert.notEqual(angles[i][part], angles[i - 1][part], `angle ${i + 1} differs from angle ${i} in ${part}`);
  assert.deepEqual([new Set(angles.map((a) => a.area)).size, new Set(angles.map((a) => a.industry)).size, new Set(angles.map((a) => a.source)).size, new Set(angles.map((a) => a.wording)).size], [4, 24, 9, 7]);
  assert.ok(angles.every((parts) => parts.area.includes('Testville') && parts.wording.includes(SIGNAL)));

  // Rejected, each for its own reason.
  assert.deepEqual(result.rejected_why, {
    stale_source: 1, // angle 5: the source is 10 days old
    no_source: 1, // angle 6
    source_not_in_search: 1, // angle 9: the web search did not return that page
    no_web_search: 1, // angle 10: answered from memory
    bad_json: 1, // angle 13: cut off twice
    nothing_found: 1, // angle 17
    rate_limited: 1, // angle 18: HTTP 429 three times
    no_source_date: 1, // angle 19
    source_date_in_future: 1, // angle 21
  });
  const outcome = (angle) => result.log.filter((line) => line.angle === angle).at(-1);
  assert.equal(outcome(5).company, 'Stale Corp');
  assert.equal(outcome(6).company, 'Sourceless Ltd');

  // Duplicates across angles are dropped: same pick in one batch, other spelling, no website.
  assert.equal(outcome(4).outcome, 'duplicate', 'angle 4 named the company of angle 1; both were in the first batch');
  assert.equal(outcome(4).company, outcome(1).company);
  assert.equal(outcome(14).outcome, 'duplicate', 'UPPER CASE name with ", Inc." and a www address with a path');
  assert.equal(outcome(15).outcome, 'duplicate', 'no website: the name decides');
  assert.equal(result.duplicates, 3);
  assert.deepEqual(result.duplicates_why, { found_in_this_run: 3 });

  // Repairs and retries.
  assert.equal(calls.filter((call) => call.angle === 2).length, 1, 'fenced JSON with chatter is repaired, not asked again');
  assert.equal(calls.filter((call) => call.angle === 3).length, 1, 'a comma too many is repaired, not asked again');
  assert.equal(outcome(2).outcome, 'found');
  assert.equal(outcome(3).outcome, 'found');
  assert.deepEqual(result.retries_why, { rate_limited: 3, bad_json: 2, api_error_500: 1 });
  assert.equal(outcome(7).outcome, 'found', 'HTTP 429 once, then found');
  assert.equal(outcome(11).outcome, 'found', 'cut-off JSON once, then found');
  assert.equal(outcome(22).outcome, 'found', 'HTTP 500 once, then found');
  assert.equal(outcome(23).outcome, 'found', 'a date without a time on the first day of the window is kept');
  assert.equal(outcome(24).outcome, 'found', 'a citation with a tracking parameter still matches the source');
  assert.equal(result.found, 12);

  // Rate limits: the retry waits for Retry-After, and the batches get smaller.
  const of = (angle) => calls.filter((call) => call.angle === angle);
  assert.ok(of(7)[1].at - of(7)[0].done_at >= 900, `the retry came ${of(7)[1].at - of(7)[0].done_at} ms after the 429 (Retry-After: 1)`);
  assert.equal(of(18).length, 3, 'three attempts, then given up');
  const batchOf = (call) => result.log.find((line) => line.angle === call.angle && line.attempt === call.attempt).batch;
  const peak = (from, to) => Math.max(...calls.filter((call) => batchOf(call) >= from && batchOf(call) <= to).map((call) => call.in_flight));
  const first429 = batchOf(of(7)[0]);
  const second429 = batchOf(of(18)[0]);
  assert.equal(peak(1, 1), 4, 'four calls at the same time in the first batch');
  assert.equal(peak(1, first429), 4, 'never more than the cap');
  assert.equal(peak(first429 + 1, second429), 2, 'two at a time after the first 429');
  assert.equal(peak(second429 + 1, result.batches), 1, 'one at a time after the second');
  t.diagnostic(`calls in flight: 4 until the first 429, then 2, then 1; ${result.batches} batches`);

  // The exclusion list in every prompt.
  checkExclusions(result, calls, []);
  assert.deepEqual(calls.filter((call) => batchOf(call) === 1).map((call) => call.excluded.length), [0, 0, 0, 0], 'the first batch has nothing to exclude');
  assert.ok(calls.at(-1).excluded.length >= 11, 'the last call lists what the run found so far');

  // What is in the data table.
  const { companies, runs: logged } = await rows();
  assert.equal(companies.length, 12);
  assert.deepEqual(companies.map((row) => row.company).sort(), result.companies.map((row) => row.company).sort());
  checkUnique(companies);
  for (const name of NEVER) assert.ok(!companies.some((row) => row.company === name), `${name} is not saved`);
  const cutoff = Date.parse(result.ran_at) - 96 * 3600 * 1000;
  for (const row of companies) {
    assert.match(row.source_url, /^https:\/\/news\.example\/funding\//, 'every row has its source');
    assert.ok(Date.parse(row.source_date.length === 10 ? `${row.source_date}T23:59:59Z` : row.source_date) >= cutoff, `${row.company}: source inside the window`);
    assert.ok(row.angle.includes('Testville'), 'the angle that found it is kept');
    assert.equal(row.run_id, result.run_id);
  }
  assert.equal(companies.find((row) => row.company === 'Tracked Link AG').domain_key, '', 'a LinkedIn page is not a company website');
  const run = logged.find((row) => row.run_id === result.run_id);
  assert.deepEqual([run.found, run.rejected, run.duplicates, run.retries, run.model_calls, run.total_tokens], [12, 9, 3, 6, 30, result.total_tokens]);
});

test('run 2: stops early at the target, starts from what run 1 found, adds no duplicate', async (t) => {
  const known = runs.first.companies.map((row) => row.company);
  const { result, calls } = await scan({ location: 'Testville', intent_signal: SIGNAL, runs: 40, target: 6, concurrency: 3 });
  runs.second = result;
  t.diagnostic(result.text);

  assert.equal(result.stopped, 'target_reached');
  assert.equal(result.known_before, 12);
  assert.ok(result.found >= 6 && result.found < 6 + 3, `${result.found} found: the target, plus at most the rest of the last batch`);
  assert.ok(result.angles_tried < 40 && result.angles_not_needed > 0, `${result.angles_tried} of 40 angles tried`);
  assert.ok(calls.length < 40, `${calls.length} model calls instead of 40`);
  assert.equal(Math.max(...calls.map((call) => call.angle)), result.angles_tried, 'no angle after the stop was asked');
  checkSums(result, calls);

  // From the very first call the prompt lists the 12 companies of run 1.
  checkExclusions(result, calls, known);
  assert.equal(calls[0].excluded.length, 12);

  // A company from run 1 that comes back is dropped as known.
  const again = result.log.find((line) => line.angle === 4);
  assert.equal(again.outcome, 'duplicate');
  assert.equal(again.reason, 'found_in_earlier_run');
  assert.ok(known.includes(again.company));

  const fresh = result.companies.map((row) => row.company);
  assert.ok(fresh.every((name) => !known.includes(name)), 'nothing from run 1 is found again');
  const { companies } = await rows();
  assert.equal(companies.length, 12 + result.found);
  checkUnique(companies);
  for (const name of NEVER) assert.ok(!companies.some((row) => row.company === name));
});

test('the lookback window is the setting: 1 hour rejects everything, 20 days lets the old source in', async (t) => {
  const before = (await rows()).companies.length;
  const narrow = await scan({ location: 'Testville', intent_signal: SIGNAL, lookback_hours: 1, runs: 3, target: 50, concurrency: 3 });
  assert.equal(narrow.result.found, 0);
  assert.deepEqual(narrow.result.rejected_why, { stale_source: 3 }, 'every source of the stand-in is at least 2 hours old');
  assert.equal(narrow.result.ok, true);
  checkSums(narrow.result, narrow.calls);
  assert.equal((await rows()).companies.length, before, 'a run that finds nothing adds nothing');

  const wide = await scan({ location: 'Testville', intent_signal: SIGNAL, lookback_hours: 480, runs: 6, target: 50, concurrency: 3 });
  checkSums(wide.result, wide.calls);
  const stale = wide.result.log.find((line) => line.angle === 5);
  assert.equal(stale.company, 'Stale Corp');
  assert.equal(stale.outcome, 'found', 'the 10-day-old source is inside a 20-day window');
  assert.deepEqual(wide.result.rejected_why, { no_source: 1 }, 'the answer without a source is still rejected');
  const { companies } = await rows();
  assert.equal(companies.length, before + wide.result.found);
  checkUnique(companies);
  t.diagnostic(`1 hour: ${narrow.result.text}`);
  t.diagnostic(`480 hours: ${wide.result.text}`);
});

test('the form starts a run too', async () => {
  const before = await rows();
  const form = new FormData();
  ['Formtown', 'opened a new office', '', '4', '2', 'Old Quarter, Docklands'].forEach((value, index) => form.set(`field-${index}`, value));
  const answer = await fetch(`${N8N}/form/account-scanner`, { method: 'POST', body: form });
  assert.equal(answer.status, 200, await answer.text());
  const run = await until(async () => (await rows()).runs.find((row) => row.location === 'Formtown'), 60_000);
  assert.equal(run.intent_signal, 'opened a new office');
  assert.equal(run.lookback_hours, 96, 'an empty field uses the value of the Settings node');
  assert.equal(run.angles_planned, 4);
  assert.equal(run.stopped, 'target_reached');
  assert.ok(run.found >= 2);
  const { companies } = await rows();
  assert.equal(companies.length, before.companies.length + run.found);
  const mine = companies.filter((row) => row.run_id === run.run_id);
  assert.ok(mine.every((row) => /^(Old Quarter|Docklands) \(Formtown\)/.test(row.angle)), 'the sub-areas of the form are the areas of the angles');
  checkUnique(companies);
});

test('a wrong API key stops the run after the first batch instead of burning every angle', async () => {
  await steer({ rejectKeys: true });
  const before = (await rows()).companies.length;
  const { result, calls } = await scan({ location: 'Testville', intent_signal: SIGNAL, runs: 30, target: 10, concurrency: 5 });
  await steer({ rejectKeys: false });
  assert.equal(result.ok, false);
  assert.equal(result.stopped, 'api_error');
  assert.match(result.error, /HTTP 401.*Incorrect API key/);
  assert.equal(calls.length, 5, 'one batch, not 30 calls');
  assert.equal(result.found, 0);
  assert.equal(result.angles_not_needed, 25);
  checkSums(result, calls);
  assert.equal((await rows()).companies.length, before);
});

test('an empty request runs with the Settings values (what "Execute workflow" does): 50 angles against a web that is nearly used up', async (t) => {
  const before = (await rows()).companies;
  const { result, calls, seconds } = await scan({});
  t.diagnostic(`${seconds.toFixed(1)} s. ${result.text}`);
  t.diagnostic(`duplicates: ${JSON.stringify(result.duplicates_why)}`);
  assert.deepEqual([result.location, result.intent_signal, result.lookback_hours, result.target], ['Austin, Texas', SIGNAL, 96, 40]);
  assert.equal(result.angles_planned, 50);
  assert.equal(result.known_before, before.length);
  assert.equal(result.stopped, 'angles_used_up', 'the stand-in has fewer than 40 companies left');
  assert.equal(new Set(calls.map((call) => JSON.stringify(call.parts))).size, 50, '50 different angles');
  checkSums(result, calls);
  checkExclusions(result, calls, before.map((row) => row.company));
  // Once the stand-in has nothing new, it names known companies again; they are dropped.
  assert.ok(result.duplicates_why.found_in_earlier_run > 0 || result.duplicates_why.found_in_this_run > 0);
  const { companies } = await rows();
  assert.equal(companies.length, before.length + result.found);
  checkUnique(companies);
  // Stale Corp is in the table since the 20-day run; the others never get in.
  for (const name of NEVER.filter((entry) => entry !== 'Stale Corp')) assert.ok(!companies.some((row) => row.company === name), `${name} is not saved`);
  const pool = (await standin()).pool;
  assert.ok(pool.every((name) => companies.some((row) => row.company === name)), 'all 30 companies of the stand-in were found, each once');
});
