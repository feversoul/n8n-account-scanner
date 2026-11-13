// Change these, then save. The form and the webhook can send their own
// location, intent signal, lookback hours, runs, target and sub-areas; what
// they leave out comes from here. "Execute workflow" uses these values as is.

// --- what to look for ---
const LOCATION = 'Austin, Texas';
const INTENT_SIGNAL = 'announced a new funding round';
const LOOKBACK_HOURS = 96; // a source older than this is rejected
const RUNS = 50; // how many search angles to plan (your "50 chats")
const TARGET = 40; // stop as soon as this many new companies are found
const SUB_AREAS = ''; // optional, comma separated: 'Downtown, East Austin, Round Rock'. Empty = generic areas.

// --- the model ---
// An API that speaks the OpenAI Responses format with the built-in web search
// tool. The key is in the credential "Account Scanner Model".
const MODEL_BASE_URL = 'https://api.openai.com/v1'; // without /responses
const MODEL = 'gpt-6-astra'; // any model that supports the web_search tool
const STRUCTURED_OUTPUT = true; // send the JSON schema with the request. Set to false if your server rejects "text.format".
// Is the source the model names a page its web search really returned?
//   'url'    the exact page must be among the citations or sources of the answer
//   'domain' its website must be among them
//   'off'    do not check
const CITED_SOURCE_CHECK = 'url';

// --- pace ---
const CONCURRENCY = 5; // model calls at the same time. Each batch gets the companies found by the batches before it.
const PAUSE_BETWEEN_BATCHES_SECONDS = 0;
const MAX_ATTEMPTS = 3; // tries per angle when the API says "too many requests" or is down
const RETRY_WAIT_SECONDS = 10; // doubled per attempt; a Retry-After header from the API wins
const MAX_WAIT_SECONDS = 60;
const EXCLUDE_LIST_MAX = 200; // how many known companies the prompt lists (newest first). Dedupe always checks all of them.
const MAX_RUNS = 200;

// ---------------------------------------------------------------------------
const first = $input.first().json ?? {};
const raw = first.body && typeof first.body === 'object' ? first.body : first;
const sent = {};
for (const [key, value] of Object.entries(raw)) sent[key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')] = value;
// The form hands over an empty number field as 0: that means "not filled in".
const fromForm = 'submittedAt' in first || 'formMode' in first;
const given = (value) => value !== undefined && value !== null && String(value).trim() !== '' && !(fromForm && value === 0);
const pick = (...names) => {
  for (const name of names) if (given(sent[name])) return sent[name];
  return undefined;
};
const text = (value, fallback) => String(value ?? fallback).trim();
const number = (value, fallback) => (value === undefined ? fallback : Number(value));

return [
  {
    json: {
      location: text(pick('location'), LOCATION),
      intent_signal: text(pick('intent_signal', 'signal'), INTENT_SIGNAL),
      lookback_hours: number(pick('lookback_hours', 'lookback'), LOOKBACK_HOURS),
      runs: number(pick('runs', 'number_of_runs'), RUNS),
      target: number(pick('target', 'target_count'), TARGET),
      sub_areas: text(pick('sub_areas'), SUB_AREAS),
      concurrency: number(pick('concurrency'), CONCURRENCY),
      model_base_url: MODEL_BASE_URL.replace(/\/+$/, ''),
      model: MODEL,
      structured_output: STRUCTURED_OUTPUT,
      cited_source_check: CITED_SOURCE_CHECK,
      pause_seconds: PAUSE_BETWEEN_BATCHES_SECONDS,
      max_attempts: MAX_ATTEMPTS,
      retry_wait_seconds: RETRY_WAIT_SECONDS,
      max_wait_seconds: MAX_WAIT_SECONDS,
      exclude_list_max: EXCLUDE_LIST_MAX,
      max_runs: MAX_RUNS,
    },
  },
];
