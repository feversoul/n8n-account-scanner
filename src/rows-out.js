// Everything in the two data tables, for a look from outside n8n.
const rows = (name) => $(name).all().map((item) => item.json).filter((row) => row && row.run_id);
return [{ json: { companies: rows('Companies'), runs: rows('Runs') } }];
