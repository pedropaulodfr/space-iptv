/* Painel ao vivo — EventSource + fallback de polling. Sem dependências. */
(function () {
  'use strict';

  var STATUS = {
    idle: { label: 'Ocioso', graph: 'ocioso' },
    working: { label: 'Trabalhando', graph: 'trabalhando' },
    blocked: { label: 'Bloqueado', graph: 'bloqueado' },
    done: { label: 'Concluído', graph: 'concluído' },
    error: { label: 'Erro', graph: 'erro' }
  };

  var els = {
    phase: document.getElementById('phase'),
    totalTime: document.getElementById('totalTime'),
    countWorking: document.getElementById('countWorking'),
    countBlocked: document.getElementById('countBlocked'),
    countDone: document.getElementById('countDone'),
    agentCount: document.getElementById('agentCount'),
    cards: document.getElementById('cards'),
    graph: document.getElementById('graph'),
    timeline: document.getElementById('timeline'),
    eventCount: document.getElementById('eventCount'),
    conn: document.getElementById('conn'),
    connText: document.getElementById('connText'),
    lastUpdate: document.getElementById('lastUpdate'),
    live: document.getElementById('live')
  };

  var state = {
    agents: [],
    events: [],
    lastSnapshot: 0,
    loaded: false
  };
  var cardRefs = new Map();
  var nodeRefs = new Map();
  var lastLiveKey = '';
  var clock = null;
  var es = null;
  var pollTimer = null;
  var polling = false;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function statusKey(value) {
    return Object.prototype.hasOwnProperty.call(STATUS, value) ? value : 'idle';
  }

  function statusLabel(value) {
    return STATUS[statusKey(value)].label;
  }

  function clockTime(ts) {
    var d = new Date(ts || Date.now());
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  function duration(ms) {
    var s = Math.max(0, Math.floor((ms || 0) / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + pad(s % 60) + 's';
    var h = Math.floor(m / 60);
    return h + 'h ' + pad(m % 60) + 'm';
  }

  function ago(ms) {
    var s = Math.max(0, Math.floor((ms || 0) / 1000));
    if (s < 1) return 'agora';
    if (s < 60) return 'há ' + s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return 'há ' + m + 'min';
    var h = Math.floor(m / 60);
    return 'há ' + h + 'h' + (m % 60 ? ' ' + (m % 60) + 'min' : '');
  }

  function isStale(agent, now) {
    return agent.status === 'working' && now - (agent.updatedAt || 0) > 30000;
  }

  function shortName(name) {
    var s = String(name || '');
    if (s.indexOf('demo-') === 0) s = s.slice(5);
    return s.length > 15 ? s.slice(0, 14) + '…' : s;
  }

  /* ---------- header ---------- */
  function renderHeader() {
    var counts = { working: 0, blocked: 0, done: 0 };
    state.agents.forEach(function (a) {
      if (a.status === 'working') counts.working++;
      else if (a.status === 'blocked') counts.blocked++;
      else if (a.status === 'done') counts.done++;
    });
    els.countWorking.textContent = counts.working;
    els.countBlocked.textContent = counts.blocked;
    els.countDone.textContent = counts.done;

    var n = state.agents.length;
    els.agentCount.textContent = n + (n === 1 ? ' agente' : ' agentes');

    var withPhase = state.agents.filter(function (a) { return a.phase; });
    var orq = withPhase.filter(function (a) { return /orquestrador/i.test(a.agent); })[0];
    var pick = orq || withPhase.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); })[0];
    els.phase.textContent = pick ? pick.phase : '—';

    updateTotalTime();
  }

  function updateTotalTime() {
    var starts = state.agents
      .map(function (a) { return a.startedAt || 0; })
      .filter(function (t) { return t > 0; });
    if (!starts.length) {
      els.totalTime.textContent = '—';
      return;
    }
    els.totalTime.textContent = duration(Date.now() - Math.min.apply(null, starts));
  }

  /* ---------- cards ---------- */
  function buildCard(agent) {
    var st = statusKey(agent.status);
    var card = el('article', 'agent-card status-' + st);
    card.setAttribute('role', 'listitem');
    card.setAttribute('aria-label',
      agent.agent + ', ' + statusLabel(agent.status) + ', ' + (agent.progress || 0) + ' por cento, ' +
      (agent.task || 'sem tarefa'));

    var head = el('div', 'card-head');
    var ident = el('div', 'card-ident');
    var nameEl = el('h3', 'agent-name', agent.agent);
    nameEl.title = agent.agent;
    ident.appendChild(nameEl);
    ident.appendChild(el('p', 'agent-role', agent.role || agent.agent));
    var pill = el('span', 'pill status-' + st);
    pill.appendChild(el('span', 'dot'));
    pill.appendChild(document.createTextNode(statusLabel(agent.status)));
    head.appendChild(ident);
    head.appendChild(pill);

    var meta = el('div', 'card-meta');
    if (agent.phase) meta.appendChild(el('span', 'phase-chip', agent.phase));
    var note = agent.note ? el('p', 'note', agent.note) : null;

    var task = el('p', 'card-task', agent.task || '—');

    var progressRow = el('div', 'progress-row');
    var bar = el('div', 'bar');
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    bar.setAttribute('aria-valuenow', String(agent.progress || 0));
    bar.setAttribute('aria-label', 'Progresso de ' + agent.agent);
    var fill = el('span', 'fill');
    fill.style.width = Math.max(0, Math.min(100, agent.progress || 0)) + '%';
    bar.appendChild(fill);
    progressRow.appendChild(bar);
    progressRow.appendChild(el('span', 'progress-label', (agent.progress || 0) + '%'));

    var files = el('div', 'files');
    var list = Array.isArray(agent.files) ? agent.files : [];
    if (!list.length) {
      files.appendChild(el('span', 'file-chip', 'sem arquivos atribuídos'));
    } else {
      list.slice(0, 5).forEach(function (file) {
        var chip = el('span', 'file-chip', file);
        chip.title = file;
        files.appendChild(chip);
      });
      if (list.length > 5) {
        var more = el('span', 'file-chip more', '+' + (list.length - 5));
        more.title = list.slice(5).join('\n');
        files.appendChild(more);
      }
    }

    var foot = el('div', 'card-foot');
    var since = el('span');
    since.setAttribute('data-since', '');
    var right = el('span', 'foot-right');
    var updated = el('span');
    updated.setAttribute('data-updated', '');
    var badge = el('span', 'stale-badge', 'sem sinal');
    badge.hidden = true;
    right.appendChild(updated);
    right.appendChild(badge);
    foot.appendChild(since);
    foot.appendChild(right);

    card.appendChild(head);
    card.appendChild(meta);
    card.appendChild(task);
    if (note) card.appendChild(note);
    card.appendChild(progressRow);
    card.appendChild(files);
    card.appendChild(foot);

    cardRefs.set(agent.agent, {
      card: card,
      since: since,
      updated: updated,
      badge: badge
    });
    updateCardTimes(agent, cardRefs.get(agent.agent), Date.now());
    return card;
  }

  function renderCards() {
    clear(els.cards);
    cardRefs.clear();
    if (!state.agents.length) {
      var empty = el('div', 'empty');
      empty.appendChild(el('strong', null, 'Aguardando o primeiro reporte.'));
      empty.appendChild(el('span', null, 'Cada agente grava o próprio estado com:'));
      var code = el('code', null, 'node tools/agents-live/report.js --agent NOME --status working --task "..."');
      empty.appendChild(code);
      els.cards.appendChild(empty);
      return;
    }
    var frag = document.createDocumentFragment();
    state.agents.forEach(function (agent) { frag.appendChild(buildCard(agent)); });
    els.cards.appendChild(frag);
  }

  function updateCardTimes(agent, ref, now) {
    if (!ref) return;
    var since = agent.stateSince || agent.startedAt || now;
    ref.since.textContent = 'no estado há ' + duration(now - since);
    var stale = isStale(agent, now);
    if (stale) {
      ref.updated.hidden = true;
      ref.badge.hidden = false;
      ref.badge.textContent = 'sem sinal ' + ago(now - (agent.updatedAt || now));
      ref.card.classList.add('stale');
    } else {
      ref.updated.hidden = false;
      ref.updated.textContent = 'atualizado ' + ago(now - (agent.updatedAt || now));
      ref.badge.hidden = true;
      ref.card.classList.remove('stale');
    }
  }

  /* ---------- grafo SVG ---------- */
  var SVG_NS = 'http://www.w3.org/2000/svg';

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        node.setAttribute(key, attrs[key]);
      });
    }
    return node;
  }

  function renderGraph() {
    clear(els.graph);
    nodeRefs.clear();
    if (!state.agents.length) {
      els.graph.appendChild(el('p', 'graph-empty', 'sem agentes reportando'));
      return;
    }

    var center = state.agents.filter(function (a) { return a.agent === 'orquestrador'; })[0] ||
      state.agents.filter(function (a) { return /orquestrador/i.test(a.agent); })[0] || null;
    var others = state.agents.filter(function (a) { return a !== center; });

    var cx = 210;
    var cy = 160;
    var rx = 152;
    var ry = 112;
    var svg = svgEl('svg', {
      viewBox: '0 0 420 360',
      role: 'img',
      preserveAspectRatio: 'xMidYMid meet'
    });
    svg.setAttribute('aria-label', 'Grafo de agentes: ' + state.agents.map(function (a) {
      return a.agent + ' ' + statusLabel(a.status).toLowerCase();
    }).join('; '));

    var positions = others.map(function (agent, i) {
      var angle = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, others.length);
      return { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry, agent: agent };
    });

    positions.forEach(function (p) {
      var st = statusKey(p.agent.status);
      var edge = svgEl('line', {
        x1: cx, y1: cy, x2: p.x, y2: p.y,
        class: 'edge status-' + st
      });
      svg.appendChild(edge);
    });

    function addNode(agent, x, y, isCenter) {
      var st = statusKey(agent.status);
      var group = svgEl('g', { class: 'node status-' + st + (isCenter ? ' center' : '') });
      group.setAttribute('data-agent', agent.agent);
      var title = svgEl('title');
      title.textContent = agent.agent + ' — ' + statusLabel(agent.status) + ' — ' +
        (agent.phase || 'sem fase') + ' — ' + (agent.task || 'sem tarefa') +
        (agent.note ? ' — ' + agent.note : '');
      group.appendChild(title);

      if (st === 'working') {
        group.appendChild(svgEl('circle', { class: 'halo', cx: x, cy: y, r: isCenter ? 42 : 23 }));
      }
      group.appendChild(svgEl('circle', { class: 'main', cx: x, cy: y, r: isCenter ? 30 : 16 }));
      group.appendChild(svgEl('circle', { class: 'core', cx: x, cy: y, r: isCenter ? 7 : 5 }));
      var name = svgEl('text', {
        x: x, y: y + (isCenter ? 48 : 30),
        'text-anchor': 'middle',
        class: 'node-name'
      });
      name.textContent = isCenter ? 'orquestrador' : shortName(agent.agent);
      group.appendChild(name);
      var sub = svgEl('text', {
        x: x, y: y + (isCenter ? 63 : 44),
        'text-anchor': 'middle',
        class: 'node-sub'
      });
      sub.textContent = STATUS[st].graph;
      group.appendChild(sub);
      svg.appendChild(group);
      return group;
    }

    if (center) {
      var centerGroup = addNode(center, cx, cy, true);
      nodeRefs.set(center.agent, { group: centerGroup });
    } else {
      var ghost = {
        agent: 'orquestrador',
        status: 'idle',
        phase: '',
        task: 'sem reporte',
        note: '',
        updatedAt: 0
      };
      var ghostGroup = addNode(ghost, cx, cy, true);
      nodeRefs.set('orquestrador', { group: ghostGroup });
    }

    positions.forEach(function (p) {
      var group = addNode(p.agent, p.x, p.y, false);
      nodeRefs.set(p.agent.agent, { group: group });
    });

    els.graph.appendChild(svg);
  }

  function updateGraphStale(now) {
    state.agents.forEach(function (agent) {
      var ref = nodeRefs.get(agent.agent);
      if (!ref) return;
      ref.group.classList.toggle('stale', isStale(agent, now));
    });
  }

  /* ---------- timeline ---------- */
  function renderTimeline() {
    clear(els.timeline);
    els.eventCount.textContent = state.events.length + (state.events.length === 1 ? ' evento' : ' eventos');
    if (!state.events.length) {
      els.timeline.appendChild(el('li', 'tl-empty', 'Nenhum evento registrado ainda.'));
      return;
    }
    var frag = document.createDocumentFragment();
    state.events.slice(0, 40).forEach(function (ev) {
      var st = statusKey(ev.status);
      var li = el('li', 'tl-item status-' + st);
      li.appendChild(el('span', 'tl-time', clockTime(ev.ts)));
      var main = el('div', 'tl-main');
      var line = el('div', 'tl-line');
      line.appendChild(el('span', 'tl-agent', ev.agent || '—'));
      line.appendChild(el('span', 'tl-status status-' + st, statusLabel(ev.status)));
      main.appendChild(line);
      if (ev.task) main.appendChild(el('p', 'tl-task', ev.task));
      if (ev.note) main.appendChild(el('p', 'tl-note', ev.note));
      li.appendChild(main);
      frag.appendChild(li);
    });
    els.timeline.appendChild(frag);
  }

  /* ---------- aria-live ---------- */
  function announce() {
    var counts = { working: 0, blocked: 0, done: 0 };
    state.agents.forEach(function (a) {
      if (a.status === 'working') counts.working++;
      else if (a.status === 'blocked') counts.blocked++;
      else if (a.status === 'done') counts.done++;
    });
    var latest = state.events[0];
    var key = counts.working + '/' + counts.blocked + '/' + counts.done + '#' +
      (latest ? latest.ts + latest.agent + latest.status + latest.task : '');
    if (key === lastLiveKey) return;
    lastLiveKey = key;
    var text = counts.working + ' trabalhando, ' + counts.blocked + ' bloqueado(s), ' +
      counts.done + ' concluído(s).';
    if (latest) {
      text += ' Último evento: ' + latest.agent + ' ' + statusLabel(latest.status).toLowerCase() +
        (latest.task ? ', ' + latest.task : '') + '.';
    }
    els.live.textContent = text;
  }

  /* ---------- snapshot ---------- */
  function apply(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.agents)) return;
    state.agents = snapshot.agents;
    state.events = Array.isArray(snapshot.events) ? snapshot.events : [];
    state.loaded = true;
    state.lastSnapshot = Date.now();
    renderHeader();
    renderCards();
    renderGraph();
    renderTimeline();
    announce();
    updateClock();
  }

  function updateClock() {
    if (!state.loaded) return;
    var now = Date.now();
    updateTotalTime();
    state.agents.forEach(function (agent) {
      updateCardTimes(agent, cardRefs.get(agent.agent), now);
    });
    updateGraphStale(now);
    els.lastUpdate.textContent = 'atualizado ' + ago(now - state.lastSnapshot);
  }

  /* ---------- conexão ---------- */
  function setConnection(mode) {
    var labels = {
      connecting: 'conectando…',
      live: 'SSE ao vivo',
      fallback: 'polling 1 s',
      down: 'sem conexão'
    };
    els.conn.setAttribute('data-state', mode);
    els.connText.textContent = labels[mode] || mode;
  }

  function startPolling() {
    if (polling) return;
    polling = true;
    setConnection('fallback');
    var poll = function () {
      fetch('/api/state', { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (snap) {
          apply(snap);
          if (!es || es.readyState === 2) setConnection('fallback');
        })
        .catch(function () {
          setConnection('down');
          els.lastUpdate.textContent = state.loaded
            ? 'sem dados ' + ago(Date.now() - state.lastSnapshot)
            : 'sem dados';
        });
    };
    poll();
    pollTimer = setInterval(poll, 1000);
  }

  function stopPolling() {
    polling = false;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function loadOnce() {
    fetch('/api/state', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(apply)
      .catch(function () { /* SSE tenta em seguida */ });
  }

  function connect() {
    if (typeof EventSource === 'undefined') {
      startPolling();
      return;
    }
    try {
      es = new EventSource('/events');
    } catch (e) {
      startPolling();
      return;
    }
    es.onopen = function () {
      stopPolling();
      setConnection('live');
    };
    es.onmessage = function (message) {
      try {
        apply(JSON.parse(message.data));
      } catch (e) { /* snapshot inválido: ignora */ }
      if (es.readyState === 1) {
        stopPolling();
        setConnection('live');
      }
    };
    es.onerror = function () {
      startPolling();
    };
  }

  function boot() {
    var addr = document.getElementById('serverAddr');
    if (addr) addr.textContent = location.host;
    setConnection('connecting');
    loadOnce();
    connect();
    clock = setInterval(updateClock, 1000);
  }

  window.addEventListener('beforeunload', function () {
    if (clock) clearInterval(clock);
    stopPolling();
    if (es) es.close();
  });

  boot();
})();
