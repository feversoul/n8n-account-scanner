// Builds workflows/*.json.
//
// The workflows are plain n8n exports: import them and they run, no build
// needed. This script exists so the JavaScript of the Code nodes can live in
// readable files (src/*.js). After changing one, run:
//   node scripts/build.mjs

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = (name) => readFileSync(join(root, 'src', `${name}.js`), 'utf8').trimEnd();
// "/* __KEYS__ */" in a source file becomes the shared dedupe functions.
const source = (name) => file(name).replace('/* __KEYS__ */', () => file('_keys'));

const COMPANIES = 'scanner_companies';
const RUNS = 'scanner_runs';
const table = (name) => ({ __rl: true, mode: 'name', value: name });

const IDS = { scanner: 'acctScannerMain01', hook: 'acctScannerHook01' };

// Credentials are matched by name on import: create them with exactly these
// names before importing and every node picks them up.
const KEY = { httpHeaderAuth: { id: 'acctScannerKey', name: 'Account Scanner Key' } };
const MODEL = { openAiApi: { id: 'acctScannerModel', name: 'Account Scanner Model' } };

const COMPANY_COLUMNS = [
  ['company', 'string'],
  ['website', 'string'],
  ['domain_key', 'string'], // the website without www, path and case: what dedupe compares
  ['name_key', 'string'], // the name without case, accents, punctuation and "Inc", "Ltd", ...
  ['signal', 'string'],
  ['source_url', 'string'], // open this before you contact anyone
  ['source_date', 'string'],
  ['angle', 'string'], // the search angle that found it
  ['location', 'string'],
  ['intent_signal', 'string'],
  ['run_id', 'string'],
  ['found_at', 'date'],
];
const RUN_COLUMNS = [
  ['run_id', 'string'],
  ['ran_at', 'date'],
  ['location', 'string'],
  ['intent_signal', 'string'],
  ['lookback_hours', 'number'],
  ['stopped', 'string'],
  ['angles_planned', 'number'],
  ['angles_tried', 'number'],
  ['found', 'number'],
  ['rejected', 'number'],
  ['duplicates', 'number'],
  ['retries', 'number'],
  ['model_calls', 'number'],
  ['web_searches', 'number'],
  ['input_tokens', 'number'],
  ['output_tokens', 'number'],
  ['total_tokens', 'number'],
  ['report', 'string'],
];

