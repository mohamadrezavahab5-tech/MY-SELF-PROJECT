// Admin settings (/admin/settings) progressive enhancements. Every form also
// works without JS; this adds live counters, previews, FAQ row reordering and
// the AI "test connection" button without a page reload.
(function () {
  'use strict';

  var FA = '۰۱۲۳۴۵۶۷۸۹';
  function fa(n) { return String(n).replace(/\d/g, function (d) { return FA[d]; }); }
  function en(s) {
    return String(s || '').replace(/[۰-۹]/g, function (d) { return String(d.charCodeAt(0) - 0x06f0); })
      .replace(/[٠-٩]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); });
  }
  function money(n) { return fa(Number(n).toLocaleString('en-US')).replace(/,/g, '٬'); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  // Phones: bring the current tab into view in the scrolling tab strip.
  var activeTab = document.querySelector('.settings-tabs .active');
  if (activeTab) {
    var strip = activeTab.parentNode;
    if (strip.scrollWidth > strip.clientWidth) {
      var a = activeTab.getBoundingClientRect();
      var b = strip.getBoundingClientRect();
      strip.scrollLeft += (a.left + a.width / 2) - (b.left + b.width / 2);
    }
  }

  // Character counters: <input data-count="160"> + <span data-count-for="id">.
  document.querySelectorAll('[data-count]').forEach(function (el) {
    var out = document.querySelector('[data-count-for="' + el.id + '"]');
    if (!out) return;
    var ideal = Number(el.getAttribute('data-count'));
    var update = function () {
      var n = el.value.trim().length;
      out.textContent = fa(n) + ' نویسه' + (ideal ? ' · پیشنهاد: تا ' + fa(ideal) : '');
      out.classList.toggle('over', ideal > 0 && n > ideal);
      out.classList.toggle('good', ideal >= 120 && n >= Math.round(ideal * 0.75) && n <= ideal);
    };
    el.addEventListener('input', update);
    update();
  });

  // Toman preview under price inputs.
  document.querySelectorAll('[data-money]').forEach(function (el) {
    var out = document.getElementById(el.getAttribute('data-money'));
    if (!out) return;
    el.addEventListener('input', function () {
      var v = en(el.value).replace(/[,٬\s]/g, '');
      out.textContent = /^\d+$/.test(v) ? '= ' + money(v) + ' تومان' : '';
    });
  });

  // Hero title preview: *text* -> gradient.
  var heroInput = document.getElementById('f-home-heroTitle');
  var heroPreview = document.querySelector('[data-hero-preview]');
  if (heroInput && heroPreview) {
    heroInput.addEventListener('input', function () {
      heroPreview.innerHTML = esc(heroInput.value).replace(/\*([^*\n]+)\*/g, '<span class="grad">$1</span>').replace(/\*/g, '');
    });
  }

  // Blog slug placeholder follows the title (the server makes the same slug).
  var slugSource = document.querySelector('[data-slug-source]');
  var slugTarget = document.querySelector('[data-slug-target]');
  if (slugSource && slugTarget && !slugTarget.readOnly) {
    var slugify = function (s) {
      return en(s).toLowerCase()
        .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/ۀ/g, 'ه').replace(/[أإ]/g, 'ا')
        .replace(/[ً-ٰٟ]/g, '')
        .replace(/[\s‌‍‎‏_]+/g, '-')
        .replace(/[^a-z0-9ء-غف-يپچژکگی-]/g, '')
        .replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 90).replace(/-$/, '');
    };
    slugSource.addEventListener('input', function () { slugTarget.placeholder = slugify(slugSource.value); });
  }

  // Site FAQ editor: add / move / delete rows.
  var editor = document.getElementById('faq-editor');
  if (editor) {
    var list = editor.querySelector('[data-rows]');
    var countField = editor.querySelector('[data-count-field]');
    var tpl = document.getElementById('faq-row-tpl');
    var renumber = function () {
      var n = 1;
      list.querySelectorAll('[data-row]').forEach(function (row) {
        var pos = row.querySelector('[data-pos]');
        if (pos) pos.value = n++;
      });
    };
    editor.addEventListener('click', function (e) {
      var move = e.target.closest('[data-move]');
      if (move) {
        var row = move.closest('[data-row]');
        if (move.getAttribute('data-move') === 'up' && row.previousElementSibling) list.insertBefore(row, row.previousElementSibling);
        if (move.getAttribute('data-move') === 'down' && row.nextElementSibling) list.insertBefore(row.nextElementSibling, row);
        renumber();
        move.focus();
        return;
      }
      if (e.target.closest('[data-faq-add]')) {
        var i = Number(countField.value);
        var holder = document.createElement('div');
        holder.innerHTML = tpl.innerHTML.replace(/__i__/g, String(i));
        var newRow = holder.firstElementChild;
        list.appendChild(newRow);
        countField.value = String(i + 1);
        renumber();
        var q = newRow.querySelector('input[type=text]:not([data-pos])');
        if (q) q.focus();
      }
    });
    editor.addEventListener('change', function (e) {
      if (e.target.matches('[data-del]')) e.target.closest('[data-row]').classList.toggle('removed', e.target.checked);
    });
    // Positions are managed by the arrows when JS is on.
    editor.querySelectorAll('.pos-label').forEach(function (l) { l.classList.add('js-hidden'); });
    renumber();
  }

  // AI: test the connection in place.
  var testBtn = document.querySelector('[data-ai-test]');
  if (testBtn) {
    testBtn.addEventListener('click', function (e) {
      e.preventDefault();
      var formEl = testBtn.form;
      var out = document.getElementById('ai-test-result');
      var body = new URLSearchParams(new FormData(formEl));
      var label = testBtn.textContent;
      testBtn.disabled = true;
      testBtn.textContent = 'در حال آزمایش…';
      out.innerHTML = '';
      fetch(testBtn.getAttribute('formaction'), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        credentials: 'same-origin',
        body: body.toString(),
      }).then(function (r) { return r.json(); }).then(function (t) {
        var html = '<div class="' + (t.ok ? 'success' : 'error') + ' ai-test-box"><strong>' + (t.ok ? '✓ ' : '✗ ') + esc(t.message) + '</strong>';
        if (t.reply) html += '<div class="hint">جواب مدل: «' + esc(t.reply) + '»</div>';
        if (t.models && t.models.length) html += '<div class="hint">مدل‌های موجود روی سرور: <span class="ltr">' + esc(t.models.slice(0, 20).join('، ')) + '</span></div>';
        out.innerHTML = html + '</div>';
      }).catch(function () {
        out.innerHTML = '<div class="error ai-test-box">خطا در ارتباط با سرور سایت.</div>';
      }).then(function () {
        testBtn.disabled = false;
        testBtn.textContent = label;
      });
    });
  }
})();
