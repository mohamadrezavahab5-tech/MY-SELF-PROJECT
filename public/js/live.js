// Live chat inbox: conversation list + transcript + reply box, kept fresh by
// polling live.json every few seconds. All text goes in via textContent.
(function () {
  'use strict';
  var boot = JSON.parse(document.getElementById('live-boot').textContent);
  var listEl = document.getElementById('live-list');
  var chatEl = document.getElementById('live-chat');
  var state = {
    conversations: boot.conversations,
    conv: boot.conv,
    messages: boot.messages,
    lastId: boot.messages.length ? boot.messages[boot.messages.length - 1].id : 0,
    waiting: 0,
  };
  var baseTitle = document.title;
  var OPERATOR_KEY = 'pasokhyar:operator-name';

  function operatorName() {
    try { return localStorage.getItem(OPERATOR_KEY) || boot.operator; } catch (e) { return boot.operator; }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function post(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  // ---- Conversation list
  function renderList() {
    listEl.textContent = '';
    if (!state.conversations.length) {
      var empty = el('div', 'empty');
      empty.appendChild(el('div', 'big', '💬'));
      empty.appendChild(el('p', '', 'هنوز گفتگویی نیست.'));
      listEl.appendChild(empty);
      return;
    }
    state.conversations.forEach(function (c) {
      var a = el('a', 'live-item' + (state.conv && state.conv.id === c.id ? ' active' : '') + (c.mode === 'human' ? ' human' : ''));
      a.href = '?c=' + c.id;
      a.addEventListener('click', function (e) { e.preventDefault(); select(c.id); });
      var top = el('div', 'live-item-top');
      top.appendChild(el('strong', '', c.name));
      if (c.unread) top.appendChild(el('span', 'badge danger', String(c.unread)));
      else if (c.mode === 'human') top.appendChild(el('span', 'badge warn', 'پشتیبان'));
      a.appendChild(top);
      a.appendChild(el('div', 'live-item-last', (c.lastSender === 'visitor' ? '' : '↩ ') + (c.last || '…')));
      a.appendChild(el('div', 'live-item-meta', c.channel + ' · ' + c.ago));
      listEl.appendChild(a);
    });
  }

  // ---- Transcript
  var SENDER = { visitor: 'مشتری', bot: 'بات', operator: 'پشتیبان', system: '' };

  function bubble(m) {
    var wrap = el('div', 'live-msg ' + m.sender);
    if (m.sender === 'system') {
      wrap.appendChild(el('span', 'live-sys', m.text));
      return wrap;
    }
    var b = el('div', 'live-bubble');
    b.appendChild(el('div', 'live-who', m.sender === 'operator' && m.operator ? m.operator : SENDER[m.sender]));
    var t = el('div', 'live-text', m.text);
    b.appendChild(t);
    (m.sources || []).forEach(function (s) {
      if (!/^https?:\/\//.test(s.url)) return;
      var a = el('a', 'live-source', '🔗 ' + (s.title || s.url));
      a.href = s.url;
      a.target = '_blank';
      a.rel = 'noopener';
      b.appendChild(a);
    });
    b.appendChild(el('div', 'live-at', m.at));
    wrap.appendChild(b);
    return wrap;
  }

  function renderChat() {
    chatEl.textContent = '';
    if (!state.conv) {
      var empty = el('div', 'empty');
      empty.appendChild(el('div', 'big', '💬'));
      empty.appendChild(el('p', '', 'یک گفتگو را از فهرست انتخاب کنید.'));
      chatEl.appendChild(empty);
      return;
    }
    var c = state.conv;
    var head = el('div', 'live-head');
    var who = el('div');
    who.appendChild(el('strong', '', c.name));
    var info = [c.channel];
    if (c.phone) info.push(c.phone);
    who.appendChild(el('div', 'muted live-sub', info.join(' · ')));
    if (c.page && /^https?:\/\//.test(c.page)) {
      var pg = el('a', 'live-sub', 'صفحه: ' + c.page.replace(/^https?:\/\//, '').slice(0, 60));
      pg.href = c.page;
      pg.target = '_blank';
      pg.rel = 'noopener';
      who.appendChild(pg);
    }
    head.appendChild(who);
    var actions = el('div', 'row');
    if (c.mode === 'human') {
      var close = el('button', 'btn btn-ghost btn-sm', 'تحویل به بات');
      close.type = 'button';
      close.addEventListener('click', function () {
        post(boot.endpoint + '/' + c.id + '/close').then(poll);
      });
      actions.appendChild(close);
    } else {
      var take = el('button', 'btn btn-outline btn-sm', 'ورود به گفتگو');
      take.type = 'button';
      take.addEventListener('click', function () {
        post(boot.endpoint + '/' + c.id + '/take').then(poll);
      });
      actions.appendChild(take);
    }
    head.appendChild(actions);
    chatEl.appendChild(head);

    var log = el('div', 'live-log');
    log.id = 'live-log';
    log.setAttribute('role', 'log');
    state.messages.forEach(function (m) { log.appendChild(bubble(m)); });
    chatEl.appendChild(log);

    var formEl = el('form', 'live-reply');
    var nameIn = el('input', 'live-op');
    nameIn.type = 'text';
    nameIn.value = operatorName();
    nameIn.setAttribute('aria-label', 'نام شما (اپراتور)');
    nameIn.title = 'نام شما که به مشتری نشان داده می‌شود';
    nameIn.addEventListener('change', function () {
      try { localStorage.setItem(OPERATOR_KEY, nameIn.value.trim()); } catch (e) { /* ignore */ }
    });
    var ta = el('textarea');
    ta.rows = 2;
    ta.placeholder = c.mode === 'human' ? 'جواب‌تان را بنویسید… (Enter ارسال، Shift+Enter خط جدید)' : 'با نوشتن پیام، وارد گفتگو می‌شوید…';
    ta.setAttribute('aria-label', 'پیام');
    var send = el('button', 'btn btn-primary', 'ارسال');
    formEl.appendChild(nameIn);
    formEl.appendChild(ta);
    formEl.appendChild(send);
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); formEl.requestSubmit(); }
    });
    formEl.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = ta.value.trim();
      if (!text) return;
      send.disabled = true;
      post(boot.endpoint + '/' + c.id + '/reply', { text: text, operator: nameIn.value.trim() }).then(function (r) {
        send.disabled = false;
        if (r && r.ok) {
          ta.value = '';
          if (r.delivered === false) alert('پیام ذخیره شد ولی به پیام‌رسان مشتری نرسید. اتصال ربات را بررسی کنید.');
          poll();
        }
      }).catch(function () { send.disabled = false; });
    });
    chatEl.appendChild(formEl);
    log.scrollTop = log.scrollHeight;
  }

  function select(id) {
    history.replaceState(null, '', '?c=' + id);
    state.conv = state.conversations.filter(function (c) { return c.id === id; })[0] || null;
    state.messages = [];
    state.lastId = 0;
    renderList();
    renderChat();
    poll();
  }

  // ---- Polling
  var timer;
  function poll() {
    clearTimeout(timer);
    var url = boot.endpoint + '.json' + (state.conv ? '?c=' + state.conv.id + '&after=' + state.lastId : '');
    fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      var before = state.waiting;
      state.conversations = d.conversations;
      state.waiting = d.waiting;
      if (d.conv) {
        var modeChanged = !state.conv || state.conv.mode !== d.conv.mode;
        state.conv = d.conv;
        if (modeChanged) {
          state.messages = state.messages.concat(d.messages);
          renderChat();
        } else if (d.messages.length) {
          var log = document.getElementById('live-log');
          var atBottom = log && log.scrollHeight - log.scrollTop - log.clientHeight < 80;
          d.messages.forEach(function (m) {
            state.messages.push(m);
            if (log) log.appendChild(bubble(m));
          });
          if (log && atBottom) log.scrollTop = log.scrollHeight;
        }
        if (d.messages.length) state.lastId = d.messages[d.messages.length - 1].id;
      }
      renderList();
      document.title = (state.waiting ? '(' + state.waiting + ') ' : '') + baseTitle;
      if (state.waiting > before) notify();
    }).catch(function () { /* retry on next tick */ }).then(function () {
      timer = setTimeout(poll, document.hidden ? 10000 : 3000);
    });
  }

  // ---- Browser notifications for new waiting visitors
  function notify() {
    try {
      if (window.Notification && Notification.permission === 'granted' && document.hidden) {
        new Notification('مشتری منتظر پشتیبان است', { body: 'گفتگوی زنده را باز کنید.' });
      }
    } catch (e) { /* ignore */ }
  }
  var nb = document.getElementById('live-notify');
  if (nb) {
    if (!window.Notification) nb.hidden = true;
    nb.addEventListener('click', function () {
      Notification.requestPermission().then(function (p) {
        nb.textContent = p === 'granted' ? '🔔 اعلان فعال است' : '🔕 اعلان رد شد';
      });
    });
  }

  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  renderList();
  renderChat();
  timer = setTimeout(poll, 3000);
})();