const uuid = (seed) => {
  const hex = createHash('sha1').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const schema = (columns) =>
  columns.map(([column, type]) => ({ id: column, displayName: column, required: false, defaultMatch: false, display: true, type: type === 'date' ? 'dateTime' : type, canBeUsedToMatch: true }));

function workflow(id, name, build) {
  const nodes = [];
  const connections = {};
  const w = {
    node(nodeName, type, typeVersion, position, parameters, extra = {}) {
      nodes.push({ parameters, id: uuid(`${id}/${nodeName}`), name: nodeName, type: `n8n-nodes-base.${type}`, typeVersion, position, ...extra });
      return nodeName;
    },
    note(nodeName, lines, position, width, height, color = 4) {
      return w.node(nodeName, 'stickyNote', 1, position, { content: lines.join('\n'), width, height, color });
    },
    link(from, to, output = 0) {
      connections[from] ??= { main: [] };
      while (connections[from].main.length <= output) connections[from].main.push([]);
      connections[from].main[output].push({ node: to, type: 'main', index: 0 });
    },
    chain(...names) {
      for (let i = 0; i < names.length - 1; i++) w.link(names[i], names[i + 1]);
    },
    hook(nodeName, path, position) {
      return w.node(
        nodeName,
        'webhook',
        2,
        position,
        { httpMethod: 'POST', path: `scanner/${path}`, authentication: 'headerAuth', responseMode: 'responseNode', options: {} },
        { webhookId: uuid(`${id}/webhook/${path}`), credentials: KEY },
      );
    },
    code(nodeName, position, sourceFile) {
      return w.node(nodeName, 'code', 2, position, { jsCode: source(sourceFile) });
    },
    // Creates the data table on the first run and does nothing after that.
    create(nodeName, position, tableName, columns) {
      return w.node(nodeName, 'dataTable', 1.1, position, {
        resource: 'table',
        operation: 'create',
        tableName,
        columns: { column: columns.map(([column, type]) => ({ name: column, type })) },
        options: { createIfNotExists: true },
      });
    },
    rows(nodeName, position, tableName, extra = {}) {
      return w.node(
        nodeName,
        'dataTable',
        1.1,
        position,
        { resource: 'row', operation: 'get', dataTableId: table(tableName), matchType: 'allConditions', filters: {}, returnAll: true },
        { alwaysOutputData: true, ...extra },
      );
    },
    insert(nodeName, position, tableName, columns, values = Object.fromEntries(columns.map(([column]) => [column, `={{ $json.${column} }}`]))) {
      return w.node(nodeName, 'dataTable', 1.1, position, {
        resource: 'row',
        operation: 'insert',
        dataTableId: table(tableName),
        columns: { mappingMode: 'defineBelow', value: values, matchingColumns: [], schema: schema(columns), attemptToConvertTypes: false, convertFieldsToString: false },
        options: {},
      });
    },
    when(nodeName, position, expression) {
      return w.node(nodeName, 'if', 2.2, position, {
        conditions: {
          options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
          conditions: [{ id: uuid(`${id}/${nodeName}/condition`), leftValue: `={{ ${expression} }}`, rightValue: '', operator: { type: 'boolean', operation: 'true', singleValue: true } }],
          combinator: 'and',
        },
        options: { looseTypeValidation: true },
      });
    },
  };
  build(w);
  return { name, nodes, pinData: {}, connections, active: false, settings: { executionOrder: 'v1' }, id };
}

// --- 1. Account Scanner ---------------------------------------------------------

const scanner = workflow(IDS.scanner, 'Account Scanner', (w) => {
  w.note(
    'About',
    [
      '## Account Scanner',
      'One click instead of 50 chats. It plans N different **search angles** for your location and intent signal, asks a model with **web search** once per angle, and keeps only companies that are new and come with a fresh source.',
      '',
      '1. **Settings**: what to look for, the model, the pace. Start here.',
      '2. **Plan angles**: N angles that differ in area, industry, kind of source and wording. It also reads what earlier runs found.',
      '3. **The loop** (Next batch → Search the web → Read answers): a few angles at a time. Every batch is told which companies are already on the list, so it looks somewhere new. The loop ends when the target is reached or the angles are used up.',
      '4. **Read answers** rejects an answer without a source, with a source older than the lookback window, or with a source the web search did not return. A company that is already known (same website, or same name when there is no website) is dropped.',
      `5. New companies go to the data table \`${COMPANIES}\`, the run goes to \`${RUNS}\`. Both tables are created on the first run.`,
      '',
      'Press **Execute workflow** to run with the values in Settings, or publish the workflow and open the form.',
      '',
      '**Check before you use a row.** A model can still name a company or a source that is wrong. Every row has its `source_url`: open it.',
    ],
    [-80, -660],
    900,
    460,
  );
  w.node('Run by hand', 'manualTrigger', 1, [0, -180], {});
  w.node(
    'Or fill in the form',
    'formTrigger',
    2.2,
    [0, 0],
    {
      formTitle: 'Account Scanner',
      formDescription: 'Finds companies with a fresh intent signal. Empty fields use the values in the Settings node. The results go to the data table scanner_companies.',
      formFields: {
        values: [
          { fieldLabel: 'Location', placeholder: 'Austin, Texas', requiredField: true },
          { fieldLabel: 'Intent signal', placeholder: 'announced a new funding round', requiredField: true },
          { fieldLabel: 'Lookback hours', fieldType: 'number', placeholder: '96' },
          { fieldLabel: 'Runs', fieldType: 'number', placeholder: '50' },
          { fieldLabel: 'Target', fieldType: 'number', placeholder: '40' },
          { fieldLabel: 'Sub-areas', placeholder: 'optional, comma separated' },
        ],
      },
      responseMode: 'onReceived',
      options: { path: 'account-scanner' },
    },
    { webhookId: uuid(`${IDS.scanner}/form`) },
  );
  w.node('Called by another workflow', 'executeWorkflowTrigger', 1.1, [0, 180], { inputSource: 'passthrough' });
  w.code('Settings', [240, 0], 'settings');
  w.create('Companies table', [460, 0], COMPANIES, COMPANY_COLUMNS);
  w.create('Runs table', [680, 0], RUNS, RUN_COLUMNS);
  w.rows('Earlier companies', [900, 0], COMPANIES);
  w.code('Plan angles', [1120, 0], 'plan-angles');
  w.when('Anything to search?', [1340, 0], '$json.more');

  w.code('Next batch', [1600, -100], 'next-batch');
  w.when('Pause first?', [1820, -100], '$json.wait_seconds > 0');
  w.node('Wait', 'wait', 1.1, [2040, -240], { amount: '={{ $json.wait_seconds }}', unit: 'seconds' }, { webhookId: uuid(`${IDS.scanner}/wait`) });
  w.node(
    'Search the web',
    'httpRequest',
    4.2,
    [2260, -100],
    {
      method: 'POST',
      url: "={{ $('Settings').first().json.model_base_url }}/responses",
      authentication: 'predefinedCredentialType',
      nodeCredentialType: 'openAiApi',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.request) }}',
      // The items of one batch are sent at the same time; the next batch waits for all of them.
      options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 180000 },
    },
    { credentials: MODEL, onError: 'continueRegularOutput' },
  );
  w.code('Read answers', [2480, -100], 'read-answers');
  w.when('More to do?', [2700, -100], '$json.more');
  w.node('Finish', 'noOp', 1, [2960, 0], {});
  w.when('Any found?', [3180, 0], '$json.found.length > 0');
  w.code('Rows to write', [3400, -100], 'rows-to-write');
  w.insert('Save company', [3620, -100], COMPANIES, COMPANY_COLUMNS);
  w.code('Sheet row', [3840, -100], 'sheet-row');
  w.node(
    'Append to Google Sheet',
    'googleSheets',
    4.7,
    [4060, -100],
    {
      resource: 'sheet',
      operation: 'append',
      documentId: { __rl: true, mode: 'url', value: '' },
      sheetName: { __rl: true, mode: 'name', value: 'Sheet1' },
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
      options: {},
    },
    { disabled: true },
  );
  w.code('Run summary', [4300, 0], 'run-summary');
  w.insert('Log run', [4520, 0], RUNS, RUN_COLUMNS, {
    ...Object.fromEntries(RUN_COLUMNS.map(([column]) => [column, `={{ $json.${column} }}`])),
    report: '={{ JSON.stringify({ text: $json.text, error: $json.error, rejected_why: $json.rejected_why, duplicates_why: $json.duplicates_why, retries_why: $json.retries_why }) }}',
  });
  w.code('Result', [4740, 0], 'result');

  for (const trigger of ['Run by hand', 'Or fill in the form', 'Called by another workflow']) w.link(trigger, 'Settings');
  w.chain('Settings', 'Companies table', 'Runs table', 'Earlier companies', 'Plan angles', 'Anything to search?');
  w.link('Anything to search?', 'Next batch', 0);
  w.link('Anything to search?', 'Finish', 1);
  w.chain('Next batch', 'Pause first?');
  w.link('Pause first?', 'Wait', 0);
  w.link('Pause first?', 'Search the web', 1);
  w.chain('Wait', 'Search the web', 'Read answers', 'More to do?');
  w.link('More to do?', 'Next batch', 0);
  w.link('More to do?', 'Finish', 1);
  w.chain('Finish', 'Any found?');
  w.link('Any found?', 'Rows to write', 0);
  w.link('Any found?', 'Run summary', 1);
  w.chain('Rows to write', 'Save company', 'Sheet row', 'Append to Google Sheet', 'Run summary', 'Log run', 'Result');

  w.note(
    'Model note',
    [
      '### The model call',
      '`POST {MODEL_BASE_URL}/responses` in the shape of the OpenAI Responses API with the built-in web search tool: `tools: [{ "type": "web_search" }]`, `tool_choice: "required"`, `include: ["web_search_call.action.sources"]` and a JSON schema in `text.format`. Doc: https://developers.openai.com/api/docs/guides/tools-web-search',
      '',
      'Create a credential of type **OpenAI** named `Account Scanner Model` with your API key and pick it in **Search the web**.',
      '',
      'A "too many requests" answer (HTTP 429) is asked again after the time the API names in `Retry-After`, and the batches are half as big from then on. A wrong key or model name stops the run at once.',
      '',
      'Each call costs tokens **and** a web search fee. The run summary counts both. Try `RUNS = 3` first.',
    ],
    [1560, 120],
    700,
    330,
    5,
  );
  w.note(
    'Sheet note',
    [
      '### Google Sheets (switched off until you set it up)',
      'The data table is the list that dedupe reads. The sheet is a copy for you.',
      '',
      '1. In your sheet, put these names in row 1: `company`, `website`, `signal`, `source_url`, `source_date`, `angle`, `location`, `intent_signal`, `found_at`, `run_id`.',
      '2. Open **Append to Google Sheet**, pick your Google Sheets credential, paste the address of the sheet into **Document** and set the name of the tab in **Sheet**.',
      '3. Activate the node (it is deactivated: select it and press `D`).',
      '',
      'Only companies that are new in this run reach the node, so the sheet gets no duplicates as long as the data table is kept. This node was **not tested**: it needs a Google account.',
    ],
    [3560, 100],
    700,
    330,
    5,
  );
});

