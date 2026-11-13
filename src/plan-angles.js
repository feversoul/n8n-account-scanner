// Plans the run: N search angles that all differ, and what is already known
// from earlier runs. One item comes out: the state that travels round the loop.
//
// An angle is one value from each list below. The lists have 4, 25, 9 and 7
// entries, numbers that share no divisor, so angle 1, 2, 3 ... change in every
// respect at once and no combination repeats before 6,300 angles. Edit the
// lists to fit your market; any lengths work, the planner skips repeats.

const AREAS = (location) => [
  `anywhere in ${location}`,
  `the centre of ${location}`,
  `the outskirts, suburbs and business parks of ${location}`,
  `smaller towns and districts in and around ${location}`,
];
const INDUSTRIES = [
  'software and SaaS', 'healthcare and medical practices', 'manufacturing', 'construction and building trades', 'retail and e-commerce',
  'financial services and fintech', 'logistics and transport', 'food and beverage', 'professional services (legal, accounting, consulting)', 'real estate and property',
  'energy and utilities', 'education and training', 'hospitality, travel and leisure', 'biotech and life sciences', 'media, marketing and advertising',
  'telecoms and IT services', 'automotive and mobility', 'agriculture and food production', 'non-profits and public sector suppliers', 'consumer goods',
  'hardware, electronics and robotics', 'insurance', 'security and defence', 'sports, fitness and wellness', 'any industry not usually in the news',
];
const SOURCES = [
  'local and regional news sites', 'press release wires', "the company's own newsroom or blog", 'LinkedIn posts by the company or its leaders', 'trade and industry publications',
  'business journals and startup news', 'job boards and careers pages', 'public filings, registries and government notices', 'newsletters, podcasts and community forums',
];
const WORDINGS = (signal) => [
  `${signal}`,
  `an official announcement of: ${signal}`,
  `news coverage reporting: ${signal}`,
  `a founder or executive writing about: ${signal}`,
  `early signs (job ads, filings, permits, supplier notices) of: ${signal}`,
  `the same thing described in other words or in the local language: ${signal}`,
  `a customer, partner or investor mentioning: ${signal}`,
];

/* __KEYS__ */

const settings = $('Settings').first().json;
const whole = (value) => (Number.isFinite(value) ? Math.floor(value) : NaN);
const runs = whole(settings.runs);
const target = whole(settings.target);
const hours = Number(settings.lookback_hours);

let error = null;
if (!settings.location || !settings.intent_signal) error = 'location and intent_signal are required';
else if (!(runs >= 1)) error = 'runs must be 1 or more';
else if (!(target >= 1)) error = 'target must be 1 or more';
else if (!(hours > 0)) error = 'lookback_hours must be more than 0';

// --- the angles ---
const angles = [];
if (!error) {
  const own = settings.sub_areas.split(',').map((area) => area.trim()).filter(Boolean);
  const areas = own.length ? own.map((area) => `${area} (${settings.location})`) : AREAS(settings.location);
  const wordings = WORDINGS(settings.intent_signal);
  const used = new Set();
  const wanted = Math.min(runs, settings.max_runs);
  for (let i = 0; angles.length < wanted && i < wanted * 20; i++) {
    const angle = { area: areas[i % areas.length], industry: INDUSTRIES[i % INDUSTRIES.length], source: SOURCES[i % SOURCES.length], wording: wordings[i % wordings.length] };
    const key = [angle.area, angle.industry, angle.source, angle.wording].join('|');
    if (used.has(key)) continue;
    used.add(key);
    angles.push(angle);
  }
}

// --- what earlier runs found ---
const earlier = $input
  .all()
  .map((item) => item.json)
  .filter((row) => row && row.company)
  .sort((a, b) => String(b.found_at ?? '').localeCompare(String(a.found_at ?? '')));
const domains = [];
const names = [];
for (const row of earlier) {
  const d = row.domain_key || domainKey(row.website);
  const n = row.name_key || nameKey(row.company);
  if (d) domains.push([d, 'earlier']);
  if (n) names.push([n, 'earlier', Boolean(d)]);
}

const concurrency = Math.max(1, Math.min(whole(settings.concurrency) || 1, 20));
const started = Date.now();
return [
  {
    json: {
      run_id: `${$now.toFormat('yyyyLLdd-HHmmss')}-${$execution.id}`,
      started_at: new Date(started).toISOString(),
      cutoff_at: new Date(started - hours * 3600 * 1000).toISOString(),
      settings: { ...settings, runs, target, lookback_hours: hours },
      error,
      angles,
      queue: angles.map((_, index) => index), // angles still to ask, by position
      attempts: {}, // angle position -> calls made
      concurrency,
      start_concurrency: concurrency,
      batch: 0,
      wait_seconds: 0,
      more: !error && angles.length > 0,
      stopped: error ? 'invalid_input' : null,
      earlier_count: earlier.length,
      exclude_earlier: earlier.slice(0, settings.exclude_list_max).map((row) => (row.domain_key ? `${row.company} (${row.domain_key})` : row.company)),
      domains,
      names,
      found: [],
      log: [],
      model_calls: 0,
      web_searches: 0,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
    },
  },
];
