// One item per new company: the row that is saved.
const state = $('Finish').first().json;
const s = state.settings;
return state.found.map((row) => ({
  json: {
    company: row.company,
    website: row.website,
    domain_key: row.domain_key,
    name_key: row.name_key,
    signal: row.signal,
    source_url: row.source_url,
    source_date: row.source_date,
    angle: row.angle,
    location: s.location,
    intent_signal: s.intent_signal,
    run_id: state.run_id,
    found_at: state.started_at,
  },
}));
