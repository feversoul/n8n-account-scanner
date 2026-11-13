# n8n account scanner

[![test](https://github.com/feversoul/n8n-account-scanner/actions/workflows/test.yml/badge.svg)](https://github.com/feversoul/n8n-account-scanner/actions/workflows/test.yml)

One click instead of 50 chats. You give it a location and an intent signal ("announced a new funding round"). It plans N different search angles, asks a model with **web search** once per angle, and keeps the companies that are new and come with a fresh source.

One n8n workflow on **Data Tables** and built-in nodes: no external database, no community nodes. The model call is a plain HTTP Request in the shape of the OpenAI Responses API with its built-in web search tool.

**Read this first.** The workflows were tested on a real n8n against a stand-in for the model API. **No real model and no real web search was called**, so nothing here says how good the companies are that a real model finds. A model can still name a company or a source that is wrong. That is why every row keeps its `source_url`: open it before you contact anyone.

| Asked in the thread | What you get |
| --- | --- |
| "I open 50 chats and type the same prompt" | Press **Execute workflow**, or fill in a form. `RUNS = 50` plans 50 angles; nothing is typed twice. |
| One chat gives few companies and many repeats, 50 separate chats give about 40 | Each angle is its own model call with its own search, like a separate chat. Each batch is also told which companies are already on the list, so it looks somewhere new. |
| "in the past 96 hours" | `LOOKBACK_HOURS = 96`. The model must give the date of its source. A source older than the window, or without a date, is rejected. |
| "add it to {google sheet}" | New companies go to a data table (tested). A Google Sheets **Append row** node is the last step, switched off until you set it up (not tested, see [Google Sheets](#google-sheets)). |
| Duplicates | Dropped on the website's domain, or on the name when there is no website. Within the run and against every earlier run. |
| "watch the cost" (from the replies) | The run stops as soon as `TARGET` companies are found. The summary counts model calls, web searches and the tokens the API reports. |

## How it works

```
Run by hand / form / webhook
  → Settings  → Earlier companies (data table)  → Plan angles
  → loop:  Next batch (a few angles + the exclusion list)
           → Search the web (one model call per angle, at the same time)
           → Read answers (check source and date, dedupe, queue retries)
           → More to do?  (target reached or angles used up → out)
  → Save company (data table)  → Append to Google Sheet (off)  → Run summary  → Log run
```

**Angles.** An angle is one value from each of four lists in the **Plan angles** node: area (4), industry (25), kind of source (9) and wording of the signal (7). Angle 1, 2, 3 … move through all four lists at once, so neighbours differ in every respect and no combination repeats. The lists are plain text: edit them for your market. The areas are generic ("the centre of …", "smaller towns around …") unless you name your own in `SUB_AREAS`.

**The exclusion list.** Before each batch the prompt gets the companies found so far, in this run and in earlier runs (the newest 200). Angles in the same batch cannot see each other's answers, so `CONCURRENCY` is a trade: 5 is faster, 1 gives every call the freshest list.

**The model call.** `POST {MODEL_BASE_URL}/responses`, following OpenAI's [web search guide](https://developers.openai.com/api/docs/guides/tools-web-search):

```json
{
  "model": "gpt-6-astra",
  "input": [{ "role": "system", "content": "…" }, { "role": "user", "content": "…" }],
  "tools": [{ "type": "web_search" }],
  "tool_choice": "required",
  "include": ["web_search_call.action.sources"],
  "text": { "format": { "type": "json_schema", "name": "company_signal", "strict": true, "schema": { "…": "company, website, signal, source_url, source_date" } } }
}
```

The answer text is read from `output[].content[].text` of the `message` item, the cited pages from its `url_citation` annotations and from `action.sources` of the `web_search_call` items, the tokens from `usage`. The `text.format` part is from the [structured outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs). The model name is the one those pages use in their examples; any model that supports `web_search` should do.

**What an answer must pass**, in this order. The first failed check is the reason in the summary:

| Reason | Meaning |
| --- | --- |
| `bad_json` | Not usable JSON. Code fences, text around the JSON and a comma too many are repaired. Otherwise the angle is asked once more. |
| `nothing_found` | The model said it found no company. |
| `no_source` | No `source_url`. |
| `no_web_search` | The answer has no `web_search_call`: it came from memory. |
| `source_not_in_search` | The `source_url` is not among the pages the search returned. |
| `no_source_date`, `stale_source`, `source_date_in_future` | The date is missing, older than the lookback window, or more than two days ahead. A date without a time counts as the end of that day. |
| duplicate | Same website domain (`https://www.Acme.io/about` = `acme.io`), or same name (`ACME, Inc.` = `acme`) when one of the two has no website of its own. A LinkedIn or Crunchbase page does not count as a website. |

**Rate limits.** An HTTP 429 or 5xx puts the angle back in the queue. The next batch waits for the `Retry-After` the API names (else 10 s, doubled per attempt, 60 s at most). After a 429 the batches are half as big for the rest of the run. An angle is given up after 3 attempts. A 400, 401, 403 or 404 stops the run after that batch: a wrong key should not cost 50 calls.

**The summary** is the output of the last node and one row in `scanner_runs`:

```
12 new companies from 24 of 24 angles (all angles were tried). Rejected 9, duplicates 3, retries 6. 30 model calls, 11237 tokens.
```

with `rejected_why`, `duplicates_why`, `retries_why`, `web_searches`, `input_tokens`, `output_tokens` and a `log` with one line per model call (angle, batch, attempt, outcome, company, source). The numbers always satisfy `model_calls = angles_tried + retries` and `angles_tried = found + rejected + duplicates`.

## Add it to your n8n

Needs an n8n with Data Tables (tested on 2.47.7). Works the same on n8n Cloud; only built-in nodes are used.

1. Import `workflows/1-account-scanner.json` (**Workflows → Import from file**).
2. Create a credential of type **OpenAI** named `Account Scanner Model` with your API key. Open the node **Search the web** and select it.
3. Open **Settings**: location, intent signal, lookback hours, runs, target, and the model name. Start with `RUNS = 3`.
4. Press **Execute workflow**. The companies are in **Data tables → scanner_companies**, the summary is the output of **Result**.
5. Optional: publish the workflow and open `https://<your n8n>/form/account-scanner` to start a run from a form with its own location and signal.

The two data tables are created by the first run. Do not start two runs at the same moment: each reads the list once at its start, so they could both add the same company.

### Google Sheets

The node **Append to Google Sheet** is in the workflow but deactivated, so the workflow runs without a Google account.

1. Put these names in row 1 of your sheet: `company`, `website`, `signal`, `source_url`, `source_date`, `angle`, `location`, `intent_signal`, `found_at`, `run_id`.
2. Open the node, select your Google Sheets credential, paste the sheet's address into **Document** and set the tab name in **Sheet**.
3. Activate the node (select it, press `D`).

Only companies that are new in the run reach the node. The data table stays the memory that dedupe reads, so keep it even when you work in the sheet. **This node was not tested here**: it needs a Google account. If it fails, the run stops with the error on that node. The companies of that run are then already in the data table and will not be sent to the sheet again, so copy them over by hand.

### Webhook

`workflows/2-run-by-webhook.json` is optional. Create a **Header Auth** credential named `Account Scanner Key` (header `X-Scanner-Key`), import the workflow, and select *Account Scanner* in its **Account Scanner** node if n8n gave the imported workflow a new id.

```
curl -X POST https://<your n8n>/webhook/scanner/run -H 'X-Scanner-Key: …' -H 'Content-Type: application/json' \
  -d '{"location": "Austin, Texas", "intent_signal": "announced a new funding round", "lookback_hours": 96, "runs": 50, "target": 40}'
```

It answers with the summary when the run is done. `POST /webhook/scanner/rows` returns both tables.

### Try it locally

```
git clone https://github.com/feversoul/n8n-account-scanner
cd n8n-account-scanner
cp .env.example .env    # fill it in
docker compose up -d    # n8n on http://localhost:5678 with both workflows imported
```

## What was tested

`npm run test:e2e` starts n8n 2.47.7 and `test/stand-in.mjs`, a stand-in that answers in the documented Responses shape and rejects a request that is not in that shape. It has 30 companies and misbehaves on purpose. All runs go through the real workflows over HTTP. Last result: **8 tests, 8 passed**.

| Test | Result |
| --- | --- |
| 24 angles, target out of reach | 12 companies saved, all different. 9 rejected, one per reason: stale source, no source, source not in the search, no web search, cut-off JSON twice, nothing found, 429 three times, no date, date in the future. 3 duplicates dropped (same pick in one batch, other spelling of name and website, no website). 6 retries. 30 model calls. |
| Request shape | Every call had the `web_search` tool, `tool_choice: required`, the `sources` include and the strict JSON schema. |
| Angles | 24 angles, none twice, each differs from the one before in area, industry, source and wording. |
| Exclusion list | For every call, the list in the prompt was exactly the companies found by the batches before it plus those of earlier runs. The first batch of a first run lists none. |
| Repairs | Fenced JSON with chatter and a comma too many were read without a second call. |
| Rate limit | The retry came at least 0.9 s after a 429 with `Retry-After: 1`. Calls at the same time: 4, then 2 after the first 429, then 1 after the second. |
| Second run, target 6 of 40 angles | Stopped after 11 angles and 13 calls with 6 new companies. Its first prompt listed the 12 from run 1. A company from run 1 that came back was dropped. 18 rows, no domain and no name twice. |
| Lookback | 1 hour: 3 answers, all rejected as stale, nothing added. 480 hours: the 10-day-old source that 96 hours rejected was accepted. |
| Form | A form submission with empty number fields ran with the Settings values and its own sub-areas. |
| Wrong API key | Stopped after one batch (5 calls, not 30) with the API's message in the summary. |
| Empty request (what "Execute workflow" sends), 50 angles | 50 different angles. The stand-in ran out of new companies: 8 found, 33 duplicates dropped, and all 30 of its companies ended up in the table once. |
| Summary | In every run the counts matched the log, each other, and the calls and tokens the stand-in counted. |

## Not tested, and other limits

- **A real model and real web search.** Not called. How many good companies 50 angles find, what it costs and how often a model invents something is unknown. The token and web search counts in the summary are for finding that out on a small run.
- **The request against the real API.** The shape was taken from the two OpenAI doc pages linked above and the stand-in checks it, but it was never sent to OpenAI. In particular, `web_search` together with a JSON schema and `tool_choice: "required"` in one request is not shown as one example on those pages. If the API rejects `text.format`, set `STRUCTURED_OUTPUT = false`; the prompt still asks for the same JSON.
- **`source_not_in_search` against real citations.** The check compares addresses without `www`, query, fragment and trailing slash. If a real API writes its citations differently, good answers would be rejected with this reason: set `CITED_SOURCE_CHECK` to `'domain'` or `'off'`.
- **Other providers.** The endpoint must implement the Responses API with the `web_search` tool. A chat-completions-only server will not work.
- **The source check is not a fact check.** It shows that the page was returned by the search and how old the model says it is. It does not read the page. The date comes from the model.
- **Google Sheets** and the **Execute workflow button** itself (the tests send the same empty input through the webhook).
- **Dedupe** treats `acme.com` and `acme.io` as two companies, and two different companies with the same name and no website as one.
- **Angles** are built from fixed lists, not by a model, so they do not know your region or your signal. Edit the lists.
- n8n Cloud, queue mode and two runs at once were not tested.

## Development

```
node scripts/build.mjs   # src/*.js → workflows/*.json
npm run test:e2e         # needs Docker; KEEP_STACK=1 leaves n8n on http://localhost:55700
```

MIT
