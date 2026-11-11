/* Navegacao por controle remoto (projetor / TV box).
   ============================================================================
   O app nasceu para toque. Num projetor como o HY300 o que existe na mao e um
   controle IR (setas + OK + voltar) e, as vezes, um "air mouse" 2.4G. Sem esta
   camada, as setas so rolam a pagina e nao da para escolher nada.

   Como funciona:
     - os itens alcancaveis sao descobertos na hora (nao ha registro manual):
       botoes, linhas, chips, cartoes, campos e qualquer [data-f];
     - a seta escolhe o vizinho geometrico naquela direcao (menor distancia,
       com preferencia para quem esta alinhado na outra direcao);
     - OK dispara o clique do item; num campo de texto, OK abre o teclado;
     - VOLTAR (e Esc/Backspace) sobe um nivel: fecha dialogo, folha ou tela;
     - o item atual recebe a classe .foc (anel azul, desenhado com outline para
       nao deslocar nada no layout).

   O foco so aparece quando o usuario usa o controle (ou sempre, no modo TV).
   Mexer o mouse/escolher com o dedo esconde o anel, para nao atrapalhar o toque.
   ========================================================================== */
(function (g) {
  'use strict';
  var App = g.App;
  App.m = App.m || {};
  var U = App.m.ui || (App.m.ui = {});

  var SEL = 'button, .row, .poster, .chip, .toggle-row, .paste-btn, .star, input, [data-f]';

  var cur = null;         /* elemento com o anel */
  var pending = 0;        /* timer do foco automatico */
  var vigia = 0;          /* timer que devolve o anel depois de uma repintura */
  var ultimo = null;      /* ultimo retangulo do item focado */

  function isField(el) {
    if (!el || !el.tagName) return false;
    var t = el.tagName.toLowerCase();
    if (t === 'textarea') return true;
    if (t !== 'input') return false;
    var k = (el.type || 'text').toLowerCase();
    return k !== 'range' && k !== 'checkbox' && k !== 'radio' && k !== 'button';
  }

  function opacidadeOculta(el) {
    var n = el, i = 0;
    while (n && n.nodeType === 1 && i++ < 12) {
      var cs = g.getComputedStyle(n);
      if (cs.visibility === 'hidden' || cs.display === 'none') return true;
      if (parseFloat(cs.opacity || '1') < 0.05) return true;
      n = n.parentNode;
    }
    return false;
  }

  function visivel(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return false;
    if (opacidadeOculta(el)) return false;
    return true;
  }

  /* Dentro da janela AGORA. Serve so para escolher o foco inicial: a navegacao
     por setas precisa alcancar itens fora da tela (proxima categoria da faixa,
     proxima linha da grade), senao a seta "morre" na dobra. */
  function naTela(el) {
    var r = el.getBoundingClientRect();
    return r.bottom > 4 && r.top < g.innerHeight - 4 && r.right > 4 && r.left < g.innerWidth - 4;
  }

  /* Primeiro container que ainda tem espaco para rolar naquela direcao. */
  function containerQueRola(el, dir) {
    var vertical = (dir === 'up' || dir === 'down');
    var n = el.parentNode, i = 0;
    while (n && n.nodeType === 1 && i++ < 16) {
      var cs = g.getComputedStyle(n);
      var ov = vertical ? cs.overflowY : cs.overflowX;
      if ((ov === 'auto' || ov === 'scroll') && n.clientHeight > 0) {
        var folga = vertical
          ? (n.scrollHeight - n.clientHeight)
          : (n.scrollWidth - n.clientWidth);
        if (folga > 8) return n;
      }
      if (n === document.body) break;
      n = n.parentNode;
    }
    return null;
  }

  /* Rola um passo na direcao pedida. Devolve true SO se a posicao mudou de fato
     (no fim da lista devolve false, e a seta simplesmente nao faz nada). */
  function rolar(dir) {
    if (!cur) return false;
    var box = containerQueRola(cur, dir);
    if (!box) return false;
    var vertical = (dir === 'up' || dir === 'down');
    if (vertical) {
      var r = cur.getBoundingClientRect();
      var passo = Math.max(48, Math.round(r.height * 0.9));
      var antes = box.scrollTop;
      box.scrollTop = antes + (dir === 'down' ? passo : -passo);
      return box.scrollTop !== antes;
    }
    var passoH = Math.max(80, Math.round(box.clientWidth * 0.6));
    var antesH = box.scrollLeft;
    box.scrollLeft = antesH + (dir === 'right' ? passoH : -passoH);
    return box.scrollLeft !== antesH;
  }

  /* Camada que esta por cima: dialogo/folha, senao o player, senao o app. */
  function raiz() {
    var ov = document.getElementById('overlay');
    if (ov && ov.children.length) return ov;
    var pl = document.getElementById('player');
    if (pl && pl.classList.contains('on')) {
      /* controles so existem quando estao a vista (o .ctl fica com opacity 0) */
      return pl.classList.contains('show-ctl') ? pl : null;
    }
    return document.getElementById('app');
  }

  function candidatos() {
    var r = raiz();
    if (!r) return [];
    var all = r.querySelectorAll(SEL), out = [], i;
    for (i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.disabled) continue;
      /* um item dentro de outro item (o botao de estrela dentro da linha) conta
         como alvo proprio, mas o cartao que o contem nao deve "engolir" a seta */
      if (el.getAttribute('aria-hidden') === 'true') continue;
      if (!visivel(el)) continue;
      out.push(el);
    }
    return out;
  }

  function pintar(el) {
    if (cur === el) return;
    if (cur) cur.classList.remove('foc');
    cur = el;
    if (cur) {
      cur.classList.add('foc');
      ultimo = cur.getBoundingClientRect();
      try { cur.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* WebView antiga */ }
      iniciarVigia();
    } else {
      pararVigia();
    }
    document.documentElement.classList.toggle('kbd', !!cur);
  }

  function limpar() {
    if (cur) cur.classList.remove('foc');
    cur = null;
    document.documentElement.classList.remove('kbd');
    pararVigia();
  }

  /* As telas se redesenham sozinhas (chegada do catalogo, saude dos canais), e o
     no focado some junto. Sem isto o anel desaparecia do nada no meio da lista. */
  function restaurar() {
    if (!cur || document.body.contains(cur)) {
      if (cur) ultimo = cur.getBoundingClientRect();
      return;
    }
    var l = candidatos();
    if (!l.length) { limpar(); return; }
    var melhor = l[0], melhorD = Infinity;
    for (var i = 0; i < l.length; i++) {
      var b = l[i].getBoundingClientRect();
      var d = ultimo
        ? Math.abs(b.left - ultimo.left) + Math.abs(b.top - ultimo.top)
        : i;
      if (d < melhorD) { melhorD = d; melhor = l[i]; }
    }
    cur = null;
    pintar(melhor);
  }

  function iniciarVigia() {
    if (vigia) return;
    vigia = setInterval(restaurar, 500);
  }

  function pararVigia() {
    if (!vigia) return;
    clearInterval(vigia);
    vigia = 0;
  }

  function centro(r) { return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }

  function distanciaFora(a, b, horizontal) {
    /* quanto os dois retangulos estao deslocados no eixo "errado" (0 = alinhados) */
    if (horizontal) {
      if (b.bottom < a.top) return a.top - b.bottom;
      if (b.top > a.bottom) return b.top - a.bottom;
      return 0;
    }
    if (b.right < a.left) return a.left - b.right;
    if (b.left > a.right) return b.left - a.right;
    return 0;
  }

  function mover(dir, tentativa) {
    tentativa = tentativa || 0;
    if (cur && !document.body.contains(cur)) cur = null;
    /* Primeira seta sem anel na tela: nasce no conteudo, nao no primeiro botao
       da barra de cima (que e o que o DOM oferece primeiro). */
    if (!cur) return primeiro();
    var list = candidatos();
    if (!list.length) return false;

    if (list.indexOf(cur) < 0) { pintar(list[0]); return true; }

    var a = cur.getBoundingClientRect();
    var ca = centro(a);
    var caixa = containerQueRola(cur, dir);
    var dentroAlin = null, notaDentroAlin = 0;
    var dentroSolto = null, notaDentroSolto = 0;
    var foraAlin = null, notaForaAlin = 0;
    var foraSolto = null, notaForaSolto = 0;

    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (el === cur) continue;
      var b = el.getBoundingClientRect();
      var cb = centro(b);
      var dx = cb.x - ca.x, dy = cb.y - ca.y;
      var prim, fora;

      if (dir === 'left') { if (dx > -6) continue; prim = -dx; fora = distanciaFora(a, b, true); }
      else if (dir === 'right') { if (dx < 6) continue; prim = dx; fora = distanciaFora(a, b, true); }
      else if (dir === 'up') { if (dy > -6) continue; prim = -dy; fora = distanciaFora(a, b, false); }
      else { if (dy < 6) continue; prim = dy; fora = distanciaFora(a, b, false); }

      var nota = prim + fora * 3;
      var dentro = !caixa || caixa.contains(el);

      /* Prioridade: mesma area rolavel > outra area; dentro dela, alinhado >
         deslocado. "Mesma area" e o que impede a seta de sair da grade para a
         barra de abas quando ainda existe uma linha abaixo (a barra fica
         alinhada com a 1a coluna e, sem isto, ganhava por distancia). */
      if (dentro) {
        if (fora === 0) { if (!dentroAlin || nota < notaDentroAlin) { dentroAlin = el; notaDentroAlin = nota; } }
        else if (!dentroSolto || nota < notaDentroSolto) { dentroSolto = el; notaDentroSolto = nota; }
      } else if (fora === 0) {
        if (!foraAlin || nota < notaForaAlin) { foraAlin = el; notaForaAlin = nota; }
      } else if (!foraSolto || nota < notaForaSolto) { foraSolto = el; notaForaSolto = nota; }
    }

    if (dentroAlin || dentroSolto) { pintar(dentroAlin || dentroSolto); return true; }

    /* Nada na mesma area: ou acabou a lista, ou as linhas de baixo ainda nao
       foram criadas (lista virtualizada). Rola um passo e tenta de novo antes de
       pular para outra regiao (trilha, barra de abas). */
    if (tentativa < 2 && rolar(dir)) {
      setTimeout(function () { mover(dir, tentativa + 1); }, 80);
      return true;
    }

    if (foraAlin || foraSolto) { pintar(foraAlin || foraSolto); return true; }
    return false;
  }

  function disparar() {
    if (cur && !document.body.contains(cur)) cur = null;
    if (!cur) {
      var l = candidatos();
      if (!l.length) return false;
      var alvo = l[0];
      /* No player o primeiro alvo do DOM e o botao "voltar": sem anel, um OK
         fecharia o video. O alvo natural e o play/pause do meio. */
      if (raiz() === document.getElementById('player')) {
        alvo = document.querySelector('#player [data-act="toggle"]') || alvo;
      }
      pintar(alvo);
    }
    if (!cur) return false;
    var el = cur;

    if (isField(el)) {
      try { el.focus(); } catch (e) { /* ignore */ }
      return true;
    }
    if (el.tagName === 'INPUT' && (el.type === 'range')) {
      /* barra de tempo: OK nao faz nada, as setas ajustam (tratado no player) */
      return false;
    }

    var antes = el.getBoundingClientRect();
    try { el.click(); } catch (e) { /* ignore */ }

    /* Muitas acoes repintam a tela e o item atual deixa de existir. Depois de um
       instante, procura o alvo mais proximo do lugar onde o anel estava, para o
       controle nao "perder" a posicao (ex.: trocar de categoria nos chips). */
    setTimeout(function () {
      if (cur && document.body.contains(cur)) return;
      var l = candidatos();
      if (!l.length) { limpar(); return; }
      var cx = antes.left + antes.width / 2, cy = antes.top + antes.height / 2;
      var best = l[0], bestD = Infinity;
      for (var i = 0; i < l.length; i++) {
        var r = l[i].getBoundingClientRect();
        var d = Math.abs(r.left + r.width / 2 - cx) + Math.abs(r.top + r.height / 2 - cy);
        if (d < bestD) { bestD = d; best = l[i]; }
      }
      pintar(best);
    }, 90);
    return true;
  }

  function primeiro() {
    var l = candidatos();
    if (!l.length) { limpar(); return false; }

    /* Campos de texto ficam por ultimo: abrir uma tela ja com o teclado na tela
       atrapalha quem esta com o controle na mao (o campo de busca da TV, por
       exemplo). So viram foco inicial se nao houver mais nada. */
    var uteis = [];
    for (var k = 0; k < l.length; k++) if (!isField(l[k])) uteis.push(l[k]);
    if (uteis.length) l = uteis;

    /* Abrir uma tela nao deve rolar a pagina: o anel nasce no que esta a vista.
       (A navegacao por setas continua podendo sair da tela - ver mover().) */
    var aVista = [];
    for (var v = 0; v < l.length; v++) if (naTela(l[v])) aVista.push(l[v]);
    if (aVista.length) l = aVista;
    /* O primeiro item do DOM seria o botao de pesquisa da barra de cima (ou o X
       da folha). Numa TV o anel deve nascer no conteudo: primeiro o corpo do
       dialogo/folha aberto, senao a tela atual. */
    var alvo = l[0];
    var areas = ['.sheet-body', '.dialog', '#view'];
    for (var a = 0; a < areas.length; a++) {
      var box = document.querySelector(areas[a]);
      if (!box) continue;
      var achou = null;
      for (var i = 0; i < l.length; i++) {
        if (box.contains(l[i])) { achou = l[i]; break; }
      }
      if (achou) { alvo = achou; break; }
    }
    pintar(alvo);
    return true;
  }

  /* --- teclas ------------------------------------------------------------ */
  function direcao(code, key) {
    if (code === 37 || key === 'ArrowLeft') return 'left';
    if (code === 38 || key === 'ArrowUp') return 'up';
    if (code === 39 || key === 'ArrowRight') return 'right';
    if (code === 40 || key === 'ArrowDown') return 'down';
    return null;
  }

  function voltar() {
    if (!g.AndroidShell || !g.AndroidShell.back) return false;
    return !!g.AndroidShell.back();
  }

  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    var code = e.keyCode || 0, key = e.key || '';
    var dir = direcao(code, key);
    var enter = code === 13 || code === 23 || key === 'Enter' || code === 32 || key === ' ';
    var esc = code === 27 || key === 'Escape';

    /* 1) o player, quando aberto, tem prioridade nas setas e no OK */
    if (App.m.player && App.m.player.isOpen() && App.m.player.key) {
      if (App.m.player.key(e)) { e.preventDefault(); return; }
    }

    var alvo = e.target || document.activeElement;
    if (alvo && isField(alvo)) {
      /* digitando: as setas editam o texto, Backspace apaga.
         Backspace num campo vazio e Esc saem do campo. */
      if (esc || (code === 8 && !alvo.value)) {
        try { alvo.blur(); } catch (err) { /* ignore */ }
        e.preventDefault();
        setTimeout(function () { primeiro(); }, 30);
      }
      return;
    }

    if (dir) {
      e.preventDefault();
      mover(dir);
      return;
    }
    if (enter) {
      e.preventDefault();
      disparar();
      return;
    }
    if (esc) {
      e.preventDefault();
      voltar();
      return;
    }
    if (code === 8) {
      e.preventDefault();
      voltar();
      return;
    }
    /* teclas de midia do controle (alguns mandam para a pagina, outros vao
       direto para o Java - ver MainActivity.dispatchKeyEvent) */
    if (code === 179 || code === 85) {
      if (App.m.player && App.m.player.isOpen()) { App.m.player.toggle(); e.preventDefault(); }
      return;
    }
  }

  /* --- foco automatico --------------------------------------------------- */
  function reset(delay) {
    clearTimeout(pending);
    limpar();
    if (!(App.m.tv || document.documentElement.classList.contains('kbd'))) return;
    pending = setTimeout(function () { primeiro(); }, delay == null ? 80 : delay);
  }

  /* Ao trocar de tela o anel volta para o primeiro item, a menos que o usuario
     esteja usando o mouse (ai ele continua sem anel). */
  App.m.focus = {
    reset: reset,
    first: primeiro,
    move: mover,
    fire: disparar,
    clear: limpar,
    /* poe o anel num elemento especifico (usado pelo player ao abrir) */
    to: function (el) { if (!el) return false; pintar(el); return true; },
    current: function () { return cur; },
    candidates: candidatos,
    has: function () { return !!cur; }
  };

  U.firstFocus = primeiro;

  document.addEventListener('keydown', onKey, true);

  /* mouse/dedo: o anel sai de cena para nao brigar com o cursor */
  document.addEventListener('mousemove', function () {
    if (cur) limpar();
  }, true);
  document.addEventListener('mousedown', function (e) {
    if (cur && cur !== e.target && !cur.contains(e.target)) limpar();
  }, true);

  g.addEventListener('resize', function () { if (cur) limpar(); });
})(window);