// --- 2. Run by webhook ------------------------------------------------------------

const hook = workflow(IDS.hook, 'Account Scanner · Run by webhook', (w) => {
  w.note(
    'About',
    [
      '## Account Scanner · Run by webhook',
      'Optional. Needs a credential of type **Header Auth** named `Account Scanner Key` (header `X-Scanner-Key`).',
      '',
      '- `POST /webhook/scanner/run` with `{ "location", "intent_signal", "lookback_hours", "runs", "target", "sub_areas", "concurrency" }` runs *Account Scanner* and answers with the run summary when it is done. What you leave out comes from its Settings node.',
      `- \`POST /webhook/scanner/rows\` answers with everything in \`${COMPANIES}\` and \`${RUNS}\`.`,
      '',
      'The tests of this repository use both.',
    ],
    [-40, -300],
    640,
    240,
  );
  w.hook('Run requested', 'run', [0, 0]);
  w.node('Account Scanner', 'executeWorkflow', 1.2, [240, 0], {
    workflowId: { __rl: true, mode: 'id', value: IDS.scanner },
    workflowInputs: { mappingMode: 'defineBelow', value: {}, matchingColumns: [], schema: [], attemptToConvertTypes: false, convertFieldsToString: true },
    mode: 'once',
    options: { waitForSubWorkflow: true },
  });
  const answer = (nodeName, position) => w.node(nodeName, 'respondToWebhook', 1.1, position, { respondWith: 'json', responseBody: '={{ $json }}', options: { responseCode: 200 } });
  answer('Answer', [480, 0]);
  w.chain('Run requested', 'Account Scanner', 'Answer');

  w.hook('Rows requested', 'rows', [0, 240]);
  w.create('Companies table', [240, 240], COMPANIES, COMPANY_COLUMNS);
  w.create('Runs table', [460, 240], RUNS, RUN_COLUMNS);
  w.rows('Companies', [680, 240], COMPANIES);
  w.rows('Runs', [900, 240], RUNS, { executeOnce: true });
  w.code('Rows out', [1120, 240], 'rows-out');
  answer('Answer rows', [1340, 240]);
  w.chain('Rows requested', 'Companies table', 'Runs table', 'Companies', 'Runs', 'Rows out', 'Answer rows');
});

// --- write -------------------------------------------------------------------

export const workflows = {
  '1-account-scanner.json': scanner,
  '2-run-by-webhook.json': hook,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = join(root, 'workflows');
  mkdirSync(out, { recursive: true });
  for (const [name, definition] of Object.entries(workflows)) {
    writeFileSync(join(out, name), `${JSON.stringify(definition, null, 2)}\n`);
    console.log(`workflows/${name}: ${definition.nodes.length} nodes`);
  }
}
