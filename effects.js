/* Dependency-free, original browser effects. The board owns data and original cards.
 * Reference mechanism: pointer-relative perspective and an advancing dissolve edge.
 * No Godot code, shader, texture, or runtime is included here. */
(function () {
  'use strict';

  const MAX_PARTICLES = 60;
  const sessions = new Set();
  const cardSessions = new WeakMap();
  const parkedCards = new WeakMap();
  const bindings = new WeakMap();
  const tilted = new Set();
  let particlesInUse = 0;
  let mode = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'reduced' : 'full';

  const random = (min, max) => min + Math.random() * (max - min);
  const transform = (base, extra) => (base && base !== 'none' ? base + ' ' : '') + extra;

  function resetTilt(record) {
    if (!record) return;
    if (record.frame) cancelAnimationFrame(record.frame);
    record.frame = 0;
    if (record.active) {
      record.target.style.transform = record.originalTransform;
      record.target.style.willChange = record.originalWillChange;
      record.target.style.boxShadow = record.originalShadow;
      record.target.style.transition = record.originalTransition;
    }
    record.highlight?.remove();
    record.highlight = null;
    record.active = false;
    tilted.delete(record);
  }

  function blocked(card) {
    return !card.isConnected || card.closest('[data-no-tilt], [data-dragging="true"], .dragging, .is-dragging')
      || card.getAttribute('aria-grabbed') === 'true';
  }

  function bind(card) {
    if (!card || bindings.has(card)) return;
    const record = { card, target: card.querySelector('.paper') || card, active: false, frame: 0 };
    bindings.set(card, record);

    const followPointer = function (event) {
      if (mode !== 'full' || event.pointerType === 'touch' || event.buttons || blocked(card) || cardSessions.has(card)) {
        resetTilt(record);
        return;
      }
      if (!record.active) {
        Array.from(tilted).forEach(resetTilt);
        record.originalTransform = record.target.style.transform;
        record.originalWillChange = record.target.style.willChange;
        record.originalShadow = record.target.style.boxShadow;
        record.originalTransition = record.target.style.transition;
        record.base = getComputedStyle(record.target).transform;
        record.active = true;
        record.target.style.willChange = 'transform';
        record.target.style.transition = 'transform 85ms ease-out, box-shadow 100ms ease-out';
        const highlight = document.createElement('div');
        highlight.className = 'board-paper-highlight';
        highlight.setAttribute('aria-hidden', 'true');
        highlight.style.cssText = 'position:absolute;inset:0;border-radius:inherit;pointer-events:none;z-index:3;opacity:.75;';
        record.target.appendChild(highlight);
        record.highlight = highlight;
        tilted.add(record);
      }
      record.x = event.clientX;
      record.y = event.clientY;
      if (record.frame) return;
      record.frame = requestAnimationFrame(function () {
        record.frame = 0;
        if (mode !== 'full' || blocked(card)) {
          resetTilt(record);
          return;
        }
        const rect = card.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const x = Math.max(-1, Math.min(1, (record.x - rect.left) / rect.width * 2 - 1));
        const y = Math.max(-1, Math.min(1, (record.y - rect.top) / rect.height * 2 - 1));
        record.target.style.transform = transform(record.base,
          'perspective(480px) rotateX(' + (-y * 9).toFixed(2) + 'deg) rotateY(' + (x * 12).toFixed(2) + 'deg) translateY(-2px) scale(1.045)');
        record.target.style.boxShadow = (-x * 5).toFixed(1) + 'px ' + (9 + y * 3).toFixed(1) + 'px 16px #29251d32, 0 1px 2px #30291f20';
        record.highlight.style.background = 'radial-gradient(ellipse at ' + ((x + 1) * 50).toFixed(1) + '% ' + ((y + 1) * 50).toFixed(1) + '%, #fff9 0%, #fff3 26%, transparent 68%)';
      });
    };
    card.addEventListener('pointerenter', followPointer);
    card.addEventListener('pointermove', followPointer);
    ['pointerleave', 'pointercancel', 'pointerdown', 'dragstart', 'blur'].forEach(function (name) {
      card.addEventListener(name, function () { resetTilt(record); });
    });
  }

  function newSession(card) {
    // A session without a card is independent (for a parked-card transfer).
    if (card) {
      const previous = cardSessions.get(card);
      if (previous) previous.finish();
      resetTilt(bindings.get(card));
    }
    const animations = [];
    const cleanups = [];
    let timer;
    let frame;
    let done = false;
    let resolve;
    const promise = new Promise(function (settle) { resolve = settle; });
    const session = {
      promise,
      cleanup: function (fn) { cleanups.push(fn); },
      animate: function (element, frames, options) {
        if (typeof element.animate !== 'function') return;
        let animation;
        try { animation = element.animate(frames, Object.assign({ fill: 'both' }, options)); }
        catch (_) { return; }
        // Cancelling a WAAPI animation rejects finished. Handle it even if nobody awaits it.
        if (animation.finished) animation.finished.catch(function () {});
        animations.push(animation);
      },
      after: function (milliseconds) { timer = setTimeout(session.finish, milliseconds); },
      run: function (milliseconds, draw) {
        const started = performance.now();
        const tick = function (now) {
          if (done) return;
          try {
            const progress = Math.min(1, Math.max(0, (now - started) / milliseconds));
            draw(progress);
            if (progress < 1) frame = requestAnimationFrame(tick);
            else session.finish();
          } catch (_) { session.finish(); }
        };
        // The timeout also cleans up if the tab stops producing animation frames.
        session.after(milliseconds + 50);
        tick(started);
      },
      finish: function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cancelAnimationFrame(frame);
        animations.forEach(function (animation) { animation.cancel(); });
        cleanups.forEach(function (cleanup) { cleanup(); });
        sessions.delete(session);
        if (card && cardSessions.get(card) === session) cardSessions.delete(card);
        resolve();
      }
    };
    sessions.add(session);
    if (card) cardSessions.set(card, session);
    return session;
  }

  function reserve(session, wanted) {
    const count = Math.min(wanted, MAX_PARTICLES - particlesInUse);
    particlesInUse += count;
    session.cleanup(function () { particlesInUse -= count; });
    return count;
  }

  function layer(session) {
    const element = document.createElement('div');
    element.className = 'board-effect-layer';
    element.setAttribute('aria-hidden', 'true');
    element.inert = true;
    element.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:1000;contain:layout style;';
    document.body.appendChild(element);
    if (session) session.cleanup(function () { element.remove(); });
    return element;
  }

  // Inline the computed styles once so a card looks the same outside its quadrant.
  // Copies are inert decoration, never another task or timer in business queries.
  function snapshot(card, rect) {
    const copy = card.cloneNode(true);
    const sources = [card].concat(Array.from(card.querySelectorAll('*')));
    const copies = [copy].concat(Array.from(copy.querySelectorAll('*')));
    copies.forEach(function (node, index) {
      const sourceStyle = getComputedStyle(sources[index]);
      for (let i = 0; i < sourceStyle.length; i++) {
        const property = sourceStyle[i];
        node.style.setProperty(property, sourceStyle.getPropertyValue(property));
      }
      node.removeAttribute('id');
      node.removeAttribute('autofocus');
      Array.from(node.attributes).forEach(function (attribute) {
        if (attribute.name.startsWith('data-')) node.removeAttribute(attribute.name);
      });
      node.setAttribute('tabindex', '-1');
      node.style.pointerEvents = 'none';
      node.style.animation = 'none';
      node.style.transition = 'none';
    });
    copy.setAttribute('aria-hidden', 'true');
    copy.inert = true;
    Object.assign(copy.style, {
      position: 'absolute', left: '0px', top: '0px', right: 'auto', bottom: 'auto',
      width: rect.width + 'px', height: rect.height + 'px', minWidth: '0', minHeight: '0',
      maxWidth: 'none', maxHeight: 'none', margin: '0', boxSizing: 'border-box',
      transform: 'none', translate: 'none', rotate: 'none', scale: 'none',
      opacity: '1', visibility: 'visible', zIndex: '0'
    });
    return copy;
  }

  function position(element, left, top, width, height) {
    Object.assign(element.style, {
      position: 'absolute', left: left + 'px', top: top + 'px',
      width: width + 'px', height: height + 'px', pointerEvents: 'none'
    });
  }

  function geometry(card, originRect) {
    const bounds = originRect || card.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    const sourceStyle = getComputedStyle(card);
    return {
      centerX: bounds.left + bounds.width / 2,
      centerY: bounds.top + bounds.height / 2,
      transform: originRect?.transform || sourceStyle.transform,
      rect: {
        left: 0, top: 0,
        width: originRect?.layoutWidth || card.offsetWidth || parseFloat(sourceStyle.width) || bounds.width,
        height: originRect?.layoutHeight || card.offsetHeight || parseFloat(sourceStyle.height) || bounds.height
      }
    };
  }

  function stage(viewport, placement) {
    const element = document.createElement('div');
    element.className = 'board-effect-stage';
    const rect = placement.rect;
    // Notes rotate around their centre. Keep that static rotation outside the
    // local animation, using layout dimensions rather than rotating the AABB again.
    position(element, placement.centerX - rect.width / 2,
      placement.centerY - rect.height / 2, rect.width, rect.height);
    element.style.transform = placement.transform;
    element.style.transformOrigin = '50% 50%';
    viewport.appendChild(element);
    return element;
  }

  function hide(element) {
    const visibility = element.style.visibility;
    const priority = element.style.getPropertyPriority('visibility');
    element.style.setProperty('visibility', 'hidden', 'important');
    return function () { element.style.setProperty('visibility', visibility, priority); };
  }

  function park(card, originRect) {
    if (card && parkedCards.has(card)) return parkedCards.get(card);
    let viewport;
    let overlay;
    let placement;
    let restoreSource;
    let restoreTarget;
    let releaseSession;
    let releasePromise;
    let disposed = false;

    const finish = function () {
      if (disposed) return;
      disposed = true;
      viewport?.remove();
      if (restoreSource) restoreSource();
      if (restoreTarget) restoreTarget();
      if (card && parkedCards.get(card) === handle) parkedCards.delete(card);
    };
    const handle = Object.freeze({
      release: function (target) {
        if (releasePromise) return releasePromise;
        if (disposed || !target?.isConnected || !overlay) {
          finish();
          releasePromise = Promise.resolve();
          return releasePromise;
        }
        try {
          const destination = geometry(target);
          if (!destination) {
            finish();
            releasePromise = Promise.resolve();
            return releasePromise;
          }
          if (target !== card) restoreTarget = hide(target);
          if (mode === 'off') {
            finish();
            releasePromise = Promise.resolve();
            return releasePromise;
          }
          // Static parking has no session or idle frame. Only this finite transfer
          // participates in motion cancellation, independently of other card effects.
          releaseSession = newSession();
          releaseSession.cleanup(finish);
          releasePromise = releaseSession.promise;
          const duration = mode === 'reduced' ? 110 : 280;
          const dx = destination.centerX - placement.centerX;
          const dy = destination.centerY - placement.centerY;
          const destinationTransform = 'translate(' + dx + 'px, ' + dy + 'px) '
            + transform(destination.transform, 'scale(' + destination.rect.width / placement.rect.width
              + ', ' + destination.rect.height / placement.rect.height + ')');
          releaseSession.animate(overlay, mode === 'reduced' ? [{ opacity: 1 }, { opacity: 0 }] : [
            { transform: placement.transform, opacity: 1 },
            { transform: destinationTransform, opacity: 1 }
          ], { duration, easing: 'cubic-bezier(.22,.61,.36,1)' });
          releaseSession.after(duration);
        } catch (error) {
          if (releaseSession) releaseSession.finish();
          else finish();
          releasePromise = releasePromise || Promise.resolve();
          console.warn('BoardEffects: parked-card transfer skipped.', error);
        }
        return releasePromise;
      },
      dispose: function () {
        if (releaseSession) releaseSession.finish();
        else finish();
      }
    });

    try {
      if (!card) return handle;
      const previous = cardSessions.get(card);
      if (previous) previous.finish();
      resetTilt(bindings.get(card));
      placement = geometry(card, originRect);
      if (!placement) return handle;
      const copy = snapshot(card, placement.rect);
      viewport = layer();
      overlay = stage(viewport, placement);
      overlay.appendChild(copy);
      restoreSource = hide(card);
      parkedCards.set(card, handle);
    } catch (error) {
      finish();
      console.warn('BoardEffects: parked-card snapshot skipped.', error);
    }
    return handle;
  }

  function simpleExit(session, overlay, copy, rect, kind, reduced) {
    position(copy, rect.left, rect.top, rect.width, rect.height);
    overlay.appendChild(copy);
    const duration = reduced ? 110 : 280;
    session.animate(copy, reduced ? [{ opacity: 1 }, { opacity: 0 }] : [
      { opacity: 1, transform: 'translate(0, 0) scale(1)' },
      { opacity: 0, transform: kind === 'adjusted' ? 'translate(-36px, 18px) scale(.94)' : 'translateY(-12px) scale(.96)' }
    ], { duration, easing: 'cubic-bezier(.22,.61,.36,1)' });
    session.after(duration);
  }

  function completed(session, overlay, copy, rect) {
    position(copy, rect.left, rect.top, rect.width, rect.height);
    overlay.appendChild(copy);
    session.animate(copy, [
      { transform: 'translateX(0) rotate(0deg) scale(1)', opacity: 1, offset: 0 },
      { transform: 'translateX(-3px) rotate(-3deg) scale(1)', opacity: 1, offset: .1 },
      { transform: 'translateX(3px) rotate(3deg) scale(1)', opacity: 1, offset: .2 },
      { transform: 'translateX(-2px) rotate(-2deg) scale(1)', opacity: 1, offset: .3 },
      { transform: 'translateX(1px) rotate(1deg) scale(1)', opacity: 1, offset: .4 },
      { transform: 'translateX(0) rotate(0deg) scale(1)', opacity: 1, offset: .48,
        easing: 'cubic-bezier(.4,0,.6,1)' },
      { transform: 'translateX(0) rotate(0deg) scale(0)', opacity: 0, offset: 1 }
    ], { duration: 500, easing: 'linear' });
    session.after(500);
  }

  function burn(session, overlay, copy, rect, kind) {
    const isVoid = kind === 'cancelled';
    const duration = isVoid ? 780 : 650;
    const pad = 45;
    const canvas = document.createElement('canvas');
    let context;
    try { context = canvas.getContext('2d'); } catch (_) {}
    if (!context) {
      simpleExit(session, overlay, copy, rect, kind, false);
      return;
    }

    // A small canvas paints only the rim and dust. Text stays in the DOM clone;
    // a matching polygon clips it without screenshots, pixel reads, or textures.
    const ratio = Math.min(1.5, window.devicePixelRatio || 1);
    canvas.width = Math.ceil((rect.width + pad * 2) * ratio);
    canvas.height = Math.ceil((rect.height + pad * 2) * ratio);
    position(canvas, rect.left - pad, rect.top - pad, rect.width + pad * 2, rect.height + pad * 2);
    canvas.style.zIndex = '1';
    position(copy, rect.left, rect.top, rect.width, rect.height);
    copy.style.willChange = 'clip-path, opacity';
    overlay.appendChild(copy);
    overlay.appendChild(canvas);

    const vertices = [];
    const samples = 12;
    for (let edge = 0; edge < 4; edge++) {
      for (let i = 0; i < samples; i++) {
        const u = i / samples;
        const x = edge === 0 ? u : edge === 1 ? 1 : edge === 2 ? 1 - u : 0;
        const y = edge === 0 ? 0 : edge === 1 ? u : edge === 2 ? 1 : 1 - u;
        vertices.push({ x, y, edge, roughness: random(.25, 1), phase: random(0, Math.PI * 2) });
      }
    }

    const pointAt = function (vertex, progress) {
      const shrink = Math.max(0, 1 - Math.pow(progress, .94) * 1.025);
      const roughness = Math.sin(Math.PI * progress) * Math.min(4, rect.height * .055)
        * vertex.roughness * (1 + Math.sin(vertex.phase + progress * 2) * .3);
      const x = rect.width / 2 + (vertex.x - .5) * rect.width * shrink;
      const y = rect.height / 2 + (vertex.y - .5) * rect.height * shrink;
      return {
        x: x + (vertex.edge === 1 ? -roughness : vertex.edge === 3 ? roughness : 0),
        y: y + (vertex.edge === 0 ? roughness : vertex.edge === 2 ? -roughness : 0)
      };
    };
    const count = reserve(session, isVoid ? 28 : 18);
    const motes = Array.from({ length: count }, function (_, index) {
      const born = random(.06, .68);
      const point = pointAt(vertices[Math.floor(index / Math.max(1, count) * vertices.length)], born);
      return {
        x: point.x, y: point.y, born, life: random(.2, .36),
        dx: random(-23, 23), dy: random(-43, -14), size: random(1.1, 2.7),
        turn: random(-2, 2),
        color: isVoid ? ['#564638', '#aa8d6b', '#cc843d', '#6b5a46'][index % 4]
          : ['#bd7e31', '#dda350', '#d4ad70'][index % 3]
      };
    });
    canvas.dataset.particles = String(count);

    session.run(duration, function (progress) {
      const points = vertices.map(function (vertex) { return pointAt(vertex, progress); });
      copy.style.clipPath = 'polygon(' + points.map(function (point) {
        return point.x.toFixed(2) + 'px ' + point.y.toFixed(2) + 'px';
      }).join(',') + ')';
      copy.style.opacity = String(1 - Math.max(0, (progress - .78) / .22));

      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.setTransform(ratio, 0, 0, ratio, pad * ratio, pad * ratio);
      const rimOpacity = Math.min(1, progress / .1) * Math.min(1, (1 - progress) / .14);
      context.beginPath();
      points.forEach(function (point, index) {
        if (index) context.lineTo(point.x, point.y);
        else context.moveTo(point.x, point.y);
      });
      context.closePath();
      context.lineJoin = 'round';
      context.globalAlpha = rimOpacity * .3;
      context.lineWidth = isVoid ? 9 : 7;
      context.strokeStyle = isVoid ? '#5e402b' : '#bd792f';
      context.stroke();
      context.globalAlpha = rimOpacity * .9;
      context.lineWidth = isVoid ? 4 : 3;
      context.strokeStyle = isVoid ? '#382e25' : '#9b6028';
      context.stroke();
      context.globalAlpha = rimOpacity * .8;
      context.lineWidth = 1.3;
      context.strokeStyle = isVoid ? '#d18a3c' : '#efbe70';
      context.stroke();

      motes.forEach(function (mote) {
        const age = (progress - mote.born) / mote.life;
        if (age <= 0 || age >= 1) return;
        context.save();
        context.globalAlpha = Math.sin(age * Math.PI) * .75;
        context.fillStyle = mote.color;
        context.translate(mote.x + mote.dx * age, mote.y + mote.dy * age);
        context.rotate(mote.turn * age);
        const size = mote.size * (1 - age * .6);
        context.fillRect(-size / 2, -size / 2, size, size * .7);
        context.restore();
      });
      context.globalAlpha = 1;
    });
  }

  function enter(card) {
    if (!card || mode === 'off') return Promise.resolve();
    const session = newSession(card);
    const paper = card.querySelector('.paper') || card;
    if (mode === 'reduced') {
      session.animate(paper, [{ opacity: 0 }, { opacity: 1 }], { duration: 110 });
      session.after(110);
      return session.promise;
    }
    const base = getComputedStyle(paper).transform;
    session.animate(paper, [
      { transform: transform(base, 'scale(.86) rotate(-3deg)'), opacity: 0, offset: 0 },
      { transform: transform(base, 'scale(1.035) rotate(1.7deg)'), opacity: 1, offset: .5 },
      { transform: transform(base, 'scale(.99) rotate(-.6deg)'), opacity: 1, offset: .76 },
      { transform: transform(base, 'scale(1) rotate(0deg)'), opacity: 1, offset: 1 }
    ], { duration: 390, easing: 'cubic-bezier(.2,.65,.35,1)' });
    session.after(390);
    return session.promise;
  }

  function exit(card, kind, originRect) {
    if (!card) return Promise.resolve();
    const previous = cardSessions.get(card);
    if (previous) previous.finish();
    resetTilt(bindings.get(card));
    if (mode === 'off') return Promise.resolve();
    const session = newSession(card);
    try {
      const placement = geometry(card, originRect);
      if (!placement) {
        session.finish();
        return session.promise;
      }
      const rect = placement.rect;
      const copy = snapshot(card, rect);
      const viewport = layer(session);
      const overlay = stage(viewport, placement);
      session.cleanup(hide(card));
      if (mode === 'reduced') simpleExit(session, overlay, copy, rect, kind, true);
      else if (kind === 'completed') completed(session, overlay, copy, rect);
      else if (kind === 'cancelled') burn(session, overlay, copy, rect, kind);
      else simpleExit(session, overlay, copy, rect, 'adjusted', false);
    } catch (error) {
      // Decorative feedback must never prevent the board from committing an action.
      session.finish();
      console.warn('BoardEffects: animation skipped.', error);
    }
    return session.promise;
  }

  function setMode(nextMode) {
    if (!['full', 'reduced', 'off'].includes(nextMode)) return mode;
    mode = nextMode;
    Array.from(sessions).forEach(function (session) { session.finish(); });
    Array.from(tilted).forEach(resetTilt);
    return mode;
  }

  window.addEventListener('blur', function () { Array.from(tilted).forEach(resetTilt); });
  window.BoardEffects = Object.freeze({ setMode, bind, enter, exit, park });
})();
