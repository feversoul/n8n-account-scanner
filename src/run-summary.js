// What the run did, counted from its log. Every model call is one log line,
// and every angle that was tried ends as found, rejected or duplicate, so:
//   model_calls  = angles_tried + retries
//   angles_tried = found + rejected + duplicates
const state = $('Finish').first().json;
const s = state.settings;
const count = (list) => list.reduce((totals, key) => ({ ...totals, [key]: (totals[key] ?? 0) + 1 }), {});

const final = state.log.filter((line) => line.outcome !== 'retry');
const rejected = final.filter((line) => line.outcome === 'rejected');
const duplicates = final.filter((line) => line.outcome === 'duplicate');
const retries = state.log.filter((line) => line.outcome === 'retry');
const found = state.found.length;
// Rows that came back from the save step (none when nothing was found).
const saved = $input.all().filter((item) => item.json && item.json.company).length;

const stoppedText = {
  target_reached: `stopped early: the target of ${s.target} was reached`,
  angles_used_up: 'all angles were tried',
  api_error: `stopped: ${state.fatal}`,
  invalid_input: `nothing was searched: ${state.error}`,
}[state.stopped];

return [
  {
    json: {
      ok: state.stopped === 'target_reached' || state.stopped === 'angles_used_up',
      run_id: state.run_id,
      ran_at: state.started_at,
      location: s.location,
      intent_signal: s.intent_signal,
      lookback_hours: s.lookback_hours,
      target: s.target,
      stopped: state.stopped,
      error: state.error ?? state.fatal ?? null,
      angles_planned: state.angles.length,
      angles_tried: final.length,
      angles_not_needed: state.angles.length - final.length,
      found,
      saved,
      rejected: rejected.length,
      rejected_why: count(rejected.map((line) => line.reason)),
      duplicates: duplicates.length,
      duplicates_why: count(duplicates.map((line) => line.reason)),
      retries: retries.length,
      retries_why: count(retries.map((line) => line.reason)),
      model_calls: state.model_calls,
      batches: state.batch,
      web_searches: state.web_searches,
      input_tokens: state.input_tokens,
      output_tokens: state.output_tokens,
      total_tokens: state.total_tokens,
      known_before: state.earlier_count,
      text: `${found} new ${found === 1 ? 'company' : 'companies'} from ${final.length} of ${state.angles.length} angles (${stoppedText}). Rejected ${rejected.length}, duplicates ${duplicates.length}, retries ${retries.length}. ${state.model_calls} model calls, ${state.total_tokens} tokens.`,
      companies: state.found.map((row) => ({ company: row.company, website: row.website, signal: row.signal, source_url: row.source_url, source_date: row.source_date, angle_number: row.angle_number })),
      log: state.log,
    },
  },
];
