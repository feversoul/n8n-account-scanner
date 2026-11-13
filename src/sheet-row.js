// The columns that go to the sheet, in this order. Put the same names in row 1
// of your sheet. Remove a line here to leave a column out.
return $input.all().map((item) => ({
  json: {
    company: item.json.company,
    website: item.json.website,
    signal: item.json.signal,
    source_url: item.json.source_url,
    source_date: item.json.source_date,
    angle: item.json.angle,
    location: item.json.location,
    intent_signal: item.json.intent_signal,
    found_at: item.json.found_at,
    run_id: item.json.run_id,
  },
}));
