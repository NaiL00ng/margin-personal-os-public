// Synthetic transport tests: no network, no browser profile, no filesystem writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, 'storage.js'), 'utf8');

function fixture(fetch) {
  const saved = new Map();
  const context = vm.createContext({ fetch, AbortController, setTimeout, clearTimeout, Date,
    crypto: { randomUUID: () => 'stable-operation' },
    localStorage: { get length() { return saved.size; }, key: index => [...saved.keys()][index], getItem: key => saved.get(key) || null, setItem: (key, value) => saved.set(key, value), removeItem: key => saved.delete(key) } });
  vm.runInContext(source, context);
  return { Client: context.MarginStorage, saved };
}
const state = (revision = 0, extra = {}) => ({ state: { version: 1, cards: [], events: [] }, revision, serverTime: Date.now(), databaseId: 'db-one', csrfToken: 'token-one', ...extra });
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });

test('lost response retries the exact operation and records one confirmation', async () => {
  const requests = [];
  const f = fixture(async (path, options) => {
    if (path === '/api/state') return response(state());
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) throw new TypeError('lost response');
    return response(state(1, { result: { id: 'card-one' }, replayed: true }));
  });
  const client = new f.Client(); await client.connect();
  const result = await client.command('create', { fields: { title: '合成记录' } });
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].databaseId, 'db-one');
  assert.equal(result.result.id, 'card-one');
  assert.equal(client.pending, null);
  assert.equal(f.saved.size, 0);
});

test('unconfirmed request survives reload and blocks new commands', async () => {
  let connected = false;
  const requests = [];
  const f = fixture(async (path, options) => {
    if (path === '/api/state') return response(state());
    requests.push(JSON.parse(options.body));
    if (!connected) throw new TypeError('offline');
    return response(state(1));
  });
  const first = new f.Client(); await first.connect();
  await assert.rejects(first.command('finish', { id: 'one', status: 'completed' }));
  await assert.rejects(first.command('create', {}), /上一操作/);
  connected = true;
  const next = new f.Client(); await next.connect();
  assert.deepEqual(requests[0], requests[2]);
  assert.equal(next.pending, null);
});

test('stale revision conflict preserves latest snapshot and clears rejected command', async () => {
  let reads = 0;
  const f = fixture(async path => path === '/api/state'
    ? response(state(reads++ ? 2 : 0)) : response({ message: '另一窗口已更新' }, 409));
  const client = new f.Client(); await client.connect();
  await assert.rejects(client.command('move', { id: 'one', zone: 'q2' }), /另一窗口/);
  assert.equal(client.snapshot.revision, 2);
  assert.equal(client.pending, null);
  assert.equal(f.saved.size, 0);
});

test('service restart refreshes CSRF but retains original operation identity and revision', async () => {
  let reads = 0; const requests = [];
  const f = fixture(async (path, options) => {
    if (path === '/api/state') return response(state(reads++, { csrfToken: reads > 1 ? 'new-token' : 'old-token' }));
    requests.push({ request: JSON.parse(options.body), token: options.headers['X-Margin-Token'] });
    return requests.length === 1 ? response({ message: '令牌已更换' }, 403) : response(state(1, { replayed: true }));
  });
  const client = new f.Client(); await client.connect(); await client.command('finish', {});
  assert.deepEqual(requests[0].request, requests[1].request);
  assert.equal(requests[1].token, 'new-token');
});

test('pending journals are isolated by database identity', async () => {
  let database = 'one'; let posts = 0;
  const f = fixture(async path => {
    if (path === '/api/state') return response(state(0, { databaseId: database }));
    posts++; throw new TypeError('offline');
  });
  const first = new f.Client(); await first.connect(); await assert.rejects(first.command('create', {}));
  database = 'two';
  const next = new f.Client(); await next.connect();
  assert.equal(next.pending, null);
  assert.equal(posts, 2);
});

test('confirming one request never removes another tab pending request', async () => {
  const f = fixture(async () => response(state()));
  const first = new f.Client(); const second = new f.Client();
  first.accept(state()); second.accept(state());
  first.pending = { databaseId: 'db-one', operationId: 'op-a', expectedRevision: 0, action: 'create', payload: {} };
  second.pending = { databaseId: 'db-one', operationId: 'op-b', expectedRevision: 1, action: 'create', payload: {} };
  first.remember(); second.remember();
  first.forget(first.pending);
  assert.equal(f.saved.size, 1);
  assert.equal(second.readJournal().operationId, 'op-b');
});

test('late state response cannot roll a confirmed revision backward', () => {
  const f = fixture(async () => response(state()));
  const client = new f.Client();
  client.accept(state(4)); client.accept(state(2, { csrfToken: 'refreshed' }));
  assert.equal(client.snapshot.revision, 4);
  assert.equal(client.csrf, 'refreshed');
});

test('reconnect and new mutations cannot race an in-flight command', async () => {
  let finish;
  const f = fixture(async path => path === '/api/state' ? response(state()) : new Promise(resolve => { finish = resolve; }));
  const client = new f.Client(); await client.connect();
  const saving = client.command('create', {});
  await assert.rejects(client.connect(), /正在核对/);
  await assert.rejects(client.command('create', {}), /上一操作/);
  finish(response(state(1))); await saving;
  assert.equal(client.snapshot.revision, 1);
});

test('CSRF refresh into a different database preserves the original pending journal', async () => {
  let reads = 0; let posts = 0;
  const f = fixture(async path => {
    if (path === '/api/state') return response(state(0, { databaseId: reads++ ? 'db-two' : 'db-one' }));
    posts++; return response({ message: 'server restarted' }, 403);
  });
  const client = new f.Client(); await client.connect();
  await assert.rejects(client.command('create', {}), /数据库已切换/);
  assert.equal(posts, 1);
  assert.equal(f.saved.size, 1);
  assert.equal(JSON.parse([...f.saved.values()][0]).databaseId, 'db-one');
  assert.equal(client.pending, null);
});
