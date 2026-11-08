(function (global) {
  'use strict';

  const QUADRANTS = ['q1', 'q2', 'q3', 'q4'];
  const ZONES = ['prep', ...QUADRANTS];
  const STATUSES = ['active', 'completed', 'cancelled'];
  const CATEGORIES = ['个人提升', '工作', '生活', '关系'];
  const COLORS = { q1: '#f2c7ba', q2: '#d9dfbc', q3: '#d5dfec', q4: '#e5d8ed' };
  const CARD_COLORS = ['#fff4d8', '#f4e7dc', '#e9eddf', '#e4eaf1', '#eee4ef'];
  const STICKERS = ['✦', '✳', '✿', '☀', '◈', '♡'];
  let sequence = 0;

  const clone = value => JSON.parse(JSON.stringify(value));
  const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const blankDurations = () => ({ q1: 0, q2: 0, q3: 0, q4: 0 });
  const validTime = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const validColor = value => typeof value === 'string' && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value);
  const validPosition = value => isObject(value) && ['x', 'y'].every(axis =>
    typeof value[axis] === 'number' && Number.isFinite(value[axis]) && value[axis] >= 0 && value[axis] <= 1);

  function readPositions(raw) {
    const positions = {};
    if (!isObject(raw)) return positions;
    for (const zone of QUADRANTS) {
      // Drop the entire malformed pair, retaining valid positions in other zones.
      if (validPosition(raw[zone])) positions[zone] = { x: raw[zone].x, y: raw[zone].y };
    }
    return positions;
  }

  function timestamp(value) {
    if (!validTime(value)) throw new Error('时间必须是有效的非负时间戳。');
    return value;
  }

  function text(value, label, maxLength, optional = false) {
    if (optional && (value === undefined || value === null)) return '';
    if (typeof value !== 'string') throw new Error(label + '必须是文字。');
    const result = value.trim();
    if (!optional && !result) throw new Error(label + '不能为空。');
    if (Array.from(result).length > maxLength) throw new Error(label + '最多 ' + maxLength + ' 个字符。');
    return result;
  }

  function input(fields) {
    if (!isObject(fields)) throw new Error('请填写卡片信息。');
    return {
      title: text(fields.title, '标题', 28),
      description: text(fields.description, '描述', 120, true),
      category: text(fields.category, '分类', 12)
    };
  }

  function uniqueId(prefix, now) {
    sequence += 1;
    return prefix + '-' + Math.floor(now).toString(36) + '-' + sequence.toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function appearance(seed = Math.floor(Math.random() * 0x100000000)) {
    const normalized = (seed >>> 0);
    return {
      color: CARD_COLORS[normalized % CARD_COLORS.length],
      rotation: (((normalized >>> 4) % 61) - 30) / 10,
      sticker: STICKERS[(normalized >>> 10) % STICKERS.length],
      seed: normalized
    };
  }

  function readCard(raw, now) {
    if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id.trim()) return null;
    let fields;
    try { fields = input(raw); } catch (_) { return null; }
    if (!STATUSES.includes(raw.status)) return null;
    const active = raw.status === 'active';
    const zone = active && ZONES.includes(raw.zone) ? raw.zone : active ? 'prep' : null;
    const createdAt = validTime(raw.createdAt) ? raw.createdAt : now;
    const updatedAt = validTime(raw.updatedAt) ? raw.updatedAt : createdAt;
    const durations = blankDurations();
    for (const quadrant of QUADRANTS) {
      const value = isObject(raw.durations) ? raw.durations[quadrant] : undefined;
      durations[quadrant] = validTime(value) ? value : 0;
    }
    const source = isObject(raw.appearance) ? raw.appearance : {};
    const seed = validTime(source.seed) ? source.seed : Array.from(raw.id).reduce((sum, char) => (sum * 31 + char.codePointAt(0)) >>> 0, 0);
    const visual = appearance(seed);
    if (validColor(source.color)) visual.color = source.color;
    if (typeof source.rotation === 'number' && Number.isFinite(source.rotation)) visual.rotation = Math.max(-10, Math.min(10, source.rotation));
    if (typeof source.sticker === 'string' && Array.from(source.sticker).length <= 8) visual.sticker = source.sticker;
    return {
      id: raw.id,
      ...fields,
      appearance: visual,
      positions: readPositions(raw.positions),
      status: raw.status,
      zone,
      // Preserve the saved clock so closing the page does not pause residence.
      startedAt: active && QUADRANTS.includes(zone) ? (validTime(raw.startedAt) ? raw.startedAt : updatedAt) : null,
      durations,
      createdAt,
      updatedAt,
      endedAt: active ? null : validTime(raw.endedAt) ? raw.endedAt : updatedAt,
      reason: typeof raw.reason === 'string' ? Array.from(raw.reason).slice(0, 120).join('') : ''
    };
  }

  class BoardModel {
    constructor(data, now = Date.now()) {
      timestamp(now);
      const source = isObject(data) && data.version === 1 ? data : {};
      const categories = [...CATEGORIES];
      if (Array.isArray(source.categories)) {
        for (const value of source.categories) {
          try {
            const category = text(value, '分类', 12);
            if (!categories.includes(category)) categories.push(category);
          } catch (_) { /* Ignore malformed saved categories. */ }
        }
      }
      const cards = [];
      const ids = new Set();
      for (const raw of Array.isArray(source.cards) ? source.cards : []) {
        const card = readCard(raw, now);
        if (!card || ids.has(card.id)) continue;
        cards.push(card);
        ids.add(card.id);
        if (!categories.includes(card.category)) categories.push(card.category);
      }
      const settings = isObject(source.settings) ? source.settings : {};
      const colors = { ...COLORS };
      for (const quadrant of QUADRANTS) {
        if (isObject(settings.colors) && validColor(settings.colors[quadrant])) colors[quadrant] = settings.colors[quadrant];
      }
      const events = [];
      for (const raw of Array.isArray(source.events) ? source.events : []) {
        if (!isObject(raw) || typeof raw.type !== 'string' || !validTime(raw.at)) continue;
        const event = { type: raw.type, at: raw.at };
        for (const key of ['id', 'cardId', 'fromZone', 'toZone', 'reason', 'category']) {
          if (typeof raw[key] === 'string' || raw[key] === null) event[key] = raw[key];
        }
        const snapshot = readCard(raw.snapshot, raw.at);
        if (snapshot && snapshot.status !== 'active' && snapshot.status === raw.type && snapshot.id === event.cardId) {
          event.snapshot = snapshot;
        }
        events.push(event);
      }
      this.data = {
        version: 1, cards, categories,
        settings: {
          motion: ['full', 'reduced', 'off'].includes(settings.motion) ? settings.motion : 'full',
          respectSystem: settings.respectSystem !== false,
          colors
        },
        events
      };
    }

    _card(id) {
      const card = this.data.cards.find(item => item.id === id);
      if (!card) throw new Error('找不到这张卡片。');
      return card;
    }

    _active(id) {
      const card = this._card(id);
      if (card.status !== 'active') throw new Error('请先恢复这张卡片，再进行调整。');
      return card;
    }

    _settle(card, now) {
      if (card.status === 'active' && QUADRANTS.includes(card.zone) && validTime(card.startedAt)) {
        card.durations[card.zone] += Math.max(0, now - card.startedAt);
      }
      card.startedAt = null;
    }

    _event(type, card, now, extra = {}) {
      this.data.events.push({ id: uniqueId('event', now), type, cardId: card.id, at: now, ...extra });
    }

    create(fields, now = Date.now()) {
      timestamp(now);
      const values = input(fields);
      this.addCategory(values.category);
      const card = {
        id: uniqueId('card', now), ...values, appearance: appearance(), positions: {},
        status: 'active', zone: 'prep', startedAt: null, durations: blankDurations(),
        createdAt: now, updatedAt: now, endedAt: null, reason: ''
      };
      this.data.cards.push(card);
      this._event('created', card, now, { fromZone: null, toZone: 'prep' });
      return clone(card);
    }

    move(id, zone, now = Date.now()) {
      timestamp(now);
      if (!ZONES.includes(zone)) throw new Error('卡片只能移动到准备区或四个象限。');
      const card = this._active(id);
      if (card.zone === zone) return clone(card);
      const fromZone = card.zone;
      this._settle(card, now);
      card.zone = zone;
      card.startedAt = QUADRANTS.includes(zone) ? now : null;
      card.updatedAt = now;
      this._event('moved', card, now, { fromZone, toZone: zone });
      return clone(card);
    }

    place(id, zone, position, now = Date.now()) {
      timestamp(now);
      if (!QUADRANTS.includes(zone)) throw new Error('自由摆放只能选择四个象限。');
      if (!validPosition(position)) throw new Error('位置的 x、y 必须是 0 到 1 之间的有限数字。');
      const card = this._active(id);
      const fromZone = card.zone;
      const previous = card.positions[zone];
      if (fromZone === zone && previous && previous.x === position.x && previous.y === position.y) return clone(card);
      // Validate first, then commit once on drop; same-zone positioning keeps its clock.
      if (fromZone !== zone) {
        this._settle(card, now);
        card.zone = zone;
        card.startedAt = now;
      }
      card.positions[zone] = { x: position.x, y: position.y };
      card.updatedAt = now;
      this._event(fromZone === zone ? 'positioned' : 'moved', card, now, { fromZone, toZone: zone });
      return clone(card);
    }

    beginEdit(id, now = Date.now()) {
      timestamp(now);
      const card = this._active(id);
      const fromZone = card.zone;
      this._settle(card, now);
      card.zone = 'prep';
      card.updatedAt = now;
      this._event('editing', card, now, { fromZone, toZone: 'prep' });
      return clone(card);
    }

    update(id, fields, now = Date.now()) {
      timestamp(now);
      const card = this._active(id);
      const values = input({ title: card.title, description: card.description, category: card.category, ...fields });
      this.addCategory(values.category);
      Object.assign(card, values, { updatedAt: now });
      this._event('updated', card, now);
      return clone(card);
    }

    finish(id, status, reason = '', now = Date.now()) {
      timestamp(now);
      if (status !== 'completed' && status !== 'cancelled') throw new Error('请选择完成或取消。');
      const note = text(reason, '原因', 120, true);
      const card = this._active(id);
      const fromZone = card.zone;
      this._settle(card, now);
      Object.assign(card, { status, zone: null, startedAt: null, endedAt: now, updatedAt: now, reason: note });
      this._event(status, card, now, { fromZone, toZone: null, reason: note, snapshot: clone(card) });
      return clone(card);
    }

    restore(id, now = Date.now()) {
      timestamp(now);
      const card = this._card(id);
      if (card.status === 'active') throw new Error('这张卡片已经在看板上。');
      Object.assign(card, { status: 'active', zone: 'prep', startedAt: null, endedAt: null, updatedAt: now, reason: '' });
      this._event('restored', card, now, { fromZone: null, toZone: 'prep' });
      return clone(card);
    }

    stats(id, now = Date.now()) {
      timestamp(now);
      const card = this._card(id);
      const durations = { ...card.durations };
      if (card.status === 'active' && QUADRANTS.includes(card.zone) && validTime(card.startedAt)) {
        durations[card.zone] += Math.max(0, now - card.startedAt);
      }
      const total = QUADRANTS.reduce((sum, zone) => sum + durations[zone], 0);
      const percentages = blankDurations();
      for (const zone of QUADRANTS) percentages[zone] = total > 0 ? durations[zone] / total * 100 : 0;
      return { durations, total, percentages };
    }

    get(id) {
      const card = this.data.cards.find(item => item.id === id);
      return card ? clone(card) : null;
    }

    addCategory(name) {
      const category = text(name, '分类', 12);
      if (!this.data.categories.includes(category)) this.data.categories.push(category);
      return category;
    }

    exportData() {
      return clone(this.data);
    }
  }

  global.BoardModel = BoardModel;
})(globalThis);
