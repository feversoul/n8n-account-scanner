// Takes the next few angles from the queue and writes one request per angle.
// Every request lists the companies that are already known: those of earlier
// runs and those the batches before this one found. That list is what makes
// the later calls look somewhere new instead of returning the same names.
//
// The request follows OpenAI's Responses API with the built-in web search tool:
// https://developers.openai.com/api/docs/guides/tools-web-search
const state = $input.first().json;
const s = state.settings;

const exclude = [...state.found.map((row) => (row.domain_key ? `${row.company} (${row.domain_key})` : row.company)).reverse(), ...state.exclude_earlier].slice(0, s.exclude_list_max);

const SYSTEM = [
  'You find companies for a sales prospect list by searching the web.',
  'Always search the web before you answer. Never answer from memory.',
  'Report exactly one company, and only if a page you found in this search shows the signal. That page is your source: give its exact URL and the date it was published.',
  'If you find no company that fits, answer with an empty string in every field. An empty answer is better than a guess.',
  'Answer with one JSON object and nothing else: {"company": "", "website": "", "signal": "", "source_url": "", "source_date": ""}',
  "company: the company's name. website: its own website, not a social profile. signal: one sentence on what happened. source_url: the page that shows it. source_date: when that page was published, as YYYY-MM-DD or a full ISO 8601 time.",
].join('\n');

const SCHEMA = {
  type: 'object',
  properties: {
    company: { type: 'string' },
    website: { type: 'string' },
    signal: { type: 'string' },
    source_url: { type: 'string' },
    source_date: { type: 'string' },
  },
  required: ['company', 'website', 'signal', 'source_url', 'source_date'],
  additionalProperties: false,
};

const take = state.queue.slice(0, state.concurrency);
return take.map((index, position) => {
  const angle = state.angles[index];
  const prompt = [
    `Search angle ${index + 1} of ${state.angles.length}.`,
    `Find one company in ${s.location} with this signal: ${s.intent_signal}`,
    `The source must be published after ${state.cutoff_at} (the last ${s.lookback_hours} hours; it is now ${state.started_at}).`,
    `Where to look: ${angle.area}`,
    `Industry: ${angle.industry}`,
    `Kind of source: ${angle.source}`,
    `How the signal may show up: ${angle.wording}`,
    '',
    exclude.length ? 'Already on the list. Do not report these again, find a different company:' : 'Nothing is on the list yet.',
    ...exclude.map((entry) => `- ${entry}`),
  ].join('\n');

  const request = {
    model: s.model,
    input: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt },
    ],
    tools: [{ type: 'web_search' }],
    tool_choice: 'required', // the search must run
    include: ['web_search_call.action.sources'], // every URL the search read, to check the source against
  };
  if (s.structured_output) request.text = { format: { type: 'json_schema', name: 'company_signal', schema: SCHEMA, strict: true } };

  return {
    json: {
      angle_index: index,
      attempt: (state.attempts[index] ?? 0) + 1,
      wait_seconds: state.wait_seconds,
      request,
      // The whole state rides on the first item, so "Read answers" can pick it up after the HTTP node.
      ...(position === 0 ? { state } : {}),
    },
  };
});
