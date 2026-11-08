'use strict';

// Local-only model tests: Node built-ins, no network, files written, or installs.
const assert = require('node:assert/strict');
const { test } = require('node:test');
require('./model.js');
const BoardModel = globalThis.BoardModel;
const fields = { title: '准备研究计划', description: '把问题缩小到一个可验证的假设。', category: '工作' };

test('residence is accumulated across quadrants, while prep stops the clock', () => {
  const board = new BoardModel(undefined, 0);
  const card = board.create(fields, 0);
  assert.equal(board.stats(card.id, 500).total, 0);
  board.move(card.id, 'q1', 1000);
  board.move(card.id, 'q2', 4000);
  board.move(card.id, 'prep', 5000);
  assert.deepEqual(board.stats(card.id, 9000), {
    durations: { q1: 3000, q2: 1000, q3: 0, q4: 0 }, total: 4000,
    percentages: { q1: 75, q2: 25, q3: 0, q4: 0 }
  });
  assert.equal(board.get(card.id).startedAt, null);
});

test('beginEdit settles and pauses; edits preserve appearance and accumulated history', () => {
  const board = new BoardModel(undefined, 0);
  const card = board.create(fields, 0);
  board.move(card.id, 'q3', 10);
  board.beginEdit(card.id, 110);
  board.update(card.id, { title: '调整后的研究计划', category: '个人提升' }, 200);
  const revised = board.get(card.id);
  assert.equal(revised.zone, 'prep');
  assert.equal(revised.title, '调整后的研究计划');
  assert.equal(revised.description, fields.description);
  assert.deepEqual(revised.appearance, card.appearance);
  assert.equal(board.stats(card.id, 10000).total, 100);
});

test('finish freezes history and rejects moving or completing an ended card again', () => {
  const board = new BoardModel(undefined, 0);
  const card = board.create(fields, 0);
  board.move(card.id, 'q4', 100);
  board.finish(card.id, 'completed', '', 600);
  assert.equal(board.stats(card.id, 100000).total, 500);
  assert.equal(board.get(card.id).endedAt, 600);
  assert.equal(board.get(card.id).zone, null);
  assert.throws(() => board.move(card.id, 'q2', 700));
  assert.throws(() => board.finish(card.id, 'cancelled', '', 700));
  assert.equal(board.stats(card.id, 100000).total, 500);
});

test('restore retains prior duration, resets end state, and resumes only after placement', () => {
  const board = new BoardModel(undefined, 0);
  const card = board.create(fields, 0);
  board.move(card.id, 'q1', 10);
  board.finish(card.id, 'cancelled', '计划变化', 110);
  board.restore(card.id, 1000);
  assert.equal(board.get(card.id).reason, '');
  assert.equal(board.get(card.id).endedAt, null);
  assert.equal(board.get(card.id).zone, 'prep');
  assert.equal(board.stats(card.id, 2000).total, 100);
  board.move(card.id, 'q2', 2000);
  assert.deepEqual(board.stats(card.id, 2100).percentages, { q1: 50, q2: 50, q3: 0, q4: 0 });
  assert.deepEqual(board.get(card.id).appearance, card.appearance);
  assert.throws(() => board.restore(card.id, 2200));
  assert.ok(board.exportData().events.some(event => event.type === 'cancelled' && event.reason === '计划变化'));
});

test('stats are read-only, same-zone placement does not reset time, and zero has no NaN', () => {
  const board = new BoardModel(undefined, 0);
  const card = board.create(fields, 0);
  assert.deepEqual(board.stats(card.id, 0).percentages, { q1: 0, q2: 0, q3: 0, q4: 0 });
  board.move(card.id, 'q1', 100);
  board.move(card.id, 'q1', 200);
  const stored = board.exportData();
  assert.equal(board.stats(card.id, 400).total, 300);
  assert.equal(board.stats(card.id, 400).total, 300);
  assert.deepEqual(board.exportData(), stored);
  assert.equal(board.stats(card.id, 50).total, 0);
});

test('closing and reloading preserves elapsed residence rather than pausing it', () => {
  const board = new BoardModel(undefined, 0);
  const card = board.create(fields, 0);
  board.move(card.id, 'q2', 1000);
  const saved = JSON.parse(JSON.stringify(board.exportData()));
  const reloaded = new BoardModel(saved, 10000);
  assert.equal(reloaded.stats(card.id, 11000).total, 10000);
  assert.deepEqual(reloaded.get(card.id).appearance, card.appearance);
  reloaded.finish(card.id, 'completed', '', 11000);
  const ended = new BoardModel(reloaded.exportData(), 50000);
  assert.equal(ended.stats(card.id, 60000).total, 10000);
});

