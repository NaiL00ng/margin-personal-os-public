(async function () {
  'use strict';
  const STORAGE_KEY = 'margin.matrix.v1';
  const remote = document.querySelector('meta[name="margin-backend"][content="sqlite"]') ? new MarginStorage() : null;
  document.body.dataset.storage = remote ? 'database' : 'browser';
  const ZONES = ['q1', 'q2', 'q3', 'q4'];
  const VISUAL_ZONES = ['q2', 'q1', 'q4', 'q3'];
  const NAMES = { prep: '准备区', q1: 'I · 现在着手', q2: 'II · 留给自己', q3: 'III · 安排妥当', q4: 'IV · 暂且放下' };
  const DEFAULT_COLORS = { q1: '#f2c7ba', q2: '#d9dfbc', q3: '#d5dfec', q4: '#e5d8ed' };
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const cpLength = value => Array.from(value).length;
  const time = milliseconds => {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60;
    return hours ? hours + ':' + String(minutes).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0') : String(minutes).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
  };
  const date = timestamp => new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp));
  let loaded;
  let lastSavedRaw = null;
  let storageFailed = false;
  let writesBlocked = false;
  try {
    lastSavedRaw = localStorage.getItem(STORAGE_KEY);
    if (lastSavedRaw) {
      loaded = JSON.parse(lastSavedRaw);
      if (!loaded || loaded.version !== 1 || !Array.isArray(loaded.cards)) throw new Error('Unrecognized saved data');
    }
  } catch (_) { loaded = undefined; storageFailed = !remote; writesBlocked = !remote; }
  let board = new BoardModel(remote ? undefined : loaded);
  let mutationPending = false;
  const busy = new Set();
  const reducedPreference = matchMedia('(prefers-reduced-motion: reduce)');
  let activeDialog = null;
  let drag = null;
  let toastTimeout;
  let holdFrame;
  let scrollFrame;
  let lastDragAt = 0;
  let topCard = 1;
  let editingCard = null;
  const settlingEdits = new Set();

  function persist() {
    if (remote) throw new Error('数据库模式必须通过操作接口保存。');
    if (writesBlocked) {
      $('.local-label').textContent = '本页草稿 · 请先导出';
      $('.local-label').classList.add('storage-warning');
      toast('原有记录已保护。本页修改暂未保存，请导出本页记录后重新载入。');
      return false;
    }
    try {
      if (localStorage.getItem(STORAGE_KEY) !== lastSavedRaw) {
        writesBlocked = true;
        return persist();
      }
      const next = JSON.stringify(board.exportData());
      localStorage.setItem(STORAGE_KEY, next);
      lastSavedRaw = next;
      return true;
    }
    catch (_) {
      storageFailed = true;
      $('.local-label').textContent = '本次暂未保存 · 请导出';
      $('.local-label').classList.add('storage-warning');
      toast('浏览器无法保存。请在记录册导出，关闭页面可能丢失本次修改。');
    }
  }

  function storageStatus(message, warning = false) {
    $('.local-label').textContent = message;
    $('.local-label').classList.toggle('storage-warning', warning);
  }
  if (remote) remote.onStatus = storageStatus;

  async function commit(action, payload) {
    if (mutationPending) throw new Error('上一操作正在保存，请稍候。');
    mutationPending = true;
    try {
      if (remote) {
        const response = await remote.command(action, payload);
        board = new BoardModel(response.state);
        return response.result || {};
      }
      let result;
      switch (action) {
        case 'create': result = board.create(payload.fields); break;
        case 'place': result = board.place(payload.id, payload.zone, payload.position); break;
        case 'move': result = board.move(payload.id, payload.zone); break;
        case 'begin_edit': result = board.beginEdit(payload.id); break;
        case 'update': result = board.update(payload.id, payload.fields); break;
        case 'finish': result = board.finish(payload.id, payload.status, payload.reason); break;
        case 'restore_card': result = board.restore(payload.id); break;
        case 'add_category': result = { name: board.addCategory(payload.name) }; break;
        case 'settings': board.data.settings = payload.settings; break;
        case 'arrange': payload.positions.forEach(item => board.place(item.id, item.zone, item.position)); break;
        default: throw new Error('此操作需要通过本机 Python 服务使用。');
      }
      if (!persist()) throw new Error('本次修改尚未保存，请导出本页记录。');
      return result || {};
    } catch (error) {
      if (remote?.snapshot) board = new BoardModel(remote.snapshot.state);
      throw error;
    } finally { mutationPending = false; }
  }

  async function saveSettings(patch) {
    const settings = { ...board.data.settings, ...patch };
    try { await commit('settings', { settings }); applySettings(); }
    catch (error) { applySettings(); toast(error.message); }
  }

  function toast(message, label, action) {
    clearTimeout(toastTimeout);
    const element = $('#toast');
    element.replaceChildren(document.createTextNode(message));
    if (label && action) {
      const button = document.createElement('button');
      button.textContent = label;
      button.onclick = () => { element.classList.remove('visible'); action(); };
      element.append(button);
    }
    element.classList.add('visible');
    toastTimeout = setTimeout(() => element.classList.remove('visible'), label ? 9000 : 4300);
  }

  // Shared dialog primitive: focus containment, Escape, backdrop and focus restoration.
  function openDialog({ title, eyebrow = 'MARGIN / A SMALL PAUSE', subtitle = '', body = '', wide = false, onClose = null }) {
    if (drag) { lastDragAt = Date.now(); cleanDrag(); }
    if (activeDialog) activeDialog.close();
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'dialog-overlay';
    overlay.innerHTML = '<section class="dialog' + (wide ? ' wide' : '') + '" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><div class="dialog-header"><div><div class="tiny-label">' + esc(eyebrow) + '</div><h2 id="dialog-title">' + esc(title) + '</h2></div><button class="dialog-close" aria-label="关闭窗口">×</button></div>' + (subtitle ? '<p class="dialog-subtitle">' + esc(subtitle) + '</p>' : '') + '<div class="dialog-body"></div></section>';
    const panel = overlay.querySelector('.dialog');
    const container = panel.querySelector('.dialog-body');
    if (typeof body === 'string') container.innerHTML = body;
    else container.appendChild(body);
    const close = () => {
      if (!overlay.isConnected) return;
      if (panel.dataset.saving === 'true') { toast('正在保存，请稍候。'); return; }
      overlay.remove();
      document.body.classList.remove('scroll-lock');
      if (activeDialog?.overlay === overlay) activeDialog = null;
      if (onClose) onClose();
      (previousFocus?.isConnected ? previousFocus : $('#new-card')).focus({ preventScroll: true });
    };
    overlay.querySelector('.dialog-close').onclick = close;
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    overlay.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      if (event.key !== 'Tab') return;
      const items = Array.from(panel.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')).filter(item => item.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    $('#dialog-root').append(overlay);
    document.body.classList.add('scroll-lock');
    const result = { overlay, panel, close };
    activeDialog = result;
    requestAnimationFrame(() => (panel.querySelector('[data-autofocus]') || panel.querySelector('input, textarea') || panel.querySelector('button'))?.focus());
    return result;
  }

  function inform(title, message) {
    const dialog = openDialog({ title, subtitle: message, body: '<div class="dialog-actions"><button class="primary-button" data-ack>知道了</button></div>' });
    dialog.panel.querySelector('[data-ack]').onclick = dialog.close;
  }

  function effectiveMotion() {
    const preference = board.data.settings.motion;
    return preference === 'full' && board.data.settings.respectSystem !== false && reducedPreference.matches ? 'reduced' : preference;
  }
  function applySettings() {
    for (const zone of ZONES) {
      const color = board.data.settings.colors[zone];
      document.documentElement.style.setProperty('--' + zone, color);
      const full = color.length === 4 ? '#' + color.slice(1).split('').map(c => c + c).join('') : color;
      const rgb = full.slice(1).match(/../g).map(value => parseInt(value, 16));
      const light = rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114 > 145;
      $('.' + zone).style.color = light ? '#30332d' : '#f9f7ed';
    }
    const mode = effectiveMotion();
    document.body.dataset.motion = mode;
    BoardEffects.setMode(mode);
    document.querySelectorAll('[data-motion]').forEach(button => {
      const selected = button.dataset.motion === board.data.settings.motion;
      button.classList.toggle('active', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    $('#motion-hint').textContent = mode !== board.data.settings.motion ? '已跟随系统偏好，使用轻柔动效。' : mode === 'off' ? '动效已关闭，所有操作照常可用。' : mode === 'reduced' ? '保留轻微淡入淡出，减少运动。' : '一点随机的纸感，一切由你掌控。';
  }
  function setMotion(mode) {
    if (!['full', 'reduced', 'off'].includes(mode)) return;
    saveSettings({ motion: mode });
  }
  $('#motion-controls').addEventListener('click', event => { const button = event.target.closest('[data-motion]'); if (button) setMotion(button.dataset.motion); });
  reducedPreference.addEventListener('change', applySettings);

  function renderCard(card) {
    const element = document.createElement('article');
    element.className = 'note';
    if (settlingEdits.has(card.id)) element.classList.add('edit-held-target');
    element.dataset.id = card.id;
    element.setAttribute('tabindex', '0');
    element.setAttribute('role', 'button');
    element.setAttribute('aria-label', '查看事项：' + card.title);
    element.setAttribute('aria-grabbed', 'false');
    element.style.setProperty('--paper-color', card.appearance.color);
    element.style.setProperty('--paper-angle', card.appearance.rotation + 'deg');
    element.innerHTML = '<div class="paper"><h3>' + esc(card.title) + '</h3><span class="note-time" data-timer="' + esc(card.id) + '"></span></div>';
    element.title = card.title + ' · 点击查看详情，拖动自由摆放';
    element.addEventListener('focus', () => { element.style.zIndex = String(++topCard); });
    element.addEventListener('pointerenter', () => { if (!drag) element.style.zIndex = String(++topCard); });
    element.addEventListener('pointerdown', beginDrag);
    element.addEventListener('click', event => {
      if (Date.now() - lastDragAt < 350 || busy.has(card.id)) return;
      event.stopPropagation();
      showDetail(card.id);
    });
    element.addEventListener('keydown', event => {
      if (event.target !== element) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showDetail(card.id); }
    });
    BoardEffects.bind(element);
    return element;
  }

  const clamp = value => Math.max(0, Math.min(1, value));
  function canvasMetrics(list, element) {
    const inset = 8;
    return { inset, width: element.offsetWidth, height: element.offsetHeight,
      x: Math.max(0, list.clientWidth - element.offsetWidth - inset * 2),
      y: Math.max(0, list.clientHeight - element.offsetHeight - inset * 2) };
  }
  function gridPosition(index, metrics) {
    const cols = Math.max(1, Math.floor(metrics.x / (metrics.width + 12)) + 1);
    const rows = Math.max(1, Math.floor(metrics.y / (metrics.height + 12)) + 1);
    const slot = index % (cols * rows);
    // A small cascade keeps additional notes reachable by their exposed edge;
    // keyboard focus also raises every card, including fully overlapping ones.
    const cascade = Math.floor(index / (cols * rows)) * 9;
    return {
      x: metrics.x ? clamp(((slot % cols) * (metrics.width + 12) + cascade) / metrics.x) : 0,
      y: metrics.y ? clamp((Math.floor(slot / cols) * (metrics.height + 12) + cascade) / metrics.y) : 0
    };
  }
  function layoutCards() {
    for (const zone of ZONES) {
      const list = $('#zone-' + zone);
      Array.from(list.children).forEach((element, index) => {
        const metrics = canvasMetrics(list, element);
        const position = board.get(element.dataset.id)?.positions?.[zone] || gridPosition(index, metrics);
        element.style.left = metrics.inset + position.x * metrics.x + 'px';
        element.style.top = metrics.inset + position.y * metrics.y + 'px';
      });
    }
  }
  async function arrangeCards() {
    if (drag || busy.size || mutationPending) return;
    const positions = [];
    for (const zone of ZONES) {
      const list = $('#zone-' + zone);
      Array.from(list.children).forEach((element, index) => {
        positions.push({ id: element.dataset.id, zone, position: gridPosition(index, canvasMetrics(list, element)) });
      });
    }
    try {
      await commit('arrange', { positions }); layoutCards();
      toast('已按网格整理；驻留计时保持连续。卡片仍可自由摆放。');
    } catch (error) { toast(error.message); render(); }
  }
  function dropPosition(previous, destination, event) {
    const list = $('#zone-' + destination);
    // Preparation cards stretch to their tray column. Measure a temporary,
    // inert copy in the destination to use the destination's actual card size.
    const probe = previous.source.cloneNode(true);
    probe.removeAttribute('data-id'); probe.removeAttribute('tabindex');
    probe.inert = true; probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText = 'visibility:hidden;pointer-events:none;left:0;top:0';
    list.append(probe);
    const metrics = canvasMetrics(list, probe);
    probe.remove();
    const rect = list.getBoundingClientRect();
    return {
      x: metrics.x ? clamp((event.clientX - rect.left - previous.anchorX * metrics.width - metrics.inset) / metrics.x) : 0,
      y: metrics.y ? clamp((event.clientY - rect.top - previous.anchorY * metrics.height - metrics.inset) / metrics.y) : 0
    };
  }
  function archiveRecords() {
    return board.data.events.filter(event => ['completed', 'cancelled'].includes(event.type)).map(event => {
      const current = board.get(event.cardId);
      const card = event.snapshot || (current && current.endedAt === event.at ? current : null);
      return card ? { ...event, card } : null;
    }).filter(Boolean).sort((a, b) => b.at - a.at);
  }
  function render() {
    for (const zone of ['prep', ...ZONES]) {
      const cards = board.data.cards.filter(card => card.status === 'active' && card.zone === zone && card.id !== editingCard?.id);
      const list = $('#zone-' + zone);
      list.replaceChildren(...cards.map(renderCard));
      (zone === 'prep' ? $('#preparation') : $('.' + zone)).classList.toggle('has-cards', cards.length > 0);
      $(zone === 'prep' ? '#prep-count' : '#count-' + zone).textContent = String(cards.length).padStart(2, '0');
    }
    const active = board.data.cards.filter(card => card.status === 'active');
    const counting = active.filter(card => ZONES.includes(card.zone)).length;
    $('#board-summary').textContent = counting + ' 张正在象限驻留 · ' + active.length + ' 张待办';
    $('#archive-count').textContent = archiveRecords().length;
    layoutCards();
    updateClocks();
  }
  function updateClocks() {
    const now = remote?.ready ? remote.now() : Date.now();
    document.querySelectorAll('[data-timer]').forEach(element => {
      const card = board.get(element.dataset.timer);
      if (!card || card.status !== 'active') return;
      const stats = board.stats(card.id, now);
      element.textContent = time(card.zone === 'prep' ? stats.total : stats.durations[card.zone]);
      element.title = card.zone === 'prep' ? '累计象限驻留；准备区不计时' : '当前象限累计驻留；并非实际工时';
    });
    if (activeDialog?.panel.dataset.detailId) {
      const holder = activeDialog.panel.querySelector('[data-live-stats]');
      if (holder) holder.innerHTML = statisticsHTML(board.get(activeDialog.panel.dataset.detailId));
    }
  }

  function boundedField(input, count, limit) {
    const update = event => {
      if (!event?.isComposing && cpLength(input.value) > limit) input.value = Array.from(input.value).slice(0, limit).join('');
      count.textContent = cpLength(input.value) + ' / ' + limit;
    };
    input.addEventListener('input', update);
    input.addEventListener('compositionend', update);
    update();
  }
  function finishEditing(id) {
    if (editingCard?.id !== id) return;
    const held = editingCard;
    editingCard = null;
    busy.add(id);
    settlingEdits.add(id);
    render();
    const target = document.querySelector('[data-id="' + CSS.escape(id) + '"]');
    if (target) target.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    // release() hides the destination synchronously, before the browser can paint
    // both copies. The model was already paused in prep when editing started.
    const settled = () => {
      settlingEdits.delete(id);
      document.querySelector('[data-id="' + CSS.escape(id) + '"]')?.classList.remove('edit-held-target');
      busy.delete(id);
    };
    try {
      Promise.resolve(held.visual?.release(target)).catch(() => held.visual?.dispose())
        .finally(settled);
    } catch (_) { held.visual?.dispose(); settled(); }
  }
  function showForm(cardId) {
    const card = cardId ? board.get(cardId) : null;
    let category = card?.category || board.data.categories[0];
    const dialog = openDialog({ title: card ? '给这个念头一个新方向' : '把一个念头放下来', subtitle: card ? '卡片暂留在调整处，关闭窗口后移入准备区。纸面与驻留记录保留。' : '不用写得完美，一小步就够了。', body: '<form id="card-form"><label class="form-field"><span class="field-top"><span>事项名称</span><span id="title-count" class="char-count"></span></span><input id="card-title" data-autofocus autocomplete="off" required placeholder="想做的一件小事" value="' + esc(card?.title || '') + '"></label><label class="form-field"><span class="field-top"><span>具体描述 <span class="micro">· 可选</span></span><span id="description-count" class="char-count"></span></span><textarea id="card-description" placeholder="留一句给之后的自己">' + esc(card?.description || '') + '</textarea></label><div class="field-top"><span>分类</span><span class="micro">可以有自己的名字</span></div><div class="category-options"></div><div class="category-add" hidden><input id="category-name" placeholder="自定义分类，最多 12 字" aria-label="自定义分类"><button type="button" id="save-category">添加</button></div><p class="form-error" role="alert"></p><p class="form-note">' + (card ? '编辑期间暂停计时；关闭后回准备区。取消仅放弃本次文字修改。' : '纸色、角度和小符号会随机生成；之后修改不会重新抽取。') + '</p><div class="dialog-actions"><button type="button" class="secondary-button" data-cancel>暂时不改</button><button type="submit" class="primary-button">' + (card ? '保存到准备区' : '生成便利贴 ↗') + '</button></div></form>', onClose: () => {
      if (card) finishEditing(card.id);
    } });
    if (card) dialog.overlay.classList.add('editing-dialog');
    const panel = dialog.panel;
    const form = panel.querySelector('form');
    const lockForm = locked => {
      panel.dataset.saving = String(locked);
      form.querySelectorAll('input,textarea,button').forEach(element => element.disabled = locked);
    };
    panel.querySelector('[data-cancel]').textContent = card ? '取消编辑' : '先不写了';
    panel.querySelector('[data-cancel]').onclick = dialog.close;
    boundedField(panel.querySelector('#card-title'), panel.querySelector('#title-count'), 28);
    boundedField(panel.querySelector('#card-description'), panel.querySelector('#description-count'), 120);
    const drawCategories = () => {
      const container = panel.querySelector('.category-options');
      container.innerHTML = board.data.categories.map(name => '<button type="button" class="category-chip' + (name === category ? ' selected' : '') + '" data-category="' + esc(name) + '" aria-pressed="' + (name === category) + '">' + esc(name) + '</button>').join('') + '<button type="button" class="category-chip" id="add-category" aria-label="添加自定义分类">＋</button>';
      container.querySelectorAll('[data-category]').forEach(button => button.onclick = () => { category = button.dataset.category; drawCategories(); });
      container.querySelector('#add-category').onclick = () => { panel.querySelector('.category-add').hidden = false; panel.querySelector('#category-name').focus(); };
    };
    drawCategories();
    const saveCategory = async () => {
      if (panel.dataset.saving === 'true') return;
      lockForm(true);
      try {
        const result = await commit('add_category', { name: panel.querySelector('#category-name').value });
        category = result.name;
        drawCategories(); panel.querySelector('.category-add').hidden = true;
        panel.querySelector('.form-error').textContent = '';
      } catch (error) { panel.querySelector('.form-error').textContent = error.message; }
      finally { lockForm(false); }
    };
    panel.querySelector('#save-category').onclick = saveCategory;
    panel.querySelector('#category-name').onkeydown = event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); saveCategory(); } };
    form.onsubmit = async event => {
      event.preventDefault();
      if (panel.dataset.saving === 'true') return;
      lockForm(true);
      try {
        const fields = { title: panel.querySelector('#card-title').value, description: panel.querySelector('#card-description').value, category };
        const result = await commit(card ? 'update' : 'create', card ? { id: card.id, fields } : { fields });
        panel.dataset.saving = 'false';
        dialog.close();
        if (!card) {
          render();
          const element = document.querySelector('[data-id="' + CSS.escape(result.id) + '"]');
          if (element) { BoardEffects.enter(element); element.scrollIntoView({ block: 'nearest', behavior: 'instant' }); }
        }
        toast(card ? '已调整，计时暂停。准备好后再放入象限。' : '便利贴已准备好，拖入一个象限开始驻留。');
      } catch (error) { panel.querySelector('.form-error').textContent = error.message; }
      finally { lockForm(false); }
    };
  }

  function statsFromCard(card) {
    if (card.status === 'active') return board.stats(card.id, remote?.ready ? remote.now() : Date.now());
    const durations = card.durations;
    const total = ZONES.reduce((sum, zone) => sum + durations[zone], 0);
    return { durations, total, percentages: Object.fromEntries(ZONES.map(zone => [zone, total ? durations[zone] / total * 100 : 0])) };
  }
  function statisticsHTML(card) {
    if (!card) return '';
    const stats = statsFromCard(card);
    return '<div class="detail-meta">累计象限驻留 <strong>' + time(stats.total) + '</strong>' + (stats.total ? '' : ' · 尚未在象限驻留') + '</div><div class="duration-bar">' + ZONES.map(zone => '<span style="width:' + stats.percentages[zone] + '%;background:' + board.data.settings.colors[zone] + '" title="' + NAMES[zone] + '"></span>').join('') + '</div><div class="duration-legend">' + ZONES.map(zone => '<span><i style="background:' + board.data.settings.colors[zone] + '"></i>' + zone.slice(1) + ' 象限 ' + time(stats.durations[zone]) + ' · ' + Math.round(stats.percentages[zone]) + '%</span>').join('') + '</div>';
  }
  function showDetail(id) {
    const card = board.get(id);
    if (!card || busy.has(id)) return;
    const eventNames = { created: '生成', moved: '移动', positioned: '调整位置', editing: '进入调整', updated: '更新内容', completed: '完成归档', cancelled: '取消归档', restored: '恢复到准备区' };
    const events = board.data.events.filter(event => event.cardId === id).slice(-12).reverse();
    const dialog = openDialog({ title: '这一张，走过的路', body: '<div class="detail-meta">' + esc(card.category) + ' · 创建于 ' + date(card.createdAt) + '</div><div class="detail-title">' + esc(card.title) + '</div><p class="detail-description">' + esc(card.description || '没有额外描述，也没关系。') + '</p><div data-live-stats>' + statisticsHTML(card) + '</div>' + (card.status === 'active' ? '<div class="settings-section"><h3>放到哪里？ <span class="micro">键盘与触屏也可以这样操作</span></h3><div class="move-grid">' + VISUAL_ZONES.map(zone => '<button data-place="' + zone + '" class="' + (card.zone === zone ? 'current' : '') + '">' + NAMES[zone] + '</button>').join('') + '</div><div class="detail-operations"><button data-place="prep">回准备区</button><button data-detail-action="edit">↺ 调整</button><button data-detail-action="complete">✓ 完成</button><button data-detail-action="void"><span class="black-hole-icon black-hole-icon--inline" aria-hidden="true"></span> Void</button></div></div>' : '<div class="dialog-actions"><button class="secondary-button" data-restore>恢复到准备区</button></div>') + '<div class="settings-section"><h3>过程留痕</h3><ul class="log-list">' + events.map(event => '<li>' + date(event.at) + ' · ' + esc(eventNames[event.type] || event.type) + (event.type === 'moved' ? ' → ' + esc(NAMES[event.toZone] || '') : '') + (event.reason ? ' · ' + esc(event.reason) : '') + '</li>').join('') + '</ul><p>驻留记录位置变化，不代表实际工作时长；多张卡片可以同时计时。</p></div>' });
    dialog.panel.dataset.detailId = id;
    dialog.panel.querySelectorAll('[data-place]').forEach(button => button.onclick = async () => {
      try {
        await commit('move', { id, zone: button.dataset.place }); dialog.close(); render();
        toast('已移到' + NAMES[button.dataset.place] + (button.dataset.place === 'prep' ? '，计时暂停。' : '。'));
      } catch (error) { toast(error.message); render(); }
    });
    dialog.panel.querySelectorAll('[data-detail-action]').forEach(button => button.onclick = () => {
      dialog.close();
      if (button.dataset.detailAction === 'void') confirmVoid(id);
      else handleAction(id, button.dataset.detailAction);
    });
    const restore = dialog.panel.querySelector('[data-restore]');
    if (restore) restore.onclick = () => { dialog.close(); restoreCard(id); };
  }
  function confirmVoid(id) {
    const dialog = openDialog({ title: '让这件事停在这里？', subtitle: '将停止计时并移入「已取消 · 便利贴坟场」。内容、纸面和驻留记录都会保留，之后可以恢复。', body: '<label class="form-field"><span class="field-top">留一句原因 <span class="micro">可选 · 最多 120 字</span></span><textarea id="void-reason" maxlength="120" placeholder="例如：现在已经不需要了"></textarea></label><div class="dialog-actions"><button class="secondary-button" data-back>保留原位</button><button class="danger-button" data-confirm>移入 Void</button></div>' });
    dialog.panel.querySelector('[data-back]').onclick = dialog.close;
    dialog.panel.querySelector('[data-confirm]').onclick = () => { const reason = dialog.panel.querySelector('#void-reason').value; dialog.close(); handleAction(id, 'void', reason); };
  }
  async function restoreCard(id) {
    try { await commit('restore_card', { id }); render(); toast('已回到准备区。原有驻留与归档记录都还在。'); }
    catch (error) { toast(error.message); }
  }

  async function handleAction(id, action, reason = '', visualOrigin) {
    const card = board.get(id);
    if (!card || card.status !== 'active' || busy.has(id) || mutationPending) return;
    busy.add(id);
    const element = document.querySelector('[data-id="' + CSS.escape(id) + '"]');
    let waitingVisual = null;
    try {
      // Keep the drop endpoint visible while the service confirms its transaction.
      if (element && remote) {
        try { waitingVisual = BoardEffects.park(element, visualOrigin); } catch (_) {}
      }
      await commit(action === 'edit' ? 'begin_edit' : 'finish', action === 'edit' ? { id } : { id, status: action === 'complete' ? 'completed' : 'cancelled', reason });
      if (action === 'edit') {
        let visual = waitingVisual;
        waitingVisual = null;
        if (element && !visual) {
          try { visual = BoardEffects.park(element, visualOrigin); }
          catch (_) { /* An unavailable decorative hold must not block editing. */ }
        }
        editingCard = { id, visual };
        render();
        showForm(id);
        return;
      }
      waitingVisual?.dispose(); waitingVisual = null;
      if (element) {
        element.dataset.noTilt = 'true';
        element.style.pointerEvents = 'none';
        try { await BoardEffects.exit(element, action === 'complete' ? 'completed' : 'cancelled', visualOrigin); }
        catch (_) { /* State stays valid if a decorative animation is unsupported. */ }
      }
      render();
      toast(action === 'complete' ? '完成已记下，过程也一起收好了。' : '已移入 Void。放下有痕迹，也可以重新开始。', '撤销', () => restoreCard(id));
    } catch (error) {
      waitingVisual?.dispose();
      if (editingCard?.id === id) { editingCard.visual?.dispose(); editingCard = null; }
      toast(error.message); render();
    }
    finally { busy.delete(id); }
  }

  function beginDrag(event) {
    if (event.button !== 0 || event.target.closest('button') || activeDialog || drag || busy.size || mutationPending || (remote && (!remote.ready || remote.pending))) return;
    const source = event.currentTarget;
    if (busy.has(source.dataset.id)) return;
    source.style.zIndex = String(++topCard);
    const rect = source.getBoundingClientRect();
    drag = { id: source.dataset.id, source, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, anchorX: clamp((event.clientX - rect.left) / rect.width), anchorY: clamp((event.clientY - rect.top) / rect.height), width: source.offsetWidth, started: false, target: null, hoverStart: 0, armed: false, x: event.clientX, y: event.clientY };
    try { source.setPointerCapture(event.pointerId); } catch (_) {}
  }
  function clearDrop() {
    cancelAnimationFrame(holdFrame);
    document.querySelectorAll('.drop-active,.armed').forEach(element => element.classList.remove('drop-active', 'armed'));
    $('.void-drop').style.setProperty('--hold', '0');
    $('#void-instruction').textContent = '拖入，停留 1.2 秒后松手';
  }
  function holdTick() {
    if (!drag?.started || drag.target?.dataset.drop !== 'void') return;
    const progress = Math.min(1, (performance.now() - drag.hoverStart) / 1200);
    $('.void-drop').style.setProperty('--hold', String(progress));
    drag.armed = progress >= 1;
    $('.void-drop').classList.toggle('armed', drag.armed);
    $('#void-instruction').textContent = drag.armed ? '松手以取消 · 移开可反悔' : '继续停留 ' + ((1200 - (performance.now() - drag.hoverStart)) / 1000).toFixed(1) + ' 秒';
    if (!drag.armed) holdFrame = requestAnimationFrame(holdTick);
  }
  function pointerMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.x = event.clientX; drag.y = event.clientY;
    if (!drag.started && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    if (!drag.started) {
      drag.started = true;
      drag.source.classList.add('drag-source');
      drag.source.setAttribute('aria-grabbed', 'true');
      drag.source.dataset.dragging = 'true';
      const ghost = drag.source.cloneNode(true);
      ghost.classList.remove('drag-source'); ghost.classList.add('drag-ghost');
      ghost.removeAttribute('data-id'); ghost.removeAttribute('tabindex');
      ghost.setAttribute('aria-hidden', 'true'); ghost.inert = true;
      ghost.style.width = drag.width + 'px';
      ghost.style.zIndex = '900';
      ghost.querySelector('.paper').style.transform = '';
      ghost.querySelectorAll('[data-timer]').forEach(node => node.removeAttribute('data-timer'));
      document.body.append(ghost); drag.ghost = ghost;
      document.body.style.cursor = 'grabbing';
      scrollFrame = requestAnimationFrame(autoScrollDrag);
    }
    event.preventDefault();
    drag.ghost.style.left = event.clientX - drag.offsetX + 'px';
    drag.ghost.style.top = event.clientY - drag.offsetY + 'px';
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-drop]');
    if (target !== drag.target) {
      clearDrop(); drag.target = target || null; drag.armed = false;
      if (target) {
        target.classList.add('drop-active');
        if (target.dataset.drop === 'void') { drag.hoverStart = performance.now(); holdTick(); }
      }
    }
    // Allow a long quadrant or preparation tray to accept more notes.
    const scrollList = target?.querySelector('.card-list,.prep-list');
    if (scrollList && scrollList.scrollHeight > scrollList.clientHeight) {
      const rect = scrollList.getBoundingClientRect();
      if (event.clientY > rect.bottom - 32) scrollList.scrollTop += 9;
      if (event.clientY < rect.top + 32) scrollList.scrollTop -= 9;
    }
  }
  function autoScrollDrag() {
    if (!drag?.started) return;
    const delta = drag.y > innerHeight - 48 ? 11 : drag.y < 48 ? -11 : 0;
    if (delta) window.scrollBy(0, delta);
    {
      const target = document.elementFromPoint(drag.x, drag.y)?.closest('[data-drop]');
      if (target !== drag.target) {
        clearDrop(); drag.target = target || null; drag.armed = false;
        if (target) {
          target.classList.add('drop-active');
          if (target.dataset.drop === 'void') { drag.hoverStart = performance.now(); holdTick(); }
        }
      }
    }
    scrollFrame = requestAnimationFrame(autoScrollDrag);
  }
  function cleanDrag() {
    if (!drag) return;
    const previous = drag;
    drag = null;
    cancelAnimationFrame(scrollFrame);
    clearDrop();
    previous.ghost?.remove();
    previous.source.classList.remove('drag-source');
    previous.source.removeAttribute('data-dragging');
    previous.source.setAttribute('aria-grabbed', 'false');
    try { previous.source.releasePointerCapture(previous.pointerId); } catch (_) {}
    document.body.style.cursor = '';
    return previous;
  }
  async function pointerUp(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const actualTarget = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-drop]');
    const confirmedVoid = !activeDialog && actualTarget === drag.target && drag.armed;
    let visualOrigin;
    const destination = activeDialog ? null : actualTarget?.dataset.drop;
    if (drag.ghost && (['edit', 'complete'].includes(destination) || (destination === 'void' && confirmedVoid))) {
      // Keep the released ghost's viewport position, size and angle before cleanup.
      // This is decorative geometry only; the card's zone and history never move.
      drag.ghost.style.left = event.clientX - drag.offsetX + 'px';
      drag.ghost.style.top = event.clientY - drag.offsetY + 'px';
      const bounds = drag.ghost.getBoundingClientRect();
      visualOrigin = {
        left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
        layoutWidth: drag.ghost.offsetWidth, layoutHeight: drag.ghost.offsetHeight,
        transform: getComputedStyle(drag.ghost).transform
      };
    }
    const previous = cleanDrag();
    if (!previous.started) return;
    lastDragAt = Date.now();
    if (!destination) { toast('没有落入区域，便利贴已回到原位。'); return; }
    if (destination === 'void' && !confirmedVoid) { toast('还没有确认取消。拖入 Void，停留 1.2 秒后再松手。'); return; }
    if (['complete', 'edit', 'void'].includes(destination)) { handleAction(previous.id, destination, '', visualOrigin); return; }
    try {
      if (ZONES.includes(destination)) await commit('place', { id: previous.id, zone: destination, position: dropPosition(previous, destination, event) });
      else await commit('move', { id: previous.id, zone: destination });
      render();
    }
    catch (error) { toast(error.message); render(); }
  }
  document.addEventListener('pointermove', pointerMove, { passive: false });
  document.addEventListener('selectstart', event => {
    const target = event.target.nodeType === 1 ? event.target : event.target.parentElement;
    if (!target?.closest('input,textarea') && !target?.isContentEditable) event.preventDefault();
  });
  document.addEventListener('pointerup', pointerUp);
  document.addEventListener('pointercancel', () => { if (drag) { lastDragAt = Date.now(); cleanDrag(); } });
  window.addEventListener('blur', () => { if (drag) { lastDragAt = Date.now(); cleanDrag(); } });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); lastDragAt = Date.now(); cleanDrag(); }
    if (event.key.toLowerCase() === 'n' && !activeDialog && !event.ctrlKey && !event.metaKey && !event.altKey && !event.target.matches('input,textarea')) showForm();
  });

  function showHistory(tab = 'completed') {
    const records = archiveRecords();
    const counts = { completed: records.filter(record => record.type === 'completed').length, cancelled: records.filter(record => record.type === 'cancelled').length };
    const dialog = openDialog({ title: '每一张，都有来处', eyebrow: 'THE NOTEBOOK / 记录册', subtitle: '完成与取消分别记下。恢复不会擦掉曾经的选择。', wide: true, body: '<div class="archive-tabs"><button class="archive-tab" data-tab="completed">已完成 · ' + counts.completed + '</button><button class="archive-tab" data-tab="cancelled">已取消 · ' + counts.cancelled + '</button></div><div class="archive-content"></div><div class="dialog-actions"><button class="secondary-button" id="export-records">导出完整记录 ↓</button></div>' });
    const draw = selected => {
      dialog.panel.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === selected));
      const items = records.filter(record => record.type === selected);
      const holder = dialog.panel.querySelector('.archive-content');
      holder.innerHTML = (selected === 'cancelled' ? '<p class="form-note">便利贴坟场 / 留下当时的内容、外观和驻留分布。这里不统计失败。</p>' : '') + (!items.length ? '<div class="archive-empty">' + (selected === 'completed' ? '第一张完成的便利贴，会在这里留下过程。' : '这里还没有被放下的事项。') + '<br>每个选择都可以慢慢来。</div>' : '<div class="archive-list">' + items.map(record => {
        const card = record.card;
        const current = board.get(card.id);
        const canRestore = current && current.status !== 'active' && current.endedAt === record.at;
        return '<article class="archive-item"><div class="archive-paper" style="background:' + card.appearance.color + ';transform:rotate(' + card.appearance.rotation + 'deg)"><small>' + esc(card.category) + '</small><p>' + esc(card.title) + '</p><span class="note-symbol">' + esc(card.appearance.sticker) + '</span></div><div class="archive-info"><div class="archive-meta"><span>' + (selected === 'completed' ? '✓ 已完成' : '<span class="black-hole-icon black-hole-icon--inline" aria-hidden="true"></span> 已取消') + '</span><span>' + date(record.at) + '</span>' + (!canRestore ? '<span>已有后续记录</span>' : '') + '</div><p class="archive-desc">' + esc(card.description || '未填写描述') + '</p>' + statisticsHTML(card) + (record.reason ? '<p class="archive-desc">当时的原因：' + esc(record.reason) + '</p>' : '') + '<div class="archive-actions"><button data-history-detail="' + esc(card.id) + '">查看过程</button>' + (canRestore ? '<button data-history-restore="' + esc(card.id) + '">恢复到准备区 ↗</button>' : '') + '</div></div></article>';
      }).join('') + '</div>');
      holder.querySelectorAll('[data-history-restore]').forEach(button => button.onclick = () => { dialog.close(); restoreCard(button.dataset.historyRestore); });
      holder.querySelectorAll('[data-history-detail]').forEach(button => button.onclick = () => { dialog.close(); showDetail(button.dataset.historyDetail); });
    };
    dialog.panel.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => draw(button.dataset.tab));
    dialog.panel.querySelector('#export-records').onclick = exportRecords;
    draw(tab);
  }

  async function exportRecords() {
    try {
      const output = remote ? await remote.request('/api/export') : board.exportData();
      if (!remote) {
        output.exportedAt = new Date().toISOString();
        output.residenceStatistics = output.cards.map(card => ({ id: card.id, ...board.stats(card.id) }));
      }
      const url = URL.createObjectURL(new Blob([JSON.stringify(output, null, 2)], { type: 'application/json;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = 'margin-notes-' + new Date().toISOString().slice(0, 10) + '.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('已导出内容、外观、历史快照与驻留记录。');
    } catch (error) { toast(error.message); }
  }

  async function reconnect() {
    try {
      await remote.connect();
      board = new BoardModel(remote.snapshot.state);
      applySettings(); render();
      toast('已核对本机数据库中的最新记录。');
    } catch (error) {
      if (remote.snapshot) { board = new BoardModel(remote.snapshot.state); applySettings(); render(); }
      storageStatus('连接或保存待确认 · 打开数据与备份', true);
      toast(error.message);
    }
  }

  function showData() {
    if (!remote) return;
    const dialog = openDialog({ title: '让记录留得住', eyebrow: 'YOUR DATA / 数据与备份', wide: true,
      subtitle: '记录保存在这台电脑的数据库。关闭浏览器不影响保存；没有跨设备同步。',
      body: '<div class="data-toolbar"><button class="secondary-button" id="data-reconnect">重新连接 / 重试保存</button><button class="secondary-button" id="data-export">导出完整 JSON ↓</button></div><section class="settings-section"><h3>导入旧记录</h3><p>选择原型导出的 JSON，先预览再导入。旧文件与浏览器记录会保留，同一份记录不会重复导入。</p><label class="form-field"><span>选择 JSON 文件</span><input id="import-file" type="file" accept=".json,application/json"></label>' + (lastSavedRaw ? '<button class="text-button" id="import-browser">预览此地址下的旧浏览器记录 ↗</button>' : '') + '<div id="import-preview" aria-live="polite"></div></section><section class="settings-section"><h3>本机备份</h3><p>恢复将把看板和历史还原到选定备份。恢复前会自动保留当前数据库；离线期间的象限驻留仍按墙钟累计。</p><button class="secondary-button" id="create-backup">创建当前备份</button><div id="backup-list" class="backup-list" aria-live="polite">正在读取备份…</div><div id="restore-preview"></div></section><p class="data-error" role="alert"></p>' });
    const panel = dialog.panel;
    const report = error => { panel.querySelector('.data-error').textContent = error.message; };
    let importGeneration = 0;
    let restoreGeneration = 0;
    const lockPanel = locked => {
      if (locked) { importGeneration++; restoreGeneration++; }
      panel.dataset.saving = String(locked);
      panel.querySelectorAll('button,input').forEach(element => element.disabled = locked);
    };
    panel.querySelector('#data-reconnect').onclick = async () => {
      if (panel.dataset.saving === 'true') return;
      lockPanel(true); try { await reconnect(); } finally { lockPanel(false); }
    };
    panel.querySelector('#data-export').onclick = exportRecords;
    const summary = counts => esc(counts?.cards ?? 0) + ' 张便利贴 · ' + esc(counts?.events ?? 0) + ' 条过程记录';
    const previewImport = async data => {
      const generation = ++importGeneration;
      panel.querySelector('#import-preview').replaceChildren();
      try {
        panel.querySelector('.data-error').textContent = '';
        const preview = await remote.request('/api/import/preview', { data });
        if (generation !== importGeneration || !panel.isConnected) return;
        const holder = panel.querySelector('#import-preview');
        holder.innerHTML = '<div class="data-preview"><strong>' + summary(preview.counts) + '</strong>' +
          (preview.warnings || []).map(message => '<p>' + esc(message) + '</p>').join('') +
          (preview.errors || []).map(message => '<p class="data-error">' + esc(typeof message === 'string' ? message : JSON.stringify(message)) + '</p>').join('') +
          (preview.canImport ? '<button class="primary-button" id="confirm-import">确认导入</button>' : '<p>请修正文件后重新预览，数据库尚未更改。</p>') + '</div>';
        const confirm = holder.querySelector('#confirm-import');
        if (confirm) confirm.onclick = async () => {
          if (panel.dataset.saving === 'true') return;
          lockPanel(true);
          try {
            await commit('import', { data }); applySettings(); render();
            holder.innerHTML = '<p class="data-success">导入完成，原有文件保留。</p>';
          } catch (error) { report(error); confirm.disabled = false; }
          finally { lockPanel(false); }
        };
      } catch (error) { if (generation === importGeneration) report(error); }
    };
    panel.querySelector('#import-file').onchange = async event => {
      const file = event.target.files[0];
      if (!file) return;
      const generation = ++importGeneration;
      panel.querySelector('#import-preview').replaceChildren();
      try {
        if (file.size > 7 * 1024 * 1024) throw new Error('本版导入文件上限为 7 MiB，请保留原文件并分批整理。');
        const data = JSON.parse(await file.text());
        if (generation !== importGeneration || !panel.isConnected) return;
        await previewImport(data);
      } catch (error) { report(new Error(error instanceof SyntaxError ? '文件不是有效的 JSON，数据库尚未更改。' : error.message)); }
    };
    const oldBrowser = panel.querySelector('#import-browser');
    if (oldBrowser) oldBrowser.onclick = () => {
      try { previewImport(JSON.parse(lastSavedRaw)); }
      catch (_) { report(new Error('旧浏览器记录无法解析，请保留原始记录。')); }
    };
    const loadBackups = async () => {
      try {
        const response = await remote.request('/api/backups');
        const list = panel.querySelector('#backup-list');
        list.innerHTML = response.backups.length ? response.backups.map(item => '<div class="backup-row"><span>' + (item.createdAt == null ? '时间未知 · 此备份不可恢复' : date(item.createdAt)) + '<small>' + esc(item.id) + '</small>' + (item.error ? '<small class="data-error">' + esc(item.error) + '</small>' : '') + '</span>' + (item.canRestore === false ? '<span>不可恢复</span>' : '<button class="text-button" data-preview-backup="' + esc(item.id) + '">预览恢复 ↗</button>') + '</div>').join('') : '<p>还没有备份。可以先为当前记录留一份副本。</p>';
        list.querySelectorAll('[data-preview-backup]').forEach(button => button.onclick = async () => {
          const generation = ++restoreGeneration;
          panel.querySelector('#restore-preview').replaceChildren();
          try {
            const backupId = button.dataset.previewBackup;
            const preview = await remote.request('/api/backups/preview', { backupId });
            if (generation !== restoreGeneration || !panel.isConnected) return;
            const holder = panel.querySelector('#restore-preview');
            if (!preview.canRestore) throw new Error('此备份无法恢复，当前数据库尚未更改。');
            holder.innerHTML = '<div class="data-preview"><strong>将恢复：' + summary(preview.counts) + '</strong><p>' + date(preview.createdAt) + ' · ' + esc(backupId) + '</p><p>此操作会替换当前看板与历史；当前记录会先自动备份。确认后可从备份列表找回恢复前的状态。</p><button class="danger-button" id="confirm-restore">确认恢复这个备份</button></div>';
            holder.querySelector('#confirm-restore').onclick = async event => {
              if (panel.dataset.saving === 'true') return;
              lockPanel(true);
              try {
                await commit('restore_backup', { backupId }); applySettings(); render();
                holder.innerHTML = '<p class="data-success">已恢复，恢复前的记录已另存备份。</p>';
                await loadBackups();
              } catch (error) { report(error); }
              finally { lockPanel(false); }
            };
          } catch (error) { if (generation === restoreGeneration) report(error); }
        });
      } catch (error) { report(error); panel.querySelector('#backup-list').textContent = '备份列表暂时无法读取。'; }
    };
    panel.querySelector('#create-backup').onclick = async event => {
      if (panel.dataset.saving === 'true') return;
      lockPanel(true);
      try { await remote.request('/api/backups', {}); await loadBackups(); toast('已创建本机数据库备份。'); }
      catch (error) { report(error); }
      finally { lockPanel(false); }
    };
    loadBackups();
  }

  function showSettings() {
    const dialog = openDialog({ title: '让这片余白像你', eyebrow: 'YOUR SPACE / 外观与动效', body: '<div class="tiny-label">四象限颜色</div>' + VISUAL_ZONES.map(zone => '<div class="settings-row"><label for="color-' + zone + '">' + NAMES[zone] + '</label><input id="color-' + zone + '" data-color="' + zone + '" type="color" value="' + board.data.settings.colors[zone] + '"></div>').join('') + '<div class="dialog-actions"><button class="text-button" id="restore-colors">恢复纸色配色</button></div><div class="settings-section"><h3>动效强度</h3><div class="segmented"><button data-motion="full">灵动</button><button data-motion="reduced">轻柔</button><button data-motion="off">关闭</button></div><div class="settings-row"><label for="respect-system">跟随系统的减少动态效果偏好</label><input id="respect-system" type="checkbox"' + (board.data.settings.respectSystem !== false ? ' checked' : '') + '></div><p>灵动：悬停伪 3D、生成摇晃、调整暂留后移回、完成抖动缩小、Void 边缘燃烧。<br>轻柔：仅短暂淡入淡出。关闭：直接更新状态。<br>更改强度会立即结束正在播放的效果，数据不受影响。</p></div><div class="settings-section"><h3>数据只留在这里</h3><p>使用浏览器本地存储，不连接服务器账本。清除浏览器数据会移除本地记录；可在记录册导出备份。不同浏览器或地址的数据互不共享。</p></div>' });
    dialog.panel.querySelectorAll('[data-color]').forEach(input => input.onchange = () => saveSettings({ colors: { ...board.data.settings.colors, [input.dataset.color]: input.value } }));
    dialog.panel.querySelectorAll('[data-motion]').forEach(button => button.onclick = () => setMotion(button.dataset.motion));
    dialog.panel.querySelector('#respect-system').onchange = event => saveSettings({ respectSystem: event.target.checked });
    dialog.panel.querySelector('#restore-colors').onclick = async () => { await saveSettings({ colors: { ...DEFAULT_COLORS } }); dialog.panel.querySelectorAll('[data-color]').forEach(input => input.value = board.data.settings.colors[input.dataset.color]); };
    if (remote) {
      const sections = dialog.panel.querySelectorAll('.settings-section');
      sections[sections.length - 1].innerHTML = '<h3>保存在这台电脑</h3><p>便利贴、历史和偏好保存在本机 SQLite 数据库。清除浏览器缓存不会删除已确认的数据库记录。</p><button class="text-button" id="settings-data">打开数据与备份 ↗</button>';
      dialog.panel.querySelector('#settings-data').onclick = showData;
    }
    applySettings();
  }
  $('#new-card').onclick = () => showForm();
  $('#arrange-cards').onclick = arrangeCards;
  $('#adjust-action').onclick = () => inform('需要拖入某个事项以修改', '将便利贴拖到「调整」。卡片在落点暂留并暂停计时；保存、取消或关闭窗口后移到准备区，原有记录与纸面不重置。');
  $('#complete-action').onclick = () => inform('把做完的那一张放到这里', '拖入「完成」后，内容、外观和各象限驻留分布会进入记录册。也可以点击便利贴打开操作。');
  $('#void-action').onclick = () => inform('给放下留一个确认的瞬间', '拖入 Void 并停留 1.2 秒，看到「松手以取消」再松手。提前松手或移开都不会取消。被取消的便利贴进入记录册，可以恢复。');
  $('#open-history').onclick = () => showHistory();
  $('#open-data').hidden = !remote;
  $('#open-data').onclick = showData;
  $('#open-settings').onclick = showSettings;
  $('#color-settings').onclick = showSettings;
  $('#timer-help').onclick = () => inform('驻留，是位置的记录', '只有便利贴在四象限中才计时；准备区与编辑期间暂停。切换象限分别累计，刷新或关闭页面后仍按经过的时间累计。多张卡片可以同时计时，所以它不是专注或工作时长。');
  $('#help-button').onclick = () => openDialog({ title: '一小块自己的空间', body: '<ol class="help-list"><li>点「新建事项」生成便利贴。名称最多 28 字，描述最多 120 字，分类可以自定义。</li><li>把准备区的便利贴拖入四象限。可以在象限内自由摆放；同象限挪动不打断计时。位置会保存，重叠时可用「整理位置」。</li><li>拖到「调整」修改，拖到「完成」归档。Void 需悬停 1.2 秒后松手，取消也有完整记录。</li><li>点击便利贴可看驻留占比，也可用按钮移动、调整、完成或取消。键盘 Tab、Enter 可操作，N 新建，Esc 关闭或中止拖拽。</li><li>右上角可切换动效。所有随机性仅用于纸面与反馈，不改变事项重要性、驻留时间或操作结果。</li></ol><p class="form-note">' + (remote ? '本机数据库模式从空看板开始。数据与备份中可导入旧记录、创建备份和恢复；记录册可导出完整 JSON。' : '初次打开有四张示例便利贴，计时从首次加载开始。数据仅存在当前浏览器，记录册可以导出。') + '</p>' });

  window.addEventListener('storage', event => {
    if (remote) return;
    if (event.key !== STORAGE_KEY || event.newValue === lastSavedRaw) return;
    writesBlocked = true;
    $('.local-label').textContent = '其他窗口已更新 · 本页草稿';
    $('.local-label').classList.add('storage-warning');
    toast('另一窗口更新了记录，本页不会覆盖它。可先导出本页记录。', '重新载入', () => location.reload());
  });

  if (!remote && !loaded && !lastSavedRaw && !storageFailed) {
    const examples = [
      ['交出那份提案', '把思路说清楚，比把每页填满更重要。', '工作', 'q1'],
      ['留 30 分钟给自己', '读几页书，或者什么也不做。', '生活', 'q2'],
      ['回复待确认的消息', '用简短的答复，让对方可以继续。', '工作', 'q3'],
      ['开始一个小小的想法', '拖我到一个象限，看看会发生什么。', '个人提升', 'prep']
    ];
    const now = Date.now();
    examples.forEach(([title, description, category, zone]) => { const card = board.create({ title, description, category }, now); if (zone !== 'prep') board.move(card.id, zone, now); });
    persist();
  }
  applySettings(); render();
  if (remote) {
    document.querySelector('.page-footer > span:nth-child(2)').textContent = '本机数据库 · 本地开发版';
    await reconnect();
    if (lastSavedRaw) toast('此地址有旧浏览器记录。可在「数据与备份」预览导入，数据库不会自动覆盖它。');
  }
  if (typeof ResizeObserver === 'function') {
    const canvasObserver = new ResizeObserver(layoutCards);
    ZONES.forEach(zone => canvasObserver.observe($('#zone-' + zone)));
  } else window.addEventListener('resize', layoutCards);
  setInterval(updateClocks, 1000);
  if (storageFailed) {
    $('.local-label').textContent = '读取异常 · 原记录已保护';
    $('.local-label').classList.add('storage-warning');
    toast('本地记录读取异常，原始数据未被覆盖。本页暂作临时草稿。');
  }
})();
