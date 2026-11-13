// Stand-in for the model API in the tests. It makes no model call and no web
// search. It answers POST /v1/responses in the shape of OpenAI's Responses API
// with the built-in web search tool, as documented on
// https://developers.openai.com/api/docs/guides/tools-web-search :
//
//   output: [
//     { type: 'web_search_call', id, status, action: { type: 'search', query, sources: [{ type: 'url', url }] } },
//     { type: 'message', id, status, role: 'assistant',
//       content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', start_index, end_index, url, title }] }] },
//   ],
//   usage: { input_tokens, output_tokens, total_tokens }
//
// `sources` is only there when the request asks for it with
// include: ['web_search_call.action.sources']. A request that is not in the
// documented shape gets HTTP 400, a wrong key HTTP 401.
//
// The "web" is a pool of 30 companies with a fresh source each. Like a model
// with a favourite answer, the stand-in picks among the first eight companies
// that are NOT on the exclusion list of the prompt, so the list decides whether
// a call finds something new. Some angle numbers misbehave on purpose:
//
//    2  fenced JSON with chatter around it        13  cut-off JSON, every time
//    3  JSON with a comma too many                14  a known company again, other spelling of name and website
//    4  the same pick as angle 1 (same batch),    15  a known company again, without a website
//       or an old favourite from the list         17  "found nothing": empty fields
//    5  a source that is 10 days old              18  HTTP 429, every time
//    6  no source URL                             19  no source date
//    7  HTTP 429 once (Retry-After: 1)            21  a source dated 5 days in the future
//    9  a source URL the search never returned    22  HTTP 500 once
//   10  an answer without any web search          23  a date without a time, on the edge of the window
//   11  cut-off JSON once                         24  citation with a tracking parameter; website is a LinkedIn page
//
//   GET  /__state   { calls, pool }
//   POST /__set     { rejectKeys }

import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

const MODEL_KEY = 'test-model-key';
const HOUR = 3600 * 1000;
const WORDS = ['Alder', 'Birch', 'Cedar', 'Dune', 'Ember', 'Fjord', 'Grove', 'Harbor', 'Iris', 'Juniper', 'Kestrel', 'Lumen', 'Maple', 'Nimbus', 'Orchard', 'Pebble', 'Quill', 'Ridge', 'Sable', 'Tundra', 'Umber', 'Vale', 'Willow', 'Xenia', 'Yarrow', 'Zephyr', 'Anchor', 'Beacon', 'Cobalt', 'Drift'];
const KINDS = ['Labs', 'Logistics', 'Health', 'Foods', 'Energy'];
const pool = WORDS.map((word, i) => {
  const kind = KINDS[i % KINDS.length];
  const slug = `${word}${kind}`.toLowerCase();
  return { company: `${word} ${kind}`, website: `https://${slug}.example`, signal: `${word} ${kind} announced a new funding round.`, source_url: `https://news.example/funding/${slug}`, age_hours: 2 + ((i * 7) % 88) };
});

const state = { rejectKeys: false, calls: [], seen: {}, inFlight: 0 };

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const read = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};
const tokens = (text) => Math.ceil(text.length / 4);
const plain = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// What is wrong with the request, compared with the documented shape.
function shapeProblems(body) {
  const problems = [];
  if (typeof body.model !== 'string' || !body.model) problems.push('model');
  if (!Array.isArray(body.input) || !body.input.every((part) => typeof part?.role === 'string' && typeof part?.content === 'string')) problems.push('input');
  if (!Array.isArray(body.tools) || !body.tools.some((tool) => tool?.type === 'web_search')) problems.push('tools');
  if (body.text !== undefined) {
    const format = body.text?.format;
    if (format?.type !== 'json_schema' || typeof format.name !== 'string' || typeof format.schema !== 'object') problems.push('text.format');
  }
  return problems;
}