test('Unicode limits count codepoints; rejected writes leave the data unchanged', () => {
  const board = new BoardModel(undefined, 0);
  const card = board.create({ title: '😀'.repeat(28), description: '文'.repeat(120), category: '类'.repeat(12) }, 0);
  const saved = board.exportData();
  for (const invalid of [
    { ...fields, title: ' ' }, { ...fields, title: '😀'.repeat(29) },
    { ...fields, description: '文'.repeat(121) }, { ...fields, category: '' },
    { ...fields, category: '类'.repeat(13) }
  ]) assert.throws(() => board.create(invalid, 10));
  assert.throws(() => board.update(card.id, { title: '' }, 10));
  assert.throws(() => board.move(card.id, 'elsewhere', 10));
  assert.throws(() => board.move(card.id, 'q1', NaN));
  assert.deepEqual(board.exportData(), saved);
  assert.equal(board.create({ ...fields, description: '' }, 10).description, '');
  assert.equal(board.addCategory('  自定义  '), '自定义');
  board.addCategory('自定义');
  assert.equal(board.exportData().categories.filter(value => value === '自定义').length, 1);
});

test('bad saved data is filtered or normalized without poisoning the model', () => {
  const board = new BoardModel(undefined, 1000);
  const card = board.create(fields, 1000);
  const malformed = board.exportData();
  malformed.cards.push(null, { id: 'bad', title: '' }, { ...card });
  malformed.cards[0].durations = { q1: -2, q2: 'bad', q3: Infinity, q4: 25 };
  malformed.cards[0].zone = 'broken';
  malformed.cards[0].startedAt = 'bad';
  malformed.categories.push(null, '', '类'.repeat(13));
  malformed.settings = { motion: 'unknown', colors: { q1: 'url(bad)', q2: '#abcdef' } };
  malformed.events = [null, { type: 'bad', at: 'yesterday' }, { type: 'created', at: 1000, cardId: card.id }];
  const recovered = new BoardModel(malformed, 2000);
  const exported = recovered.exportData();
  assert.equal(exported.cards.length, 1);
  assert.equal(recovered.get(card.id).zone, 'prep');
  assert.deepEqual(recovered.stats(card.id, 3000).durations, { q1: 0, q2: 0, q3: 0, q4: 25 });
  assert.equal(exported.settings.motion, 'full');
  assert.equal(exported.settings.colors.q1, '#f2c7ba');
  assert.equal(exported.settings.colors.q2, '#abcdef');
  assert.equal(exported.events.length, 1);
  assert.equal(new BoardModel({ version: 999, cards: [card] }, 0).exportData().cards.length, 0);
  assert.equal(new BoardModel(null, 0).exportData().cards.length, 0);
});

test('exported and returned values cannot accidentally mutate internal state', () => {
  const board = new BoardModel(undefined, 0);
  const card = board.create(fields, 0);
  const exported = board.exportData();
  exported.cards[0].title = '外部变化';
  card.appearance.color = '#000000';
  const fetched = board.get(card.id);
  fetched.durations.q1 = 100000;
  assert.equal(board.get(card.id).title, fields.title);
  assert.notEqual(board.get(card.id).appearance.color, '#000000');
  assert.equal(board.stats(card.id, 1000).total, 0);
  assert.equal(board.get('missing'), null);
});

test('motion preferences survive reload, with system preferences respected by default', () => {
  const defaults = new BoardModel(undefined, 0).exportData();
  assert.equal(defaults.settings.motion, 'full');
  assert.equal(defaults.settings.respectSystem, true);
  for (const motion of ['full', 'reduced', 'off']) {
    for (const respectSystem of [true, false]) {
      const board = new BoardModel({ ...defaults, settings: { ...defaults.settings, motion, respectSystem } }, 0);
      const reloaded = new BoardModel(JSON.parse(JSON.stringify(board.exportData())), 1000);
      assert.equal(reloaded.data.settings.motion, motion);
      assert.equal(reloaded.data.settings.respectSystem, respectSystem);
    }
  }
  const oldData = { ...defaults, settings: { motion: 'off' } };
  assert.equal(new BoardModel(oldData, 0).data.settings.respectSystem, true);
  const invalid = new BoardModel({ ...defaults, settings: { motion: 'invalid', respectSystem: 'false' } }, 0);
  assert.equal(invalid.data.settings.motion, 'full');
  assert.equal(invalid.data.settings.respectSystem, true);
});

