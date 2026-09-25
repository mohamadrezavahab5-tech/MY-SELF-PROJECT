// Reports page: tooltips for the server-rendered SVG charts. Optional: every
// value is also in the page (labels, legends, table views) without JS.
(function () {
  'use strict';
  var charts = document.querySelectorAll('.viz[data-keys]');
  if (!charts.length) return;

  var tip = document.createElement('div');
  tip.className = 'viz-tip';
  tip.setAttribute('role', 'status');
  tip.setAttribute('aria-live', 'polite');
  tip.hidden = true;
  document.body.appendChild(tip);

  var active = null;

  function parse(el) {
    try { return JSON.parse(el.getAttribute('data-tip')); } catch (e) { return null; }
  }

  // Built with textContent: labels come from user data (FAQ text, etc.).
  function fill(data) {
    tip.textContent = '';
    if (data.t) {
      var t = document.createElement('div');
      t.className = 'viz-tip-t';
      t.textContent = data.t;
      tip.appendChild(t);
    }
    (data.r || []).forEach(function (row) {
      var line = document.createElement('div');
      line.className = 'viz-tip-r';
      if (row[2]) {
        var key = document.createElement('i');
        key.className = 'viz-tip-k';
        key.style.background = row[2];
        line.appendChild(key);
      }
      var v = document.createElement('b');
      v.textContent = row[1];
      var l = document.createElement('span');
      l.textContent = row[0];
      line.appendChild(v);
      line.appendChild(l);
      tip.appendChild(line);
    });
    if (data.f) {
      var f = document.createElement('div');
      f.className = 'viz-tip-f';
      f.textContent = data.f;
      tip.appendChild(f);
    }
  }

  // Beside the pointer, never on top of the hovered mark.
  function place(x, y) {
    var w = tip.offsetWidth;
    var h = tip.offsetHeight;
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var left = x + 18;
    if (left + w > vw - 8) left = x - w - 18;
    if (left < 8) left = Math.max(8, Math.min(vw - w - 8, x - w / 2));
    var top = Math.min(Math.max(8, y - h / 2), vh - h - 8);
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
  }

  function show(el, x, y) {
    if (active !== el) {
      var data = parse(el);
      if (!data) return hide();
      if (active) active.classList.remove('is-active');
      active = el;
      el.classList.add('is-active');
      fill(data);
      tip.hidden = false;
    }
    if (x === undefined) {
      var r = el.getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top + Math.min(r.height / 2, 60);
    }
    place(x, y);
  }

  function hide() {
    if (active) active.classList.remove('is-active');
    active = null;
    tip.hidden = true;
  }

  Array.prototype.forEach.call(charts, function (chart) {
    // The custom tooltip replaces the native <title> fallback.
    Array.prototype.forEach.call(chart.querySelectorAll('[data-tip] > title'), function (t) { t.remove(); });
    var items = chart.querySelectorAll('[data-tip][data-kx]');
    if (!items.length) return;

    // Keyboard: focus the chart, then arrows move between marks. The page is
    // RTL, so ArrowLeft goes forward (later day / later hour).
    chart.tabIndex = 0;
    var map = {};
    var maxX = 0;
    var maxY = 0;
    Array.prototype.forEach.call(items, function (el) {
      var kx = +el.getAttribute('data-kx');
      var ky = +el.getAttribute('data-ky');
      map[kx + ',' + ky] = el;
      maxX = Math.max(maxX, kx);
      maxY = Math.max(maxY, ky);
    });
    var pos = null;
    var pointerFocus = false;
    function go(x, y) {
      x = Math.max(0, Math.min(maxX, x));
      y = Math.max(0, Math.min(maxY, y));
      // Skip gaps (e.g. empty segments of a share bar).
      var el = map[x + ',' + y];
      var step = pos && x < pos.x ? -1 : 1;
      while (!el && x >= 0 && x <= maxX) { x += step; el = map[x + ',' + y]; }
      if (!el) return;
      pos = { x: x, y: y };
      show(el);
    }

    function onPointer(e) {
      var el = e.target.closest && e.target.closest('[data-tip]');
      if (el && chart.contains(el)) {
        show(el, e.clientX, e.clientY);
        if (el.hasAttribute('data-kx')) pos = { x: +el.getAttribute('data-kx'), y: +el.getAttribute('data-ky') };
      } else hide();
    }
    chart.addEventListener('pointermove', onPointer);
    chart.addEventListener('pointerdown', function (e) { pointerFocus = true; onPointer(e); });
    chart.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') hide(); });

    chart.addEventListener('focus', function () {
      // A click or tap already shows the mark under the pointer.
      if (pointerFocus) { pointerFocus = false; return; }
      if (!pos) {
        var last = items[items.length - 1];
        pos = { x: +last.getAttribute('data-kx'), y: +last.getAttribute('data-ky') };
      }
      go(pos.x, pos.y);
    });
    chart.addEventListener('blur', function () { pointerFocus = false; hide(); });
    chart.addEventListener('keydown', function (e) {
      if (!pos) return;
      var k = e.key;
      if (k === 'ArrowLeft') go(pos.x + 1, pos.y);
      else if (k === 'ArrowRight') go(pos.x - 1, pos.y);
      else if (k === 'ArrowUp') go(pos.x, pos.y - 1);
      else if (k === 'ArrowDown') go(pos.x, pos.y + 1);
      else if (k === 'Home') go(0, pos.y);
      else if (k === 'End') go(maxX, pos.y);
      else if (k === 'Escape') { hide(); return; }
      else return;
      e.preventDefault();
    });
  });

  window.addEventListener('scroll', hide, { passive: true });
  document.addEventListener('pointerdown', function (e) {
    if (!e.target.closest || !e.target.closest('.viz[data-keys]')) hide();
  });
})();