function answer(body, call) {
  const user = body.input.filter((part) => part.role === 'user').map((part) => part.content).join('\n');
  const lines = user.split('\n');
  const angle = Number(/Search angle (\d+) of \d+/.exec(user)?.[1] ?? 0);
  const run = /it is now ([^)]+)\)/.exec(user)?.[1] ?? '';
  const listed = lines.filter((line) => line.startsWith('- ')).map((line) => line.slice(2));
  const excluded = listed.map((line) => line.replace(/\s*\([^)]*\)\s*$/, ''));
  const part = (label) => lines.find((line) => line.startsWith(`${label}: `))?.slice(label.length + 2) ?? '';
  const key = `${run}#${angle}`;
  const attempt = (state.seen[key] = (state.seen[key] ?? 0) + 1);
  Object.assign(call, { run, angle, attempt, excluded, listed, parts: { area: part('Where to look'), industry: part('Industry'), source: part('Kind of source'), wording: part('How the signal may show up') } });

  const now = Date.now();
  const at = (hoursAgo) => new Date(now - hoursAgo * HOUR).toISOString();
  const free = pool.filter((entry) => !excluded.some((name) => plain(name) === plain(entry.company)));
  const pick = (number) => {
    const entry = free.length ? free[(number * 3) % Math.min(8, free.length)] : pool[0];
    return { company: entry.company, website: entry.website, signal: entry.signal, source_url: entry.source_url, source_date: at(entry.age_hours) };
  };
  const extra = (name, hoursAgo, change = {}) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return { company: name, website: `https://${slug}.example`, signal: `${name} announced a new funding round.`, source_url: `https://news.example/funding/${slug}`, source_date: at(hoursAgo), ...change };
  };

  let row = pick(angle);
  let text = null; // the answer text, when it is not just the JSON of `row`
  let searched = true;
  let cited = null; // the address the search returned, when it differs from row.source_url
  let kind = 'pick';

  if (angle === 2) {
    kind = 'fenced';
    text = `Here is what I found:\n\n\`\`\`json\n${JSON.stringify(row, null, 2)}\n\`\`\`\n\nLet me know if you want more.`;
  } else if (angle === 3) {
    kind = 'comma';
    text = JSON.stringify(row).replace(/}$/, ',}');
  } else if (angle === 4) {
    kind = 'again';
    if (listed.length) {
      // An old favourite: the last entry of the list, as the list wrote it.
      const last = listed[listed.length - 1];
      row = { ...row, company: last.replace(/\s*\([^)]*\)\s*$/, ''), website: /\(([^)]*)\)\s*$/.exec(last)?.[1] ?? '' };
    } else row = pick(1);
  } else if (angle === 5) {
    kind = 'stale';
    row = extra('Stale Corp', 240);
  } else if (angle === 6) {
    kind = 'no_source';
    row = extra('Sourceless Ltd', 5, { source_url: '' });
  } else if (angle === 7 && attempt === 1) {
    kind = '429';
  } else if (angle === 9) {
    kind = 'invented_source';
    row = extra('Invented GmbH', 5);
    cited = 'https://news.example/funding/something-else';
  } else if (angle === 10) {
    kind = 'no_search';
    row = extra('Memory Only Inc', 5);
    searched = false;
  } else if ((angle === 11 && attempt === 1) || angle === 13) {
    kind = 'cut_off';
    text = JSON.stringify(row).slice(0, 40);
  } else if (angle === 14 && listed.length) {
    kind = 'again_other_spelling';
    const first = listed[0];
    const domain = /\(([^)]*)\)\s*$/.exec(first)?.[1] ?? '';
    row = { ...row, company: `${first.replace(/\s*\([^)]*\)\s*$/, '').toUpperCase()}, Inc.`, website: domain ? `HTTPS://WWW.${domain.toUpperCase()}/about-us?ref=search` : '' };
  } else if (angle === 15 && listed.length) {
    kind = 'again_no_website';
    row = { ...row, company: `${listed[0].replace(/\s*\([^)]*\)\s*$/, '').toLowerCase()} llc`, website: '' };
  } else if (angle === 17) {
    kind = 'nothing';
    row = { company: '', website: '', signal: '', source_url: '', source_date: '' };
    cited = 'https://news.example/';
  } else if (angle === 18) {
    kind = '429';
  } else if (angle === 19) {
    kind = 'no_date';
    row = extra('Dateless Partners', 5, { source_date: '' });
  } else if (angle === 21) {
    kind = 'future';
    row = extra('Tomorrow Ventures', -120);
  } else if (angle === 22 && attempt === 1) {
    kind = '500';
  } else if (angle === 23) {
    kind = 'edge_date';
    const hours = Number(/the last ([\d.]+) hours/.exec(user)?.[1] ?? 96);
    row = extra('Edge Case Co', 0, { source_date: at(hours).slice(0, 10) }); // the day the window starts, without a time
  } else if (angle === 24) {
    kind = 'tracked_citation';
    row = extra('Tracked Link AG', 6, { website: 'https://www.linkedin.com/company/tracked-link' });
    cited = `${row.source_url}/?utm_source=openai#top`;
  }
  call.kind = kind;

  if (kind === '429') return { status: 429, headers: { 'retry-after': '1' }, body: { error: { message: 'Rate limit reached for requests. Please try again in 1s.', type: 'rate_limit_error', code: 'slow_down' } } };
  if (kind === '500') return { status: 500, headers: {}, body: { error: { message: 'The server had an error while processing your request.', type: 'server_error', code: null } } };

  text ??= JSON.stringify(row);
  call.company = row.company;
  const url = cited ?? row.source_url;
  const start = Math.max(0, text.indexOf(row.source_url));
  const output = [];
  if (searched) {
    const action = { type: 'search', query: `${body.model} ${angle}` };
    if (Array.isArray(body.include) && body.include.includes('web_search_call.action.sources')) action.sources = [{ type: 'url', url: 'https://news.example/' }, ...(url ? [{ type: 'url', url }] : [])];
    output.push({ type: 'web_search_call', id: `ws_${call.n}`, status: 'completed', action });
  }
  output.push({
    id: `msg_${call.n}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: searched && url ? [{ type: 'url_citation', start_index: start, end_index: start + row.source_url.length, url, title: `${row.company}: news` }] : [] }],
  });
  call.searched = searched;
  call.input_tokens = tokens(JSON.stringify(body.input));
  call.output_tokens = tokens(text);
  return {
    status: 200,
    headers: {},
    body: {
      id: `resp_${call.n}`,
      object: 'response',
      created_at: Math.floor(now / 1000),
      status: 'completed',
      model: body.model,
      output,
      usage: { input_tokens: call.input_tokens, output_tokens: call.output_tokens, total_tokens: call.input_tokens + call.output_tokens },
    },
  };
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://standin');
  if (req.method === 'GET' && url.pathname === '/__state') return json(res, 200, { calls: state.calls, pool: pool.map((entry) => entry.company) });
  if (req.method === 'POST' && url.pathname === '/__set') {
    Object.assign(state, JSON.parse((await read(req)) || '{}'));
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/v1/responses') {
    state.inFlight += 1;
    const call = { n: state.calls.length + 1, at: Date.now(), in_flight: state.inFlight };
    state.calls.push(call);
    let reply;
    try {
      const body = JSON.parse(await read(req));
      call.model = body.model;
      call.shape = {
        web_search: Array.isArray(body.tools) && body.tools.some((tool) => tool?.type === 'web_search'),
        tool_choice: body.tool_choice,
        include: body.include,
        format: body.text?.format?.type,
        strict: body.text?.format?.strict,
        required: body.text?.format?.schema?.required,
      };
      const problems = shapeProblems(body);
      if (state.rejectKeys || req.headers.authorization !== `Bearer ${MODEL_KEY}`) reply = { status: 401, headers: {}, body: { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } } };
      else if (problems.length) reply = { status: 400, headers: {}, body: { error: { message: `Invalid request: ${problems.join(', ')}`, type: 'invalid_request_error', code: null } } };
      else reply = answer(body, call);
    } catch (error) {
      reply = { status: 400, headers: {}, body: { error: { message: `Bad request: ${error.message}`, type: 'invalid_request_error', code: null } } };
    }
    await sleep(150); // long enough for the calls of one batch to overlap
    call.status = reply.status;
    call.done_at = Date.now();
    state.inFlight -= 1;
    return json(res, reply.status, reply.body, reply.headers);
  }
  json(res, 404, { error: { message: 'not found' } });
}).listen(8080, () => console.log('stand-in on :8080'));