test('each finish preserves its own immutable historical snapshot across restores and reloads', () => {
  const board = new BoardModel(undefined, 0);
  const card = board.create(fields, 0);
  board.move(card.id, 'q1', 10);
  board.finish(card.id, 'cancelled', '当时先暂停', 110);
  const firstSnapshot = board.exportData().events.find(event => event.type === 'cancelled').snapshot;
  assert.equal(firstSnapshot.title, fields.title);
  assert.equal(firstSnapshot.reason, '当时先暂停');
  assert.equal(firstSnapshot.durations.q1, 100);
  assert.equal(firstSnapshot.endedAt, 110);
  board.restore(card.id, 1000);
  board.update(card.id, { title: '恢复后的新目标' }, 1000);
  board.move(card.id, 'q2', 2000);
  board.finish(card.id, 'completed', '', 2400);
  const finished = board.exportData();
  assert.deepEqual(finished.events.find(event => event.type === 'cancelled').snapshot, firstSnapshot);
  const secondSnapshot = finished.events.find(event => event.type === 'completed').snapshot;
  assert.equal(secondSnapshot.title, '恢复后的新目标');
  assert.deepEqual(secondSnapshot.durations, { q1: 100, q2: 400, q3: 0, q4: 0 });
  const reloaded = new BoardModel(JSON.parse(JSON.stringify(finished)), 5000).exportData();
  assert.deepEqual(reloaded.events.find(event => event.type === 'cancelled').snapshot, firstSnapshot);
  assert.deepEqual(reloaded.events.find(event => event.type === 'completed').snapshot, secondSnapshot);
  finished.events.find(event => event.type === 'cancelled').snapshot.title = '外部误改';
  assert.equal(board.exportData().events.find(event => event.type === 'cancelled').snapshot.title, fields.title);
});

test('malformed active snapshots cannot be restored as completed historical facts', () => {
  const board = new BoardModel(undefined, 0);
  const card = board.create(fields, 0);
  const data = board.exportData();
  data.events = [{ type: 'completed', at: 100, cardId: card.id, snapshot: card }];
  const recovered = new BoardModel(data, 200).exportData();
  assert.equal(recovered.events.length, 1);
  assert.equal(recovered.events[0].snapshot, undefined);
});

test('legacy version 1 cards and archived snapshots gain empty positions without changing history', () => {
  const board = new BoardModel(undefined, 0);
  const active = board.create(fields, 0);
  const ended = board.create({ ...fields, title: '已归档事项' }, 0);
  board.move(active.id, 'q1', 100);
  board.move(ended.id, 'q2', 100);
  board.finish(ended.id, 'completed', '', 300);
  const legacy = board.exportData();
  for (const card of legacy.cards) delete card.positions;
  for (const event of legacy.events) if (event.snapshot) delete event.snapshot.positions;

  const reloaded = new BoardModel(legacy, 1000);
  const migrated = reloaded.exportData();
  assert.equal(migrated.version, 1);
  for (const card of migrated.cards) assert.deepEqual(card.positions, {});
  assert.deepEqual(migrated.events.find(event => event.type === 'completed').snapshot.positions, {});
  assert.equal(reloaded.stats(active.id, 1100).total, 1000);
  assert.equal(reloaded.stats(ended.id, 1100).total, 200);
  for (const card of migrated.cards) delete card.positions;
  for (const event of migrated.events) if (event.snapshot) delete event.snapshot.positions;
  assert.deepEqual(migrated, legacy);
});

test('saved positions retain valid pairs and discard malformed pairs rather than clamping them', () => {
  const board = new BoardModel(undefined, 0);
  const card = board.create(fields, 0);
  assert.deepEqual(card.positions, {});
  const saved = board.exportData();
  saved.cards[0].positions = {
    q1: { x: 0, y: 1, extra: 'ignored' },
    q2: { x: -0.1, y: 0.4 },
    q3: { x: 0.5 },
    q4: { x: '0.4', y: 0.4 },
    prep: { x: 0.5, y: 0.5 }
  };
  const recovered = new BoardModel(saved, 100);
  assert.deepEqual(recovered.get(card.id).positions, { q1: { x: 0, y: 1 } });
  const persisted = JSON.parse(JSON.stringify(recovered.exportData()));
  assert.deepEqual(new BoardModel(persisted, 200).get(card.id).positions, { q1: { x: 0, y: 1 } });
  for (const malformed of [null, [], 'bad', { q1: { x: Infinity, y: 0 } }]) {
    saved.cards[0].positions = malformed;
    assert.deepEqual(new BoardModel(saved, 100).get(card.id).positions, {});
  }
});

