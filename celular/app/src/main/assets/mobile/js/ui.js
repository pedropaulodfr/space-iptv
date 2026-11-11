/* Componentes de interface para toque: icones, folhas, dialogos, teclado de PIN,
   listas virtualizadas e as pecas visuais reaproveitadas pelas telas. */
(function (g) {
  'use strict';
  var App = g.App;
  App.m = App.m || {};
  var U = App.m.ui = {};

  /* ------------------------------------------------------------- icones --- */
  var P = {
    home: 'M3.5 11.2 12 4.2l8.5 7M5.6 10.2v9.3h12.8v-9.3',
    live: 'M3.2 8.2h17.6v11H3.2zM8.4 3.2 12 6.1l3.6-2.9',
    movie: 'M3.2 5.6h17.6v13H3.2zM3.2 10h17.6M8.4 5.6v4.4M15.6 5.6v4.4',
    series: 'M3.2 6h17.6v10.4H3.2zM8.2 20h7.6M12 16.4V20',
    search: 'M11 4.4a6.6 6.6 0 1 0 0 13.2 6.6 6.6 0 0 0 0-13.2zM20 20l-4.4-4.4',
    star: 'M12 3.6l2.6 5.4 5.9.85-4.3 4.2 1 5.9-5.2-2.8-5.2 2.8 1-5.9-4.3-4.2 5.9-.85z',
    /* engrenagem de verdade: aro denteado + eixo central (o anterior era um sol,
       que o usuario leria como "claro/escuro"). */
    gear: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    back: 'M14.5 5.5 8 12l6.5 6.5',
    play: 'M8 5.2 19 12 8 18.8z',
    pause: 'M8.4 5h3.1v14H8.4zM12.5 5h3.1v14h-3.1z',
    prev: 'M7 5.5v13M18 6l-8 6 8 6z',
    next: 'M17 5.5v13M6 6l8 6-8 6z',
    /* ±10s: seta circular (mais claro que o triangulo solto de antes) */
    rw: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5',
    ff: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8M21 3v5h-5',
    multi: 'M3.4 4.4h7.2v6.6H3.4zM13.4 4.4h7.2v6.6h-7.2zM3.4 13.4h7.2v6.2H3.4zM13.4 13.4h7.2v6.2h-7.2z',
    audio: 'M11.4 5 7 8.8H4v6.4h3l4.4 3.8zM15.6 9.4a3.6 3.6 0 0 1 0 5.2M18.2 6.8a7.2 7.2 0 0 1 0 10.4',
    aspect: 'M4 9.2V4.2h5M20 14.8v5h-5M20 9.2V4.2h-5M4 14.8v5h5',
    list: 'M4 6.2h16M4 12h16M4 17.8h16',
    close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
    plus: 'M12 5.2v13.6M5.2 12h13.6',
    trash: 'M4.4 7.2h15.2M9.4 7.2V4.8h5.2v2.4M6.6 7.2l.9 12.4h9l.9-12.4',
    refresh: 'M20 12a8 8 0 1 1-2.4-5.7M20 3.6v4.8h-4.8',
    lock: 'M5.8 10.8h12.4v9.4H5.8zM8.8 10.8V8a3.2 3.2 0 0 1 6.4 0v2.8',
    check: 'M4.6 12.4l4.8 4.8L19.4 6.6',
    info: 'M12 3.4a8.6 8.6 0 1 0 0 17.2 8.6 8.6 0 0 0 0-17.2zM12 11v5.4M12 7.6v.9',
    chevron: 'M9.5 6.5 16 12l-6.5 5.5',
    down: 'M6.5 9.5 12 15l5.5-5.5',
    power: 'M12 4v7M7.4 6.6a7 7 0 1 0 9.2 0',
    folder: 'M3.6 6.4h6l1.6 2.2h9.2v9.8H3.6z',
    globe: 'M12 3.4a8.6 8.6 0 1 0 0 17.2 8.6 8.6 0 0 0 0-17.2zM3.6 12h16.8M12 3.4c2.4 2.6 3.4 5.6 3.4 8.6S14.4 18 12 20.6C9.6 18 8.6 15 8.6 12S9.6 6 12 3.4z',
    tv: 'M3.2 19.4h17.6',
    /* prancheta: botao "Colar" (a area de transferencia vem do Android) */
    clipboard: 'M9.2 4.6h5.6M8.2 5.6H6.6v14.6h10.8V5.6h-1.6M9.6 3.2h4.8v2.8H9.6z'
  };

  U.ico = function (name, cls) {
    var d = P[name] || '';
    var solid = (name === 'play' || name === 'pause');
    return '<svg class="' + (cls || '') + '" viewBox="0 0 24 24" aria-hidden="true"'
      + (solid ? ' fill="currentColor" stroke="none"' : '') + '><path d="' + d + '"/></svg>';
  };

  /* ------------------------------------------------------------- helpers --- */
  U.el = App.el;

  U.clear = function (node) { App.clear(node); };

  /* Altura de uma linha de canal, lida do CSS (--rowh). O projetor usa linhas
     mais altas; a lista virtualizada precisa do MESMO numero do CSS, senao as
     linhas se sobrepoem. */
  U.rowH = function (fallback) {
    var v = parseInt(g.getComputedStyle(document.documentElement).getPropertyValue('--rowh'), 10);
    return v > 0 ? v : (fallback || 76);
  };

  /* Largura util da area de conteudo: no projetor existe a trilha lateral. */
  U.contentWidth = function () {
    var rail = parseInt(g.getComputedStyle(document.documentElement).getPropertyValue('--rail'), 10);
    if (!(rail > 0)) rail = 0;
    return Math.max(240, g.innerWidth - rail);
  };

  /* ------------------------------------------------------------ clipboard --- */
  /* Limpa o que veio da area de transferencia. No celular o usuario copia o link
     de um app de mensagem, e o texto colado costuma vir com conversa em volta,
     aspas ou espacos invisiveis. */
  U.limparColado = function (raw) {
    var t = String(raw == null ? '' : raw);
    t = t.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
    if (!t) return '';
    var m = t.match(/https?:\/\/[^\s"'<>]+/i);
    if (m) t = m[0];
    t = t.replace(/^["'<]+/, '').replace(/["'>,;.]+$/, '').trim();
    return t;
  };

  /* Botao "Colar" que preenche um input com o texto da area de transferencia. */
  U.pasteBtn = function (input, opts) {
    opts = opts || {};
    var b = App.el('button', 'paste-btn');
    b.type = 'button';
    b.innerHTML = U.ico('clipboard') + '<span>Colar</span>';
    b.addEventListener('click', function (e) {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      var texto = U.limparColado(App.native.clipboard ? App.native.clipboard() : '');
      if (!texto) {
        App.toast('Não há nada para colar. Copie o link no celular ou no navegador.', 2600);
        return;
      }
      input.value = texto;
      try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (err) { /* ignore */ }
      if (opts.onPaste) opts.onPaste(texto);
      App.toast('Link colado', 1400);
    });
    return b;
  };

  /* Campo de texto padrao dos formularios. opts.paste liga o botao Colar. */
  U.textField = function (label, opts) {
    opts = opts || {};
    var box = App.el('div', 'field');
    if (label) box.appendChild(App.el('label', null, label));
    var row = App.el('div', opts.paste ? 'inrow' : null);
    var i = App.el('input', 'input');
    i.type = opts.password ? 'password' : 'text';
    i.value = opts.value == null ? '' : opts.value;
    if (opts.placeholder) i.placeholder = opts.placeholder;
    if (opts.inputMode) i.inputMode = opts.inputMode;
    if (opts.autocap === false) i.setAttribute('autocapitalize', 'off');
    if (opts.onInput) i.addEventListener('input', function () { opts.onInput(i.value, i); });
    i.addEventListener('focus', function () {
      setTimeout(function () { i.scrollIntoView({ block: 'center' }); }, 260);
    });
    row.appendChild(i);
    if (opts.paste) row.appendChild(U.pasteBtn(i, opts));
    box.appendChild(row);
    return { el: box, input: i };
  };

  U.btn = function (label, kind, onClick) {
    var b = App.el('button', 'btn' + (kind ? ' ' + kind : ''), label);
    if (onClick) b.addEventListener('click', onClick);
    return b;
  };

  U.spinner = function () { return App.el('div', 'spinner'); };

  U.empty = function (title, msg, actionLabel, onAction) {
    var box = App.el('div', 'empty');
    if (title) box.appendChild(App.el('div', 'big', title));
    if (msg) box.appendChild(App.el('div', null, msg));
    if (actionLabel) {
      var b = U.btn(actionLabel, 'primary', onAction);
      b.style.maxWidth = '280px';
      b.style.margin = '18px auto 0';
      box.appendChild(b);
    }
    return box;
  };

  U.sectionTitle = function (title, moreLabel, moreCb) {
    var h = App.el('div', 'sec');
    h.appendChild(App.el('h2', null, title));
    if (moreLabel) {
      var m = App.el('div', 'more', moreLabel);
      if (moreCb) m.addEventListener('click', moreCb);
      h.appendChild(m);
    }
    return h;
  };

  U.chips = function (items, current, onPick) {
    var box = App.el('div', 'chips');
    items.forEach(function (it) {
      var c = App.el('div', 'chip' + (it.id === current ? ' on' : ''), it.name);
      c.addEventListener('click', function () { onPick(it); });
      box.appendChild(c);
    });
    return box;
  };

  U.toggleRow = function (title, desc, on, onChange) {
    var row = App.el('div', 'toggle-row');
    var txt = App.el('div', 'txt');
    txt.appendChild(App.el('div', 't', title));
    if (desc) txt.appendChild(App.el('div', 's', desc));
    row.appendChild(txt);
    var sw = App.el('div', 'switch' + (on ? ' on' : ''));
    row.appendChild(sw);
    row.addEventListener('click', function () {
      var now = !sw.classList.contains('on');
      sw.classList.toggle('on', now);
      onChange(now);
    });
    return row;
  };

  U.iconBtn = function (name, onClick, label) {
    var b = App.el('button', 'icon-btn');
    b.innerHTML = U.ico(name);
    if (label) b.setAttribute('aria-label', label);
    if (onClick) b.addEventListener('click', onClick);
    return b;
  };

  /* Imagem com reserva: logo do canal sem imagem mostra a inicial. */
  U.logo = function (item, cls) {
    var box = App.el('div', cls || 'thumb');
    if (item.l) {
      var img = new Image();
      img.src = item.l;
      img.loading = 'lazy';
      img.alt = '';
      img.onerror = function () {
        App.clear(box);
        box.appendChild(document.createTextNode((item.n || '?').charAt(0).toUpperCase()));
      };
      box.appendChild(img);
    } else {
      box.appendChild(document.createTextNode((item.n || '?').charAt(0).toUpperCase()));
    }
    return box;
  };

  /* Linha de canal: logo, nome, categoria, saude e favorito. */
  U.channelRow = function (item, opts) {
    opts = opts || {};
    var list = opts.list || App.lists.active();
    var row = App.el('div', 'row');
    row.appendChild(U.logo(item));

    var txt = App.el('div', 'txt');
    txt.appendChild(App.el('div', 't', item.n || 'Sem nome'));
    var sub = [];
    if (opts.category) sub.push(opts.category);
    if (item.missing) sub.push('fora do catálogo');
    var s = App.el('div', 's', sub.join(' • '));
    txt.appendChild(s);
    row.appendChild(txt);

    if (App.health && App.health.enabled() && item.t === 'live' && !item.missing) {
      var dot = App.el('i', 'hdot gray');
      dot.setAttribute('data-hkey', App.health.keyOf(item, list));
      App.health.paint(dot, item, list);
      row.appendChild(dot);
    }

    var num = App.favs.num(item);
    if (num) {
      var badge = App.el('span', null, String(num));
      badge.style.cssText = 'flex:none;min-width:20px;height:20px;border-radius:7px;background:rgba(66,133,255,.9);'
        + 'color:#fff;font-size:11.5px;font-weight:700;display:flex;align-items:center;justify-content:center;padding:0 5px';
      row.appendChild(badge);
    }

    var star = App.el('button', 'star' + (App.favs.has(item) ? ' on' : ''));
    star.innerHTML = U.ico('star');
    star.addEventListener('click', function (e) {
      e.stopPropagation();
      var on = App.favs.toggle(item);
      star.classList.toggle('on', on);
      App.toast(on ? 'Adicionado aos favoritos' : 'Removido dos favoritos', 1600);
      refreshBadges();
    });
    row.appendChild(star);

    function refreshBadges() {
      var n = App.favs.num(item);
      if (badge) {
        badge.textContent = n ? String(n) : '';
        badge.style.display = n ? 'flex' : 'none';
      }
    }
    refreshBadges();

    row.addEventListener('click', function () { if (opts.onOpen) opts.onOpen(item); });
    return row;
  };

  /* Cartao de poster (filme/serie) */
  U.poster = function (item, opts) {
    opts = opts || {};
    var card = App.el('div', 'poster');
    var frame = App.el('div', 'frame');
    var art = new Image();
    art.className = 'art';
    art.alt = '';
    if (item.l) {
      art.src = item.l;
      art.onerror = function () {
        art.removeAttribute('src');
        art.style.background = 'linear-gradient(160deg,#101B3F,#070C1E)';
      };
    } else {
      art.style.background = 'linear-gradient(160deg,#101B3F,#070C1E)';
    }
    frame.appendChild(art);
    card.appendChild(frame);
    var cap = App.el('div', 'cap');
    cap.appendChild(App.el('div', 'trunc', item.n || 'Sem nome'));
    var meta = [item.y, item.r ? '★ ' + item.r : ''].filter(Boolean).join(' ');
    if (meta) cap.appendChild(App.el('div', 'y', meta));
    card.appendChild(cap);

    var num = App.favs.num(item);
    if (num) {
      var b = App.el('span', 'favnum', String(num));
      card.appendChild(b);
    }

    if (opts.progress && opts.hist) {
      var pct = Math.min(100, Math.round((opts.hist.pos / (opts.hist.dur || 1)) * 100));
      var bar = App.el('div', null);
      bar.style.cssText = 'position:absolute;left:0;right:0;bottom:0;height:3px;background:rgba(255,255,255,.2)';
      var fill = App.el('i', null);
      fill.style.cssText = 'display:block;height:100%;width:' + pct + '%;background:linear-gradient(90deg,#4285FF,#8257E5)';
      bar.appendChild(fill);
      card.appendChild(bar);
    }

    card.addEventListener('click', function () { if (opts.onOpen) opts.onOpen(item); });
    return card;
  };

  /* Faixa horizontal de cartoes */
  U.hstrip = function (items, renderCell) {
    var strip = App.el('div', 'chips');
    strip.style.paddingBottom = '4px';
    items.forEach(function (it) {
      var cell = renderCell(it);
      cell.style.flex = 'none';
      cell.style.width = '112px';
      strip.appendChild(cell);
    });
    return strip;
  };

  /* ------------------------------------------------ listas virtualizadas --- */
  /* Renderiza apenas a janela visivel: aguenta categoria com 30 mil linhas. */
  U.vscroll = function (host, o) {
    App.clear(host);
    var scroll = App.el('div', 'vscroll');
    var spacer = App.el('div', 'vspacer');
    scroll.appendChild(spacer);
    host.appendChild(scroll);

    var nodes = {}, count = o.count || 0, rowH = o.rowH || 76, raf = 0;

    function paint() {
      var h = scroll.clientHeight || host.clientHeight || 520;
      var top = scroll.scrollTop;
      var first = Math.max(0, Math.floor(top / rowH) - 2);
      var last = Math.min(count, first + Math.ceil(h / rowH) + 4);
      var k, i;

      for (k in nodes) {
        i = +k;
        if (i < first || i >= last) {
          if (nodes[k].parentNode) nodes[k].parentNode.removeChild(nodes[k]);
          delete nodes[k];
        }
      }
      for (i = first; i < last; i++) {
        if (nodes[i]) continue;
        var el = o.render(i);
        if (!el) continue;
        el.classList.add('vrow');
        el.style.top = (i * rowH) + 'px';
        el.style.height = rowH + 'px';
        spacer.appendChild(el);
        nodes[i] = el;
      }
      spacer.style.height = (count * rowH) + 'px';
    }

    function onScroll() {
      if (raf) return;
      raf = requestAnimationFrame(function () { raf = 0; paint(); });
    }

    scroll.addEventListener('scroll', onScroll, { passive: true });
    paint();

    return {
      el: scroll,
      paint: paint,
      setCount: function (n) { count = n; paint(); },
      scrollTop: function (v) { scroll.scrollTop = v; }
    };
  };

  /* --------------------------------------------------------------- modal --- */
  var layers = [];

  function overlayRoot() { return document.getElementById('overlay'); }

  function pushLayer(fn) { layers.push(fn); }

  U.closeTop = function () {
    if (!layers.length) return false;
    var fn = layers.pop();
    try { fn(); } catch (e) { /* ignore */ }
    return true;
  };

  U.dialog = function (o) {
    return new Promise(function (resolve) {
      var back = App.el('div', 'backdrop');
      var box = App.el('div', 'dialog');
      if (o.title) box.appendChild(App.el('div', 'dt', o.title));
      if (o.msg) box.appendChild(App.el('div', 'dm', o.msg));

      var inputEl = null;
      if (o.input) {
        var f = App.el('div', 'field');
        f.style.marginTop = '16px';
        if (o.input.label) f.appendChild(App.el('label', null, o.input.label));
        inputEl = App.el('input', 'input');
        inputEl.type = o.input.type || 'text';
        inputEl.value = o.input.value == null ? '' : o.input.value;
        if (o.input.placeholder) inputEl.placeholder = o.input.placeholder;
        if (o.input.inputMode) inputEl.inputMode = o.input.inputMode;
        if (o.input.autofocus) setTimeout(function () { inputEl.focus(); }, 120);
        inputEl.addEventListener('focus', function () {
          setTimeout(function () { inputEl.scrollIntoView({ block: 'center' }); }, 260);
        });
        f.appendChild(inputEl);
        box.appendChild(f);
      }

      var row = App.el('div', 'da');
      var done = false;

      function close() {
        if (back.parentNode) back.parentNode.removeChild(back);
        if (box.parentNode) box.parentNode.removeChild(box);
        var i = layers.indexOf(close);
        if (i >= 0) layers.splice(i, 1);
        if (App.m.focus) App.m.focus.reset(60);
      }

      function finish(action, value) {
        if (done) return;
        done = true;
        close();
        resolve({ action: action, value: value });
      }

      (o.actions || [{ id: 'ok', label: 'OK', kind: 'primary' }]).forEach(function (a) {
        var b = U.btn(a.label, a.kind, function () {
          finish(a.id, inputEl ? inputEl.value : null);
        });
        row.appendChild(b);
      });
      box.appendChild(row);

      back.addEventListener('click', function () { finish('cancel', null); });
      box.addEventListener('click', function (e) { e.stopPropagation(); });

      overlayRoot().appendChild(back);
      overlayRoot().appendChild(box);
      pushLayer(close);
      if (App.m.focus) App.m.focus.reset(90);

      return {
        close: function () { finish('cancel', null); }
      };
    });
  };

  /* Folha inferior (painel de canais, formularios longos). */
  U.sheet = function (o) {
    var back = App.el('div', 'backdrop');
    var sheet = App.el('div', 'sheet');
    sheet.appendChild(App.el('div', 'handle'));

    var head = App.el('div', 'sheet-head');
    head.appendChild(App.el('div', 't', o.title || ''));
    var closeBtn = U.iconBtn('close', function () { close(); }, 'Fechar');
    head.appendChild(closeBtn);
    sheet.appendChild(head);

    var body = App.el('div', 'sheet-body');
    sheet.appendChild(body);

    var closed = false;
    function close() {
      if (closed) return;
      closed = true;
      if (back.parentNode) back.parentNode.removeChild(back);
      if (sheet.parentNode) sheet.parentNode.removeChild(sheet);
      var i = layers.indexOf(close);
      if (i >= 0) layers.splice(i, 1);
      if (App.m.focus) App.m.focus.reset(60);
      if (o.onClose) o.onClose();
    }

    back.addEventListener('click', close);
    overlayRoot().appendChild(back);
    overlayRoot().appendChild(sheet);
    pushLayer(close);

    if (o.build) o.build(body, close);
    if (App.m.focus) App.m.focus.reset(120);

    return { el: sheet, body: body, close: close };
  };

  /* Teclado numerico do controle parental */
  U.pinPad = function (o) {
    return new Promise(function (resolve) {
      var back = App.el('div', 'backdrop');
      var box = App.el('div', 'dialog');
      box.appendChild(App.el('div', 'dt', o.title || 'Senha'));
      if (o.msg) box.appendChild(App.el('div', 'dm', o.msg));

      var dots = App.el('div', 'pin-dots');
      var keys = App.el('div', 'pin-keys');
      var pin = '';
      var done = false;

      function paint() {
        App.clear(dots);
        for (var i = 0; i < App.parental.LEN; i++) dots.appendChild(App.el('i', i < pin.length ? 'on' : ''));
      }

      function close(v) {
        if (done) return;
        done = true;
        if (back.parentNode) back.parentNode.removeChild(back);
        if (box.parentNode) box.parentNode.removeChild(box);
        var i = layers.indexOf(close);
        if (i >= 0) layers.splice(i, 1);
        if (App.m.focus) App.m.focus.reset(60);
        resolve(v);
      }

      function key(k) {
        if (k === 'del') { pin = pin.slice(0, -1); paint(); return; }
        if (k === 'cancel') { close(null); return; }
        if (pin.length >= App.parental.LEN) return;
        pin += k;
        paint();
        if (pin.length === App.parental.LEN) setTimeout(function () { close(pin); }, 120);
      }

      ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'cancel'].forEach(function (k) {
        var b = App.el('button', k === 'del' || k === 'cancel' ? 'wide' : null,
          k === 'del' ? 'Apagar' : (k === 'cancel' ? 'Cancelar' : k));
        b.addEventListener('click', function () { key(k); });
        keys.appendChild(b);
      });

      box.appendChild(dots);
      box.appendChild(keys);

      back.addEventListener('click', function () { close(null); });
      overlayRoot().appendChild(back);
      overlayRoot().appendChild(box);
      pushLayer(function () { close(null); });
      paint();
      if (App.m.focus) App.m.focus.reset(90);
    });
  };

  /* --------------------------------------------- App.ui exigido pela logica --- */
  /* parental.js chama App.ui.pinAsk; os demais modulos compartilhados usam
     confirm/alert para mensagens. */
  App.ui = {
    confirm: function (o) {
      o = o || {};
      return U.dialog({
        title: o.title || 'Confirmar',
        msg: o.msg || '',
        actions: [
          { id: 'no', label: o.no || 'Cancelar' },
          { id: 'yes', label: o.yes || 'OK', kind: 'primary' }
        ]
      }).then(function (r) { return r.action === 'yes'; });
    },

    alert: function (o) {
      o = o || {};
      return U.dialog({
        title: o.title || 'Aviso',
        msg: o.msg || '',
        actions: [{ id: 'ok', label: o.ok || 'OK', kind: 'primary' }]
      }).then(function () { return true; });
    },

    pinAsk: function (o) {
      o = o || {};
      return U.pinPad({ title: o.title || 'Senha', msg: o.msg || '' }).then(function (pin) {
        if (!pin) return false;
        return App.parental.check(pin).then(function (ok) {
          if (ok) return true;
          App.toast('Senha incorreta', 1800);
          return App.ui.pinAsk(o);
        });
      });
    },

    pinNew: function (o) {
      o = o || {};
      return U.pinPad({ title: o.title || 'Definir senha', msg: o.msg || 'Digite a nova senha de 4 números.' })
        .then(function (p1) {
          if (!p1) return null;
          return U.pinPad({ title: 'Confirme a senha', msg: 'Digite a senha novamente.' })
            .then(function (p2) {
              if (p2 !== p1) {
                App.toast('As senhas não conferem', 1800);
                return App.ui.pinNew(o);
              }
              return p1;
            });
        });
    }
  };

  /* Repinta os indicadores de saude visiveis quando o monitor responde. */
  App.bus.on('health', function (e) {
    if (!e || !e.key) return;
    var root = document.getElementById('view');
    if (root) App.health.paintKey(root, e.key, e.rec);
  });

  App.bus.on('favs', function () {
    if (!App.m.shell || !App.m.shell.refresh) return;
    App.m.shell.refresh();
  });
})(window);
