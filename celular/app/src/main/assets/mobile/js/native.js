/* Camada Android: adapta os pontos do app que dependiam do Tizen (armazenamento
   seguro, janela, areas seguras) sem tocar na logica compartilhada.

   O app Tizen guardava a chave AES do App.secrets no proprio localStorage. Aqui a
   chave vive no Android Keystore e o JS so pede para cifrar/decifrar.

   Aqui tambem se decide o MODO DE TELA: celular (toque, navegacao inferior) ou
   projetor/TV (trilha lateral, controle remoto, graficos mais leves). A decisao
   vem do tamanho da janela e do que o Java informa sobre o aparelho. */
(function (g) {
  'use strict';
  var App = g.App;
  var N = g.SpaceNative || null;

  App.m = App.m || {};

  function jcall(fn, def) {
    try { var v = fn(); return v == null ? def : v; } catch (e) { return def; }
  }

  function json(txt) {
    try { return JSON.parse(txt) || {}; } catch (e) { return {}; }
  }

  App.native = {
    ok: !!N,

    info: function () { return N ? json(jcall(function () { return N.info(); }, '{}')) : {}; },

    /* area util do sistema (status bar, navegacao, recorte de tela) */
    insets: function () { return N ? json(jcall(function () { return N.insets(); }, '{}')) : {}; },

    exit: function () { if (N) jcall(function () { N.exit(); }); },
    orientation: function (mode) { if (N) jcall(function () { N.orientation(mode); }); },
    immersive: function (on) { if (N) jcall(function () { N.immersive(!!on); }); },
    keepAwake: function (on) { if (N) jcall(function () { N.keepScreenOn(!!on); }); },
    /* pagina transparente durante a reproducao: o video nativo fica atras dela */
    webTransparent: function (on) { if (N) jcall(function () { N.webTransparent(!!on); }); },

    /* Texto da area de transferencia do Android. A WebView nao deixa ler o
       clipboard por conta propria em file:// (e o "toque longo" esta desligado
       de proposito), entao o botao "Colar" dos formularios passa por aqui. */
    clipboard: function () {
      if (!N || !N.clipboard) return '';
      return String(jcall(function () { return N.clipboard(); }, '') || '');
    },

    log: function (msg) {
      if (N) jcall(function () { N.log(String(msg)); });
      else if (g.console) console.log(msg);
    }
  };

  /* ---------------------------------------------------------- segredos --- */
  if (N && N.seal) {
    App.secrets = {
      seal: function (text) {
        var t = String(text == null ? '' : text);
        if (!t) return Promise.resolve('');
        return Promise.resolve(String(jcall(function () { return N.seal(t); }, '') || ''));
      },
      open: function (s) {
        s = String(s == null ? '' : s);
        if (!s) return Promise.resolve('');
        return Promise.resolve(String(jcall(function () { return N.open(s); }, '') || ''));
      }
    };
  }

  /* ------------------------------------------------------ areas seguras --- */
  App.m.safe = { top: 0, bottom: 0, left: 0, right: 0 };

  App.m.applyInsets = function (i) {
    App.m.safe = {
      top: Math.round(i.top || 0),
      bottom: Math.round(i.bottom || 0),
      left: Math.round(i.left || 0),
      right: Math.round(i.right || 0)
    };
    var s = document.documentElement.style;
    s.setProperty('--sat', App.m.safe.top + 'px');
    s.setProperty('--sab', App.m.safe.bottom + 'px');
    s.setProperty('--sal', App.m.safe.left + 'px');
    s.setProperty('--sar', App.m.safe.right + 'px');
    /* teclado aberto: vem do Android, porque a pagina nao enxerga o IME */
    if (typeof i.ime === 'number') {
      App.m.keyboard = Math.max(0, Math.round(i.ime));
      s.setProperty('--kb', App.m.keyboard + 'px');
    }
    App.bus.emit('insets', App.m.safe);
  };

  App.m.applyInsets(App.native.insets() || {});

  /* --------------------------------------------------- teclado na tela --- */
  /* Com edge-to-edge o teclado do sistema cobre a pagina em vez de redimensionar
     a janela: publica a altura coberta em --kb para as folhas e dialogos subirem. */
  App.m.keyboard = 0;

  function syncKeyboard() {
    var vv = g.visualViewport;
    if (!vv) return;
    var kb = Math.round(g.innerHeight - vv.height - (vv.offsetTop || 0));
    if (kb < 0) kb = 0;
    if (Math.abs(kb - App.m.keyboard) < 2) return;
    App.m.keyboard = kb;
    document.documentElement.style.setProperty('--kb', kb + 'px');
    App.bus.emit('keyboard', kb);
  }

  if (g.visualViewport) {
    g.visualViewport.addEventListener('resize', syncKeyboard);
    g.visualViewport.addEventListener('scroll', syncKeyboard);
  }
  g.addEventListener('focusin', function () { setTimeout(syncKeyboard, 120); });
  g.addEventListener('focusout', function () { setTimeout(syncKeyboard, 120); });

  /* ===================================================== modo de tela ===
     Projetor (HY300 e parecidos) = tela larga, sem toque de verdade, memoria
     curta e WebView velha. Nesse modo a interface troca a barra de baixo por
     uma trilha lateral, aumenta os alvos e desliga efeitos caros. */
  var INFO = App.native.info();

  App.m.env = {
    sdk: Number(INFO.sdk || 0),
    model: String(INFO.model || ''),
    lowRam: !!INFO.lowRam,
    touch: INFO.touch !== false,
    refresh: Number(INFO.refresh || 60),
    /* versao do motor da WebView: a do HY300 e 71 */
    webview: (function () {
      var m = /Chrome\/(\d+)/.exec(g.navigator.userAgent || '');
      return m ? Number(m[1]) : 0;
    })()
  };

  function autoTv() {
    if (App.m.env.touch === false) return true;
    return g.innerWidth >= 960 && g.innerWidth > g.innerHeight;
  }

  function prefMode() {
    var v = App.store && App.store.get ? App.store.get('ui.mode') : '';
    return v === 'tv' || v === 'phone' ? v : 'auto';
  }

  App.m.applyMode = function (opts) {
    opts = opts || {};
    var pref = prefMode();
    var tv = pref === 'tv' ? true : (pref === 'phone' ? false : autoTv());
    var low = !!App.m.env.lowRam || (App.m.env.webview > 0 && App.m.env.webview < 74);

    var mudou = (tv !== App.m.tv) || (low !== App.m.low);
    App.m.tv = tv;
    App.m.low = low;
    App.m.modePref = pref;

    var h = document.documentElement;
    h.classList.toggle('tv', tv);
    h.classList.toggle('low', low);

    /* 1 GB de RAM e Cortex-A35: sonda menos canais ao mesmo tempo e guarda
       menos historico de saude, senao o navegador da lista fica pesado. */
    if (low && App.health && App.health.configure) {
      try { App.health.configure({ concurrency: 2, maxQueue: 40, maxRecords: 2500 }); } catch (e) { /* ignore */ }
    }

    if (App.bus) App.bus.emit('mode', { tv: tv, low: low, pref: pref });
    return { tv: tv, low: low, mudou: mudou };
  };

  App.m.applyMode();

  App.m.setMode = function (mode) {
    if (App.store && App.store.set) App.store.set('ui.mode', mode === 'tv' || mode === 'phone' ? mode : '');
    App.m.applyMode();
  };

  /* Girar o aparelho (ou entrar/sair do modo desktop) pode trocar o modo. Se o
     usuario fixou celular/projetor, a escolha dele manda. */
  var rzT = 0;
  g.addEventListener('resize', function () {
    clearTimeout(rzT);
    rzT = setTimeout(function () {
      if (prefMode() !== 'auto') return;
      var antes = App.m.tv;
      App.m.applyMode();
      if (antes !== App.m.tv && App.m.shell && App.m.shell.reflow) App.m.shell.reflow();
    }, 220);
  });

  /* ---------------------------------------------------------- diagnostico --- */
  g.addEventListener('error', function (e) {
    App.native.log('ERRO JS: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
  });
  g.addEventListener('unhandledrejection', function (e) {
    var r = e.reason;
    App.native.log('PROMISE NAO TRATADA: ' + ((r && (r.message || r.code)) || r));
  });

  /* Duplo toque nao deve dar zoom e o toque longo nao deve selecionar texto. */
  var lastTap = 0;
  document.addEventListener('touchend', function (e) {
    var now = Date.now();
    if (now - lastTap < 320) e.preventDefault();
    lastTap = now;
  }, { passive: false });
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('dragstart', function (e) { e.preventDefault(); });
})(window);