test('same-quadrant placement updates coordinates without settling or restarting residence', () => {
  const board = new BoardModel(undefined, 0);
  const card = board.create(fields, 0);
  board.place(card.id, 'q1', { x: 0.2, y: 0.3 }, 100);
  board.place(card.id, 'q1', { x: 0.8, y: 0.6 }, 250);
  const positioned = board.get(card.id);
  assert.equal(positioned.startedAt, 100);
  assert.equal(positioned.updatedAt, 250);
  assert.equal(positioned.durations.q1, 0);
  assert.deepEqual(positioned.positions.q1, { x: 0.8, y: 0.6 });
  assert.equal(board.stats(card.id, 500).total, 400);
  assert.equal(board.exportData().events.filter(event => event.type === 'positioned').length, 1);
  const unchanged = board.exportData();
  board.place(card.id, 'q1', { x: 0.8, y: 0.6 }, 600);
  assert.deepEqual(board.exportData(), unchanged);
  assert.equal(board.stats(card.id, 700).total, 600);
});

test('cross-quadrant placement settles once and ordinary moves preserve each remembered position', () => {
  const board = new BoardModel(undefined, 0);
  const card = board.create(fields, 0);
  const position = { x: 0, y: 1 };
  const returned = board.place(card.id, 'q1', position, 100);
  position.x = 1;
  returned.positions.q1.y = 0;
  board.place(card.id, 'q2', { x: 1, y: 0 }, 300);
  assert.deepEqual(board.get(card.id).positions, { q1: { x: 0, y: 1 }, q2: { x: 1, y: 0 } });
  assert.equal(board.get(card.id).startedAt, 300);
  assert.deepEqual(board.stats(card.id, 500).durations, { q1: 200, q2: 200, q3: 0, q4: 0 });
  board.move(card.id, 'prep', 600);
  board.move(card.id, 'q1', 700);
  assert.deepEqual(board.stats(card.id, 800).durations, { q1: 300, q2: 300, q3: 0, q4: 0 });
  assert.deepEqual(board.get(card.id).positions, { q1: { x: 0, y: 1 }, q2: { x: 1, y: 0 } });
});

test('invalid placements and placements of ended cards leave the complete state unchanged', () => {
  const board = new BoardModel(undefined, 0);
  const card = board.create(fields, 0);
  board.place(card.id, 'q1', { x: 0.4, y: 0.5 }, 100);
  const saved = board.exportData();
  for (const invalid of [
    undefined, null, [], {}, { x: 0.5 }, { x: '0.5', y: 0 },
    { x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: 0, y: -Infinity },
    { x: -0.01, y: 0.5 }, { x: 0.5, y: 1.01 }
  ]) {
    assert.throws(() => board.place(card.id, 'q2', invalid, 500));
    assert.deepEqual(board.exportData(), saved);
  }
  for (const invalidZone of ['prep', 'elsewhere', null]) {
    assert.throws(() => board.place(card.id, invalidZone, { x: 0, y: 0 }, 500));
  }
  assert.throws(() => board.place(card.id, 'q2', { x: 0, y: 0 }, NaN));
  assert.throws(() => board.place('missing', 'q2', { x: 0, y: 0 }, 500));
  assert.deepEqual(board.exportData(), saved);
  for (const [index, status] of ['completed', 'cancelled'].entries()) {
    const now = 600 + index * 300;
    board.finish(card.id, status, '', now);
    const finished = board.exportData();
    assert.throws(() => board.place(card.id, 'q2', { x: 0, y: 0 }, now + 100));
    assert.deepEqual(board.exportData(), finished);
    board.restore(card.id, now + 200);
  }
});

test('positions survive editing, archiving, restoration and reload while old snapshots remain unchanged', () => {
  for (const status of ['completed', 'cancelled']) {
    const board = new BoardModel(undefined, 0);
    const card = board.create(fields, 0);
    board.place(card.id, 'q3', { x: 0.25, y: 0.75 }, 100);
    board.beginEdit(card.id, 200);
    board.update(card.id, { title: '修改后仍保留位置' }, 300);
    assert.deepEqual(board.get(card.id).positions, { q3: { x: 0.25, y: 0.75 } });
    board.move(card.id, 'q3', 400);
    board.finish(card.id, status, '', 500);
    const snapshot = board.exportData().events.find(event => event.type === status).snapshot;
    assert.deepEqual(snapshot.positions, { q3: { x: 0.25, y: 0.75 } });
    board.restore(card.id, 600);
    assert.deepEqual(board.get(card.id).positions, snapshot.positions);
    assert.equal(board.get(card.id).zone, 'prep');
    board.place(card.id, 'q3', { x: 0.8, y: 0.2 }, 700);
    const reloaded = new BoardModel(JSON.parse(JSON.stringify(board.exportData())), 800);
    assert.deepEqual(reloaded.get(card.id).positions, { q3: { x: 0.8, y: 0.2 } });
    assert.deepEqual(reloaded.exportData().events.find(event => event.type === status).snapshot, snapshot);
    assert.equal(reloaded.stats(card.id, 800).total, 300);
  }
});
