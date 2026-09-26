// Dashboard progressive enhancements. Everything works without JS except
// file import and the test console.
(function () {
  'use strict';

  // Confirm destructive actions.
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-confirm]');
    if (el && !window.confirm(el.getAttribute('data-confirm'))) e.preventDefault();
  });

  // Copy-to-clipboard buttons.
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy]');
    if (!btn) return;
    var src = document.querySelector(btn.getAttribute('data-copy'));
    if (!src) return;
    var text = 'value' in src ? src.value : src.textContent;
    var done = function () {
      var old = btn.textContent;
      btn.textContent = 'کپی شد ✓';
      setTimeout(function () { btn.textContent = old; }, 1600);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (err) { /* ignore */ }
      ta.remove();
    }
  });

  // Excel / CSV import: upload the raw file.
  var fileInput = document.getElementById('import-file');
  if (fileInput) {
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      var status = document.getElementById('import-status');
      if (!file) return;
      status.textContent = 'در حال ورود…';
      fetch(fileInput.getAttribute('data-upload') + '?name=' + encodeURIComponent(file.name), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
        credentials: 'same-origin',
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (d.ok) window.location.href = d.redirect;
        else status.textContent = d.error || 'خطا در ورود فایل';
      }).catch(function () { status.textContent = 'خطا در ارسال فایل'; });
    });
  }

  // Test console.
  var consoleEl = document.getElementById('test-console');
  if (consoleEl) {
    var log = document.getElementById('test-log');
    var form = document.getElementById('test-form');
    var input = document.getElementById('test-q');
    var endpoint = consoleEl.getAttribute('data-endpoint');
    var fa = function (n) { return String(n).replace(/\d/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[d]; }); };
    var LABEL = { answer: 'جواب مستقیم', suggest: 'پیشنهاد سؤال‌های نزدیک', fallback: 'جواب را پیدا نکرد', limit: 'سقف مصرف' };

    var add = function (cls, text) {
      var b = document.createElement('div');
      b.className = 'bubble ' + cls;
      b.style.whiteSpace = 'pre-line';
      b.textContent = text;
      log.appendChild(b);
      log.scrollTop = log.scrollHeight;
      return b;
    };

    var ask = function (q) {
      add('user', q);
      fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ q: q }),
      }).then(function (r) { return r.json(); }).then(function (d) {
        var b = add('bot', d.reply.answer);
        if (d.reply.suggestions && d.reply.suggestions.length) {
          var chips = document.createElement('div');
          chips.className = 'chips';
          chips.style.marginTop = '8px';
          d.reply.suggestions.forEach(function (s) {
            var c = document.createElement('button');
            c.type = 'button';
            c.className = 'chip';
            c.textContent = s.question;
            c.addEventListener('click', function () { ask(s.question); });
            chips.appendChild(c);
          });
          b.appendChild(chips);
        }
        var meta = document.createElement('div');
        meta.className = 'test-meta';
        meta.textContent = 'نتیجه: ' + (LABEL[d.reply.type] || d.reply.type) +
          (d.top.length ? ' · نزدیک‌ترین‌ها: ' + d.top.map(function (t) { return '«' + t.question + '» ' + fa(t.score) + '٪'; }).join('، ') : '');
        b.appendChild(meta);
      }).catch(function () { add('bot', 'خطا در ارتباط با سرور'); });
    };

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      input.value = '';
      ask(q);
    });
  }
})();
