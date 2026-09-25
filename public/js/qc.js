// QC dashboard enhancements. Every page works without JS; this adds a live
// weight total in the rubric editor, a live score and "use suggestions" in
// the review form, auto-applied filters and polling for AI reviews.
(function () {
  'use strict';
  var fa = function (n) { return String(n).replace(/\d/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'[d]; }); };

  // Rubric editor: live sum of weights.
  var rubric = document.querySelector('[data-qc-rubric]');
  if (rubric) {
    var sumEl = rubric.querySelector('[data-qc-sum]');
    var updateSum = function () {
      var sum = 0;
      rubric.querySelectorAll('[data-qc-weight]').forEach(function (i) {
        var v = parseInt(String(i.value).replace(/[۰-۹]/g, function (d) { return '۰۱۲۳۴۵۶۷۸۹'.indexOf(d); }), 10);
        if (v > 0) sum += v;
      });
      sumEl.querySelector('b').textContent = fa(sum);
      sumEl.classList.toggle('ok', sum === 100);
      sumEl.classList.toggle('bad', sum !== 100);
    };
    rubric.addEventListener('input', function (e) { if (e.target.matches('[data-qc-weight]')) updateSum(); });
  }

  // Human review: live weighted score and prefill from AI/auto suggestions.
  var reviewForm = document.querySelector('.qc-review-form');
  if (reviewForm) {
    var totalEl = reviewForm.querySelector('[data-qc-total]');
    var pass = Number(totalEl.getAttribute('data-pass')) || 70;
    var selects = reviewForm.querySelectorAll('select[data-weight]');
    var updateTotal = function () {
      var w = 0, acc = 0;
      selects.forEach(function (s) {
        if (s.value === '') return;
        var weight = Number(s.getAttribute('data-weight')) || 0;
        w += weight;
        acc += weight * Number(s.value) / 10;
      });
      if (!w) { totalEl.textContent = '—'; totalEl.className = ''; return; }
      var score = Math.round(acc / w * 100);
      totalEl.textContent = fa(score) + ' از ۱۰۰';
      totalEl.className = score >= pass ? 'qc-good' : (score >= pass - 15 ? 'qc-mid' : 'qc-bad');
    };
    reviewForm.addEventListener('change', updateTotal);
    var fill = document.querySelector('[data-qc-fill]');
    var hasSuggest = Array.prototype.some.call(selects, function (s) { return s.hasAttribute('data-suggest'); });
    if (fill && hasSuggest) {
      fill.classList.remove('hide');
      fill.addEventListener('click', function () {
        selects.forEach(function (s) { if (s.hasAttribute('data-suggest') && s.value === '') s.value = s.getAttribute('data-suggest'); });
        updateTotal();
      });
    }
    updateTotal();
  }

  // Filters apply as soon as they change.
  var filters = document.querySelector('[data-qc-autosubmit]');
  if (filters) {
    filters.addEventListener('change', function () { filters.submit(); });
  }

  // AI review in progress: poll and reload when it finishes.
  var poll = document.querySelector('[data-qc-poll]');
  if (poll) {
    var src = poll.getAttribute('data-qc-poll');
    var tries = 0;
    var tick = function () {
      tries++;
      fetch(src, { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
        if (d.state === 'queued' || d.state === 'running') {
          if (tries < 60) setTimeout(tick, 3000);
          return;
        }
        window.location.replace(window.location.pathname + '#ai');
        window.location.reload();
      }).catch(function () { if (tries < 60) setTimeout(tick, 5000); });
    };
    setTimeout(tick, 2500);
  }
})();
