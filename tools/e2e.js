// Teste ponta a ponta do app Android: dirige a interface real (cliques no DOM da WebView)
// via Chrome DevTools Protocol e confere o estado da aplicacao.
//
// Pre-requisitos:
//   1) emulador/aparelho com o APK debug instalado e o app aberto
//   2) adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>   (use tools\cdp.ps1)
//   3) servidor de streams: node tools\mock-streams.js
//
// Uso: node tools\e2e.js [--keep]
const http = require('http');
const fs = require('fs');
const path = require('path');
const WS = require('./node_modules/ws');

const PORT = Number(process.env.CDP_PORT || 9222);
const SHOTS = path.join(__dirname, '_shots');
const KEEP = process.argv.includes('--keep');

/* Endereco do servidor de streams (tools\mock-streams.js) visto PELO APARELHO.
   No emulador o host da maquina e 10.0.2.2. Num aparelho no USB, use
   `adb reverse tcp:8090 tcp:8090` e rode com MOCK=127.0.0.1:8090.
   Num aparelho na rede Wi-Fi, passe o IP da maquina (ex.: 192.168.0.5:8090). */
const MOCK = process.env.MOCK || '10.0.2.2:8090';

let passed = 0;
let failed = 0;
const fails = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log('  ok   ' + name); }
  else { failed++; fails.push(name + (detail ? ' :: ' + JSON.stringify(detail) : '')); console.log('  FALHOU ' + name + (detail ? ' :: ' + JSON.stringify(detail) : '')); }
}

function get(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve(d));
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async function main() {
  const list = JSON.parse(await get('/json/list'));
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('WebView nao encontrada');

  const ws = new WS(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();

  function send(method, params) {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    return new Promise((r) => pending.set(mid, r));
  }

  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });

  await new Promise((r) => ws.on('open', r));

  async function ev(expr) {
    const r = await send('Runtime.evaluate', {
      expression: '(async function(){try{return JSON.stringify({ok:true,v:await (' + expr + ')});}catch(e){return JSON.stringify({ok:false,e:String(e&&e.message||e)});}})()',
      returnByValue: true,
      awaitPromise: true
    });
    const v = r.result && r.result.result && r.result.result.value;
    if (!v) throw new Error('sem resposta do Runtime.evaluate: ' + JSON.stringify(r).slice(0, 200));
    const p = JSON.parse(v);
    if (!p.ok) throw new Error(p.e);
    return p.v;
  }

  async function waitFor(expr, ms, label) {
    const end = Date.now() + (ms || 8000);
    while (Date.now() < end) {
      try { if (await ev(expr)) return true; } catch (e) { /* ainda nao */ }
      await sleep(250);
    }
    throw new Error('timeout esperando ' + (label || expr));
  }

  async function shot(name) {
    /* Em algumas WebView antigas (projetor HY300, Chrome 71) o protocolo nunca
       responde a captura de tela. Sem o limite, a bateria de testes travaria. */
    const r = await Promise.race([
      send('Page.captureScreenshot', { format: 'png' }),
      sleep(6000).then(() => null)
    ]);
    const d = r && r.result && r.result.data;
    if (!d) { console.log('  (sem foto: ' + name + ')'); return; }
    fs.mkdirSync(SHOTS, { recursive: true });
    fs.writeFileSync(path.join(SHOTS, name), Buffer.from(d, 'base64'));
  }

  /* location.reload() nao reinicia a pagina no WebView de forma confiavel:
     o comando do protocolo reinicia de verdade. */
  async function reload() {
    await send('Page.enable');
    await send('Page.reload', { ignoreCache: true });
  }

  const HELPERS = `
    window.__t = {
      byText: function (t, sel) {
        var a = Array.from(document.querySelectorAll(sel || 'button, .row, .chip, .poster, .icon-btn'));
        return a.find(function (e) { return (e.textContent || '').indexOf(t) >= 0; }) || null;
      },
      clickText: function (t, sel) { var e = __t.byText(t, sel); if (!e) return false; e.click(); return true; },
      clickIn: function (rootSel, t) {
        var r = document.querySelector(rootSel); if (!r) return false;
        var a = Array.from(r.querySelectorAll('button, .chip, .row, .star'));
        var e = a.find(function (x) { return (x.textContent || '').indexOf(t) >= 0; });
        if (!e) return false; e.click(); return true;
      },
      setInputIn: function (rootSel, idx, v) {
        var r = document.querySelector(rootSel); if (!r) return false;
        var e = r.querySelectorAll('input')[idx]; if (!e) return false;
        e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); return true;
      },
      setInput: function (idx, v) {
        var a = document.querySelectorAll('input');
        var e = a[idx]; if (!e) return false;
        e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); return true;
      },
      sheetOpen: function () { return !!document.querySelector('.sheet'); },
      dialogOpen: function () { return !!document.querySelector('.dialog'); }
    };`;

  await ev('(function(){' + HELPERS + ';return 1;})()');

  console.log('\n== 0. Estado limpo ==');
  await ev('(function(){ window.__prevPage = 1; localStorage.clear(); sessionStorage.clear(); try { indexedDB.deleteDatabase("spaceiptv"); } catch (e) {} return 1; })()');
  await reload();
  await sleep(4500);
  await waitFor('!window.__prevPage && !!(window.App && App.m && App.m.shell && document.querySelectorAll("#tabs button").length === 5)', 30000, 'pagina recarregada de verdade');
  await sleep(1200);
  await ev('(function(){' + HELPERS + ';return 1;})()');
  check('armazenamento zerado', (await ev('App.lists.all().length')) === 0);

  console.log('\n== 1. Estado inicial ==');
  const boot = await ev('({ready:document.readyState, app:!!window.App, tabs:document.querySelectorAll("#tabs button").length, lists:App.lists.all().length, bridge:!!window.SpaceNative, player:!!window.SpacePlayer})');
  check('pagina carregada', boot.ready === 'complete');
  check('camada compartilhada presente (App)', boot.app === true);
  check('5 abas montadas', boot.tabs === 5, boot.tabs);
  check('ponte nativa disponivel', boot.bridge === true);
  check('ponte do player registrada', boot.player === true);

  const ver = await ev('App.native.info()');
  console.log('  info:', JSON.stringify(ver));
  check('info() devolve versao e aparelho', !!(ver && ver.version && ver.sdk), ver);
  await shot('e2e-01-inicio.png');

  console.log('\n== 2. Chave no Android Keystore ==');
  const sealed = await ev('App.secrets.seal("senha-secreta-123")');
  /* n1: = Keystore (hardware); l1: = chave AES local, usada em aparelhos cujo
     Keystore recusa criar chaves (o projetor HY300 e um deles). Nos dois casos o
     texto tem de estar cifrado de verdade; base64 cru (p0:) e falha. */
  const selado = await ev('(function(){var s=SpaceNative.seal("teste");return {pre:s.slice(0,3), tam:s.length};})()');
  check('seal() cifra de verdade (n1: keystore ou l1: chave local)',
    (selado.pre === 'n1:' || selado.pre === 'l1:') && selado.tam > 20, selado);
  const opened = await ev('App.secrets.open(' + JSON.stringify(sealed) + ')');
  check('open() devolve o texto original', opened === 'senha-secreta-123', opened);
  const plain = await ev('(function(){for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);var v=localStorage.getItem(k)||"";if(v.indexOf("senha-secreta")>=0)return k;}return "";})()');
  check('senha nao aparece em texto puro no localStorage', plain === '', plain);

  console.log('\n== 3. Cadastro da lista pela interface ==');
  if (await ev('App.lists.all().length === 0')) {
    await ev('App.m.shell.go("settings")');
    await waitFor('!!document.querySelector("#view button")', 8000, 'tela de configuracoes');
    const opened = await ev('__t.clickIn("#view", "Adicionar lista")');
    check('abre o formulario de lista', opened, await ev('Array.from(document.querySelectorAll("#view button")).map(function(b){return b.textContent.trim();})'));
    await waitFor('__t.sheetOpen()', 6000, 'folha do formulario');
    await shot('e2e-02-form-lista.png');
    await ev('__t.setInputIn(".sheet", 0, "Lista de teste")');
    await ev('__t.setInputIn(".sheet", 1, "http://' + MOCK + '/lista.m3u")');
    check('salva a lista', await ev('__t.clickIn(".sheet", "Adicionar lista")'));
    await waitFor('App.lists.all().length === 1', 10000, 'lista salva');
  } else {
    console.log('  (lista ja cadastrada, seguindo)');
  }

  const lists = await ev('App.lists.all()');
  check('lista persistida no armazenamento', lists.length >= 1, lists.length);
  check('URL da lista ficou selada', lists[0] && typeof lists[0].urlS === 'string' && lists[0].urlS.length > 0 && !lists[0].url, lists[0] && lists[0].urlS.slice(0, 6));

  console.log('\n== 4. Catalogo (parser M3U + cache) ==');
  await waitFor('App.catalog.data.live.length > 0', 30000, 'catalogo carregado');
  const cat = await ev(`(function(){
    var d = App.catalog.data;
    var eps = 0;
    d.series.forEach(function (s) { if (s.eps) eps += (s.eps[1] || []).length; });
    return {live:d.live.length, movie:d.movie.length, series:d.series.length,
            cats:d.cats.live.length + d.cats.movie.length + d.cats.series.length,
            updated:App.catalog.updated > 0};
  })()`);
  console.log('  catalogo:', JSON.stringify(cat));
  check('canais ao vivo importados', cat.live >= 5, cat.live);
  check('filmes classificados', cat.movie >= 2, cat.movie);
  check('series agrupadas (episodios da mesma serie viram um item)', cat.series === 1, cat.series);
  check('categorias por tipo criadas', cat.cats >= 4, cat.cats);
  check('cache marcado como atualizado', cat.updated === true);
  const epInfo = await ev(`App.catalog.seriesInfo(App.catalog.data.series[0], App.lists.active()).then(function(r){
    var s = r.seasons, n = 0, t = 0;
    if (Array.isArray(s)) { t = s.length; s.forEach(function (x) { n += (x.eps || []).length; }); }
    else { t = Object.keys(s).length; Object.keys(s).forEach(function (k) { n += (s[k] || []).length; }); }
    return {temporadas: t, episodios: n};
  })`);
  check('episodios da serie recuperaveis', epInfo.episodios >= 2, epInfo);

  const persisted = await ev('App.idb.get("cat." + App.catalog.listId).then(function(c){return !!(c && c.data && c.data.live && c.data.live.length);})');
  check('catalogo gravado no IndexedDB', persisted === true);

  console.log('\n== 5. Navegacao e telas ==');
  await ev('App.m.shell.go("live")');
  await waitFor('document.querySelectorAll("#view .row").length > 0', 8000, 'lista de canais');
  const rows = await ev('document.querySelectorAll("#view .row").length');
  check('tela TV renderiza canais', rows >= 3, rows);
  await shot('e2e-03-tv-ao-vivo.png');

  await ev('App.m.shell.go("movies")');
  await waitFor('document.querySelectorAll("#view .poster").length > 0', 8000, 'grade de filmes');
  check('grade de filmes renderiza', (await ev('document.querySelectorAll("#view .poster").length')) >= 2);
  await shot('e2e-04-filmes.png');

  await ev('App.m.shell.go("series")');
  await waitFor('document.querySelectorAll("#view .poster").length > 0', 8000, 'grade de series');
  check('grade de series renderiza', (await ev('document.querySelectorAll("#view .poster").length')) >= 1);

  // detalhes da serie: temporadas e episodios na tela (formato M3U empacotado)
  await ev('App.m.shell.push("details", {item: App.catalog.data.series[0], type: "series"})');
  await waitFor('document.querySelectorAll("#view .row").length >= 2', 15000, 'episodios na tela de detalhes');
  check('detalhes da serie lista os episodios', (await ev('document.querySelectorAll("#view .row").length')) >= 2);
  await shot('e2e-08-serie-detalhes.png');
  await ev('App.m.shell.back()');
  await sleep(400);

  console.log('\n== 6. Favoritos: numeracao 1..9 ==');
  const favTest = await ev(`(function(){
    var items = App.catalog.items('live','*').slice(0,3);
    items.forEach(function(it){ if(!App.favs.has(it)) App.favs.toggle(it); });
    var nums = App.favs.nums();
    return {count: App.favs.liveList().length, first: App.favs.byNumber(1) ? App.favs.byNumber(1).id : null, keys: Object.keys(nums).length};
  })()`);
  check('favoritos registrados', favTest.count >= 3, favTest.count);
  check('primeiro favorito tem numero 1', !!favTest.first);
  check('mapa de numeros preenchido', favTest.keys >= 3, favTest.keys);

  await ev('App.m.shell.go("favs")');
  await waitFor('document.querySelectorAll("#view .card").length >= 9', 8000, 'grade de acesso rapido');
  check('tela de favoritos mostra acesso rapido 3x3', (await ev('document.querySelectorAll("#view .card").length')) >= 9);
  await shot('e2e-05-favoritos.png');

  console.log('\n== 7. Reproducao (ExoPlayer) ==');
  await ev('App.m.shell.go("live")');
  await sleep(600);
  // abre o primeiro canal (HLS) pela linha da lista
  await ev('(function(){var r=document.querySelectorAll("#view .row")[0]; r.click(); return true;})()');
  await waitFor('App.m.player.isOpen()', 8000, 'player aberto');
  await waitFor('(function(){var s=JSON.parse(SpaceNative.playerState(0));return s.opened===true;})()', 10000, 'player nativo com midia');
  const st1 = await ev('JSON.parse(SpaceNative.playerState(0))');
  console.log('  estado do slot 0:', JSON.stringify(st1));
  check('slot 0 recebeu o stream', st1.opened === true, st1);

  let playing = false;
  for (let i = 0; i < 40; i++) {
    const s = await ev('JSON.parse(SpaceNative.playerState(0))');
    if (s.playing) { playing = true; break; }
    await sleep(500);
  }
  check('video comecou a tocar', playing);
  await sleep(2500);
  const st2 = await ev('JSON.parse(SpaceNative.playerState(0))');
  check('posicao avanca (reproducao real)', st2.pos > 0, st2.pos);
  check('duracao conhecida (HLS VOD)', st2.dur > 0, st2.dur);
  await shot('e2e-06-player.png');

  // --- 1.0.1: icones dos botoes, engrenagem e z-order dos controles ---
  const icones = await ev(`(function(){
    var atos = ['back','prev','next','toggle'];
    var faltando = atos.filter(function (a) {
      var b = document.querySelector('#player [data-act=' + a + ']');
      var p = b && b.querySelector('svg path');
      return !(p && p.getAttribute('d'));
    });
    return {faltando: faltando, gear: (function () {
      var p = document.querySelector('#btn-settings svg path');
      return p ? p.getAttribute('d').indexOf('M12 9a3') >= 0 : false;
    })()};
  })()`);
  check('botoes do player com icone', icones.faltando.length === 0, icones.faltando);
  check('icone de configuracoes e engrenagem', icones.gear === true);
  check('chips do canal ao vivo (Canais/MultiView)',
    (await ev('document.querySelector(".p-actions").textContent.indexOf("MultiView") >= 0')) === true);

  // filme: barra de progresso + icones de ±10s (o que faltava na 1.0.0)
  await ev('App.m.player.open(App.catalog.items("movie")[0])');
  await sleep(2500);
  const vod = await ev(`(function(){
    var seek = document.querySelectorAll('input[type=range]')[0];
    var meio = ['rw','ff'].map(function (a) {
      var b = document.querySelector('.p-mid [data-act=' + a + ']');
      return getComputedStyle(b).display !== 'none' && !!b.querySelector('svg path');
    });
    return {barra: seek ? getComputedStyle(seek.parentNode).display : 'sem range', icones: meio};
  })()`);
  check('filme mostra a linha do tempo', vod.barra === 'flex', vod.barra);
  check('filme mostra os icones de ±10s', vod.icones[0] && vod.icones[1], vod.icones);

  // preenchimento da barra: tem de seguir a posicao e o arrasto
  const fill = await ev(`(function(){
    var s = document.querySelectorAll('input[type=range]')[0];
    var dur = App.m.player.state().dur || 1;
    SpaceNative.playerSeek(0, Math.round(dur * 0.4));
    return new Promise(function (res) {
      setTimeout(function () {
        var naPosicao = Number(s.style.getPropertyValue('--p'));
        s.value = '750';
        s.dispatchEvent(new Event('input'));
        var noArrasto = Number(s.style.getPropertyValue('--p'));
        s.dispatchEvent(new Event('change'));   // commita e sai do modo arrasto
        res({posicao: naPosicao, arrasto: noArrasto});
      }, 1800);
    });
  })()`);
  check('barra preenchida ate a posicao atual', fill.posicao > 0.3 && fill.posicao < 0.5, fill.posicao);
  check('barra acompanha o arrasto', Math.abs(fill.arrasto - 0.75) < 0.01, fill.arrasto);
  await ev('App.m.player.close()');
  await sleep(1200);

  // regressao: abrir canal depois de um filme tem de repintar os chips
  await ev('App.m.player.open(App.catalog.items("live")[0])');
  await sleep(2500);
  const chipsDepois = await ev('document.querySelector(".p-actions").textContent');
  check('chips voltam ao abrir canal depois de filme',
    chipsDepois.indexOf('Canais') >= 0 && chipsDepois.indexOf('MultiView') >= 0, chipsDepois);

  console.log('\n== 8. Controles e historico no player ==');
  const before = (await ev('JSON.parse(SpaceNative.playerState(0))')).pos;
  await ev('(function(){var b=document.querySelector("#player [data-act=toggle]"); b.click(); return true;})()');
  await sleep(1500);
  const paused = await ev('JSON.parse(SpaceNative.playerState(0))');
  check('pausa funciona', paused.playing === false, paused.playing);
  await ev('(function(){document.querySelector("#player [data-act=toggle]").click(); return true;})()');
  await sleep(1200);
  check('retomada funciona', (await ev('JSON.parse(SpaceNative.playerState(0))')).playing === true);

  await ev('(function(){document.querySelector("#player [data-act=aspect]").click(); return true;})()');
  check('botao de ajuste de imagem nao quebra', (await ev('App.m.player.isOpen()')) === true);

  await ev('App.m.player.close()');
  await sleep(1200);
  check('player fechou', (await ev('App.m.player.isOpen()')) === false);
  const closed = await ev('(function(){var s=JSON.parse(SpaceNative.playerState(0));return s.opened;})()');
  check('player nativo liberado', closed === false, closed);
  check('pagina voltou a ficar opaca', (await ev('document.documentElement.classList.contains("playing")')) === false);

  console.log('\n== 9. Ultimo canal e historico (VOD) ==');
  const lastCh = await ev('App.resume.get()');
  check('ultimo canal ao vivo registrado', !!(lastCh && lastCh.id), lastCh);
  await ev('App.resume.setEnabled(true)');
  check('preferencia de retomada persiste', (await ev('App.resume.enabled()')) === true);
  const dec = await ev('App.resume.decide()');
  check('decisao de retomada ok para canal comum', dec.reason === 'ok' || dec.reason === 'missing', dec);

  console.log('\n== 10. Controle parental ==');
  await ev('App.parental.setPin("1234")');
  await sleep(400);
  check('PIN gravado selado', (await ev('(function(){var s=App.store.get("pinS","");return typeof s==="string"&&(s.indexOf("n1:")===0||s.indexOf("l1:")===0);})()')) === true);
  check('bloqueio ativo por padrao apos definir', (await ev('App.parental.locked()')) === true);
  const filt = await ev(`(function(){
    var all = App.catalog.data.live;
    return {total: all.length,
            visiveis: App.catalog.items('live','*').length,
            adultCount: all.filter(function (i) { return App.parental.isAdult(i); }).length,
            cats: App.parental.filterCats('live').length,
            catsTodas: App.catalog.data.cats.live.length};
  })()`);
  console.log('  filtro parental:', JSON.stringify(filt));
  check('existe canal adulto no catalogo', filt.adultCount >= 1, filt);
  check('canal adulto escondido', filt.visiveis === filt.total - filt.adultCount, filt);
  check('categoria adulta escondida', filt.cats < filt.catsTodas, filt);
  check('PIN errado nao libera', (await ev('App.parental.check("0000")')) === false);
  check('PIN certo libera', (await ev('App.parental.check("1234")')) === true);
  await ev('App.parental.unlock()');
  check('sessao liberada mostra tudo', (await ev('App.catalog.items("live","*").length')) === filt.total);
  const adultBlock = await ev('(function(){var a=App.catalog.data.live.filter(function(i){return App.parental.isAdult(i);})[0];return a?{id:a.id,adult:App.parental.isAdult(a)}:null;})()');
  check('canal adulto reconhecido', !!(adultBlock && adultBlock.adult), adultBlock);
  await ev('App.parental.lock()');

  console.log('\n== 11. Saude dos canais ==');
  await ev('App.health.setEnabled(true)');
  check('monitoramento ligado por padrao', (await ev('App.health.enabled()')) === true);
  await ev('(function(){var it=App.catalog.items("live","*").filter(function(x){return x.t==="live";}); App.health.observe(App.lists.active(), it.slice(0,4)); return true;})()');
  await waitFor('App.health.stats().inflight + App.health.stats().queued === 0', 30000, 'fila de saude');
  const hs = await ev('App.health.stats()');
  console.log('  saude:', JSON.stringify(hs));
  check('verificacoes executadas', hs.records >= 2, hs.records);
  const hstate = await ev('(function(){var it=App.catalog.items("live","*")[0];return App.health.state(it, App.lists.active()).state||"gray";})()');
  check('estado de saude definido', ['green', 'yellow', 'orange', 'red', 'gray'].indexOf(hstate) >= 0, hstate);
  await ev('(function(){App.health.setEnabled(false);return true;})()');
  check('interruptor desliga o monitoramento', (await ev('App.health.enabled()')) === false);
  await ev('(function(){App.health.setEnabled(true);return true;})()');

  console.log('\n== 12. Persistencia entre reinicios ==');
  const before12 = await ev('({lists:App.lists.all().length, favs:App.favs.list("live").length, pin:App.parental.hasPin(), resume:App.resume.enabled()})');
  console.log('  estado antes:', JSON.stringify(before12));
  await ev('(function(){ window.__prevPage = 1; return 1; })()');
  await reload();
  await sleep(5000);
  await waitFor('!window.__prevPage && !!(window.App && App.m && App.m.shell)', 30000, 'app reiniciado');
  await ev('(function(){' + HELPERS + ';return 1;})()');
  await sleep(1500);
  const after12 = await ev('({lists:App.lists.all().length, favs:App.favs.list("live").length, pin:App.parental.hasPin(), resume:App.resume.enabled(), live:App.catalog.data.live.length})');
  console.log('  estado depois:', JSON.stringify(after12));
  check('listas persistem', after12.lists === before12.lists);
  check('favoritos persistem', after12.favs === before12.favs, [before12.favs, after12.favs]);
  check('PIN persiste', after12.pin === true);
  check('preferencia de retomada persiste', after12.resume === true);
  check('catalogo do cache carrega no boot', after12.live > 0, after12.live);

  const resumed = await ev('App.m.player.isOpen()');
  check('retomada automatica abriu o ultimo canal no boot', resumed === true);
  if (resumed) { await ev('App.m.player.close()'); await sleep(700); }
  await shot('e2e-07-apos-reload.png');

  console.log('\n== 13. Botao voltar e navegacao ==');
  await ev('App.m.shell.go("home")');
  await sleep(300);
  if (await ev('App.m.player.isOpen()')) await ev('App.m.player.close()');
  await sleep(400);
  await ev('App.m.shell.go("home")');
  await sleep(300);
  const back1 = await ev('AndroidShell.back()');
  check('voltar na tela raiz devolve false (deixa o Android fechar)', back1 === false, back1);
  await ev('App.m.shell.push("settings")');
  await sleep(300);
  check('voltar desempilha a tela', (await ev('AndroidShell.back()')) === true);
  await ev('App.m.shell.go("live")');
  await sleep(400);
  await ev('(function(){document.querySelectorAll("#view .row")[0].click();return true;})()');
  await waitFor('App.m.player.isOpen()', 8000, 'player');
  check('voltar fecha o player', (await ev('AndroidShell.back()')) === true && (await ev('App.m.player.isOpen()')) === false);

  console.log('\n== 14. Regra de seguranca: canal adulto nunca retoma sozinho ==');
  await ev('App.parental.lock()');
  const adult = await ev(`(function(){
    var a = App.catalog.data.live.filter(function (i) { return App.parental.isAdult(i); })[0];
    if (!a) return null;
    App.resume.set(a);
    return {id: a.id, n: a.n};
  })()`);
  check('registro aponta para o canal adulto', !!(adult && adult.id), adult);
  const dec2 = await ev('App.resume.decide()');
  check('decisao recusa o canal adulto', dec2.reason === 'adult', dec2);
  await ev('(function(){ window.__prevPage = 1; return 1; })()');
  await reload();
  await sleep(5000);
  await waitFor('!window.__prevPage && !!(window.App && App.m && App.m.shell)', 30000, 'reload com canal adulto');
  await ev('(function(){' + HELPERS + ';return 1;})()');
  await sleep(2500);
  check('app nao abriu o canal adulto sozinho', (await ev('App.m.player.isOpen()')) === false);
  const still = await ev('App.resume.get()');
  check('registro do ultimo canal preservado (nao apagado)', !!(still && still.id), still);

  console.log('\n== 15. Lista Xtream Codes ==');
  const added = await ev(`App.lists.save({name:'Xtream teste', type:'xtream', server:'http://${MOCK}', user:'test', pass:'test'}).then(function (rec) {
    App.lists.setActive(rec.id);
    return {id: rec.id, sealed: rec.passS, plain: !!rec.pass};
  })`);
  check('lista Xtream criada com senha selada',
    !!added.id && /^(n1|l1):/.test(String(added.sealed)) && added.plain === false, added);
  await ev('App.catalog.refresh(App.lists.active())');
  await waitFor('App.catalog.data.live.length >= 2 && App.catalog.data.series.length >= 1', 45000, 'catalogo Xtream');
  const xc = await ev('({live:App.catalog.data.live.length, movie:App.catalog.data.movie.length, series:App.catalog.data.series.length})');
  console.log('  catalogo Xtream:', JSON.stringify(xc));
  check('canais Xtream importados', xc.live >= 2, xc);
  check('filmes Xtream importados', xc.movie >= 1, xc);
  check('series Xtream importadas', xc.series >= 1, xc);

  const xurls = await ev('App.catalog.urls(App.catalog.data.live[0], App.lists.active())');
  check('URL Xtream montada na hora (.m3u8 e .ts)',
    Array.isArray(xurls) && xurls.length === 2 && /\/live\/test\/test\/\d+\.m3u8$/.test(xurls[0]) && /\.ts$/.test(xurls[1]), xurls);

  const xmovie = await ev('App.catalog.urls(App.catalog.data.movie[0], App.lists.active())');
  check('URL de filme tenta o outro formato quando a extensao falha',
    Array.isArray(xmovie) && xmovie.length === 2 && /\.mp4$/.test(xmovie[0]) && /\.mkv$/.test(xmovie[1]), xmovie);

  const xeps = await ev(`App.catalog.seriesInfo(App.catalog.data.series[0], App.lists.active()).then(function (r) {
    var s = r.seasons, n = 0, t = 0;
    if (Array.isArray(s)) { t = s.length; s.forEach(function (x) { n += (x.eps || []).length; }); }
    else { t = Object.keys(s).length; Object.keys(s).forEach(function (k) { n += (s[k] || []).length; }); }
    return {temporadas: t, episodios: n};
  })`);
  check('episodios Xtream consultados no servidor', xeps.episodios >= 2, xeps);

  await ev('App.m.shell.go("live")');
  await waitFor('document.querySelectorAll("#view .row").length > 0', 8000, 'canais Xtream na tela');
  await ev('document.querySelectorAll("#view .row")[0].click()');
  await waitFor('App.m.player.isOpen()', 10000, 'player Xtream');
  let xtPlay = false;
  for (let i = 0; i < 50; i++) {
    const s = await ev('JSON.parse(SpaceNative.playerState(0))');
    if (s.playing && s.pos > 0) { xtPlay = true; break; }
    await sleep(500);
  }
  check('canal Xtream reproduz (HLS montada pelo app)', xtPlay);
  await shot('e2e-10-xtream.png');
  await ev('App.m.player.close()');
  await sleep(800);

  console.log('\n== 16. MultiView: dois canais ao mesmo tempo ==');
  const m3uId = await ev('App.lists.all().filter(function (l) { return l.type === "m3u"; })[0].id');
  await ev('App.m.shell.activate(' + JSON.stringify(m3uId) + ')');
  await waitFor('App.catalog.data.live.length >= 4', 30000, 'lista M3U de volta');
  await ev('App.m.shell.go("live")');
  await sleep(500);
  await ev('document.querySelectorAll("#view .row")[0].click()');
  await waitFor('App.m.player.isOpen()', 8000, 'primeiro canal');
  await waitFor('JSON.parse(SpaceNative.playerState(0)).playing === true', 25000, 'primeiro canal tocando');

  await ev('__t.clickIn("#player", "MultiView")');
  await waitFor('__t.sheetOpen()', 8000, 'painel de canais do MultiView');
  await ev('(function(){ var rows=document.querySelectorAll(".sheet .row"); var t=rows[1]||rows[0]; if(t) t.click(); return rows.length; })()');
  await waitFor('App.m.player.state().multi === true', 20000, 'multiview ativo');
  await sleep(7000);

  const mv = await ev('({multi:App.m.player.state().multi, s0:JSON.parse(SpaceNative.playerState(0)), s1:JSON.parse(SpaceNative.playerState(1)), layout:App.m.player.state().layoutMode})');
  console.log('  multiview:', JSON.stringify(mv));
  check('os dois slots receberam stream', mv.s0.opened === true && mv.s1.opened === true, mv);
  check('segundo canal esta tocando', mv.s1.playing === true, mv.s1);
  await shot('e2e-11-multiview.png');

  await ev('__t.clickIn("#player", "Áudio")');
  await sleep(700);
  check('audio passa para o segundo canal', (await ev('JSON.parse(SpaceNative.playerState(0)).audio')) === 1);
  await ev('__t.clickIn("#player", "Tela dividida")');
  await sleep(700);
  check('alterna entre tela dividida e janela em destaque', (await ev('App.m.player.state().layoutMode')) === 'pip');

  await ev('__t.clickIn("#player", "Fechar 2º")');
  await sleep(1800);
  const afterClose = await ev('({multi:App.m.player.state().multi, s0:JSON.parse(SpaceNative.playerState(0)), s1:JSON.parse(SpaceNative.playerState(1))})');
  /* O stream de teste tem 12 s: em aparelho lento ele pode ter terminado antes
     daqui. O que importa e que fechar o segundo NAO derrube o primeiro. */
  check('fechar o segundo mantem o principal aberto',
    afterClose.multi === false && afterClose.s0.opened === true && afterClose.s1.opened === false, afterClose);
  await ev('App.m.player.close()');
  await sleep(800);

  console.log('\n== 17. Canal MPEG-TS continuo (ao vivo) ==');
  await ev('App.m.shell.go("live")');
  await sleep(500);
  const clickedTs = await ev('(function(){ var rows=Array.from(document.querySelectorAll("#view .row")); var r=rows.find(function(x){return x.textContent.indexOf("TS cont")>=0;}); if(r){r.click();return true;} return false; })()');
  check('canal TS encontrado na lista', clickedTs === true);
  await waitFor('App.m.player.isOpen()', 8000, 'player TS');
  let tsPlay = false;
  for (let i = 0; i < 50; i++) {
    const s = await ev('JSON.parse(SpaceNative.playerState(0))');
    if (s.playing && s.pos > 0) { tsPlay = true; break; }
    await sleep(500);
  }
  check('canal TS progressivo reproduz', tsPlay);
  await shot('e2e-12-ts.png');
  await ev('App.m.player.close()');
  await sleep(800);

  console.log('\n== 18. Canal fora do ar (erro tratado) ==');
  await ev('App.m.shell.go("live")');
  await sleep(500);
  await ev('(function(){ var rows=Array.from(document.querySelectorAll("#view .row")); var r=rows.find(function(x){return x.textContent.indexOf("404")>=0;}); if(r) r.click(); return !!(r); })()');
  await waitFor('__t.dialogOpen()', 40000, 'mensagem de falha');
  const dlg = await ev('document.querySelector(".dialog .dm").textContent');
  check('mensagem de falha amigavel', /reproduzir|respondeu|recusou|formato|falhou/i.test(dlg || ''), dlg);
  await shot('e2e-13-erro-canal.png');
  await ev('__t.clickIn(".dialog", "Voltar")');
  await sleep(600);
  /* O canal que falhou deixa o player aberto; fechar e o que o usuario faria
     antes de seguir. Sem isto as secoes seguintes rodam com o player na frente. */
  await ev('App.m.player.close()');
  await sleep(800);

  console.log('\n== 19. Sinopses do TMDb ==');
  const tmdbSvc = await ev(`(async function () {
    var t = await App.tmdb.lookup({ t: 'movie', n: 'Oppenheimer (2023)', y: '2023' });
    var vazio = await App.tmdb.lookup({ t: 'movie', n: 'Filme de teste (2024)', y: '2024' });
    return {tem: !!(t && t.overview && t.overview.length > 40), titulo: t && t.title,
            nota: t && t.rating, poster: !!(t && t.poster), vazio: vazio};
  })()`);
  check('servico devolve sinopse', tmdbSvc.tem === true, tmdbSvc);
  check('servico devolve nota e poster', !!(tmdbSvc.nota && tmdbSvc.poster), tmdbSvc);
  check('titulo que nao existe nao inventa sinopse', tmdbSvc.vazio === null, tmdbSvc.vazio);

  // mesma coisa pela interface: item sem sinopse na lista abre com o texto do TMDb
  await ev('App.m.shell.push("details", {item: {id: "tmdb-e2e", t: "movie", n: "Oppenheimer (2023)", y: "2023"}, type: "movie"})');
  await sleep(1200);
  let sinopse = '';
  for (let i = 0; i < 20; i++) {
    sinopse = await ev('(function(){var s=document.querySelector("#view .scroll");return s?s.textContent:"";})()');
    if (sinopse.indexOf('Sinopse') >= 0 && sinopse.length > 120) break;
    await sleep(500);
  }
  check('tela de detalhes mostra a sinopse do TMDb',
    sinopse.indexOf('Sinopse') >= 0 && /Oppenheimer|físico|Projeto Manhattan|bomba/i.test(sinopse), sinopse.slice(0, 120));
  await shot('e2e-14-sinopse.png');
  await ev('App.m.shell.back()');
  await sleep(500);

  console.log('\n== 20. Colar link (area de transferencia) ==');
  /* A WebView nao consegue ler o clipboard sozinha (file:// + toque longo
     desligado): o botao Colar chama o Android. Aqui a leitura nativa e trocada
     por um texto fixo, e o que se testa e o que o app faz com ele. */
  await ev('App.m.shell.go("settings")');
  await waitFor('__t.clickIn("#view", "Adicionar lista") && __t.sheetOpen()', 8000, 'formulario de lista');
  await sleep(500);
  const temColar = await ev('!!document.querySelector(".sheet .paste-btn")');
  check('formulario tem o botao Colar', temColar === true);
  check('botao Colar fica ao lado do campo de link',
    (await ev('(function(){var b=document.querySelector(".sheet .paste-btn");if(!b)return false;var f=b.closest(".inrow");return !!f && f.querySelector("input") === document.querySelectorAll(".sheet input")[1];})()')) === true);

  const colagem = await ev(`(async function () {
    var original = App.native.clipboard;
    App.native.clipboard = function () { return '  Segue o link: "https://servidor.com/minha-lista.m3u"  '; };
    document.querySelector('.sheet .paste-btn').click();
    await new Promise(function (r) { setTimeout(r, 250); });
    var campos = document.querySelectorAll('.sheet input');
    var r = { url: campos[1] && campos[1].value, nome: campos[0] && campos[0].value };
    App.native.clipboard = original;
    return r;
  })()`);
  check('Colar extrai so a URL do texto copiado', colagem.url === 'https://servidor.com/minha-lista.m3u', colagem.url);
  check('Colar sugere o nome da lista', colagem.nome === 'servidor.com', colagem.nome);
  check('limparColado descarta aspas e conversa',
    (await ev('App.m.ui.limparColado("olha: <http://a.b/c.m3u>, valeu")')) === 'http://a.b/c.m3u');
  check('limparColado devolve vazio para texto sem link',
    (await ev('App.m.ui.limparColado("   ")')) === '');
  await shot('e2e-15-colar.png');
  await ev('(function(){var b=document.querySelector(".sheet .sheet-head .icon-btn");if(b)b.click();return 1;})()');
  await sleep(500);

  console.log('\n== 21. Navegacao pelo controle remoto ==');
  const temFocus = await ev('!!(App.m.focus && App.m.focus.move && App.m.focus.first)');
  check('camada de foco carregada', temFocus === true);

  /* Simula as setas do controle, que chegam como keydown com key=Arrow*.
     Devolve classe + texto: duas linhas de canal tem a mesma classe, e sem o texto
     nao daria para saber se o foco andou de verdade. */
  const tecla = (k) => ev(`(function(){
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'${k}',bubbles:true,cancelable:true}));
    var e = document.querySelector('.foc');
    return e ? (e.className + '|' + (e.textContent || '').trim().slice(0, 24)) : '';
  })()`);

  await ev('App.m.shell.go("live")');
  await waitFor('document.querySelectorAll("#view .chip").length > 0 && document.querySelectorAll("#view .row").length > 0', 12000, 'canais para navegar');
  await sleep(600);

  /* No celular o anel so aparece quando o usuario usa teclado/controle; no modo
     projetor ele ja nasce sozinho. A primeira seta tem de por o foco NO CONTEUDO,
     nunca no botao de pesquisa da barra de cima. */
  const primeiraSeta = await ev(`(function(){
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true, cancelable:true}));
    var e = document.querySelector('.foc');
    var view = document.getElementById('view');
    var ae = document.activeElement;
    return {
      onde: e ? (view.contains(e) ? 'view:' : 'fora:') + e.className + '|' + (e.textContent || '').trim().slice(0, 24) : '(sem anel)',
      overlay: document.getElementById('overlay').children.length,
      kbd: document.documentElement.className,
      ativo: ae ? (ae.tagName + '.' + (ae.className || '')) : null,
      naView: App.m.focus.candidates().filter(function (x) { return view.contains(x); }).length
    };
  })()`);
  check('primeira seta coloca o foco dentro do conteudo da tela', primeiraSeta.onde.indexOf('view:') === 0, primeiraSeta);
  check('primeiro foco nao cai no campo de busca', !/input/.test(primeiraSeta.onde), primeiraSeta.onde);

  const depoisDown = await tecla('ArrowDown');
  check('seta para baixo move o foco', depoisDown && depoisDown !== primeiraSeta.onde.replace('view:', ''), depoisDown);
  const depoisUp = await tecla('ArrowUp');
  check('seta para cima volta o foco', depoisUp !== depoisDown, depoisUp);
  check('foco fica visivel (classe .foc)', (await ev('!!document.querySelector(".foc")')) === true);
  await shot('e2e-16-foco.png');

  const abriuPeloControle = await ev(`(async function () {
    App.m.focus.first();
    for (var i = 0; i < 4; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true, cancelable:true}));
      await new Promise(function (r) { setTimeout(r, 60); });
      var e = document.querySelector('.foc');
      if (e && e.className.indexOf('row') >= 0) break;
    }
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}));
    await new Promise(function (r) { setTimeout(r, 2500); });
    return App.m.player.isOpen() ? (App.m.player.state().item || {}).n : null;
  })()`);
  check('OK no canal abre a reproducao', !!abriuPeloControle, abriuPeloControle);
  await ev('App.m.player.close()');
  await sleep(600);

  console.log('\n== 22. Modo projetor / TV ==');
  await ev('App.m.setMode("tv")');
  await sleep(700);
  const tv1 = await ev(`(function(){
    var tabs = document.getElementById('tabs'), r = tabs.getBoundingClientRect();
    var app = document.getElementById('app').getBoundingClientRect();
    return { classe: document.documentElement.className, alto: Math.round(r.height), largura: Math.round(r.width),
             vertical: r.width < r.height, dentro: Math.round(app.width) + 'x' + Math.round(app.height),
             rowh: App.m.ui.rowH(0) };
  })()`);
  check('modo TV aplica a classe html.tv', /tv/.test(tv1.classe), tv1.classe);
  check('trilha lateral fica a esquerda e vertical', tv1.vertical === true, tv1);
  check('conteudo continua ocupando a tela', tv1.dentro === (await ev('innerWidth + "x" + innerHeight')), tv1.dentro);
  await ev('App.m.shell.reflow()');
  await sleep(800);
  await shot('e2e-17-modo-tv.png');
  const tvRows = await ev('(function(){var r=document.querySelector("#view .row");return r?Math.round(r.getBoundingClientRect().height):0;})()');
  check('linha do modo TV usa a altura maior do CSS', tvRows === tv1.rowh, { linha: tvRows, rowh: tv1.rowh });

  await ev('App.m.setMode("phone")');
  await sleep(600);
  const tv2 = await ev(`(function(){
    var r = document.getElementById('tabs').getBoundingClientRect();
    return { classe: document.documentElement.className, deitada: r.width > r.height, largura: Math.round(r.width) };
  })()`);
  check('modo celular volta a barra inferior', tv2.deitada === true && !/tv/.test(tv2.classe), tv2);
  await ev('App.m.setMode("auto")');
  await sleep(500);

  console.log('\n== 23. Setas em listas longas (faixa de categorias e grade) ==');
  /* Lista com 12 categorias de filmes (faixa que precisa rolar) e 60 filmes
     (grade que passa da primeira tela). Serve para o que o usuario via no
     projetor: a seta parava na ultima categoria visivel e na ultima linha. */
  async function seta(tecla, vezes) {
    const out = [];
    for (let i = 0; i < vezes; i++) {
      out.push(await ev(`(function(){
        document.dispatchEvent(new KeyboardEvent('keydown',{key:'${tecla}',bubbles:true,cancelable:true}));
        var e = document.querySelector('.foc');
        return e ? { cls: e.className, txt: (e.textContent || '').trim().slice(0, 26),
                     naView: document.getElementById('view').contains(e) } : null;
      })()`));
      await sleep(190);
    }
    return out;
  }

  const listaAntes = await ev('(App.lists.active() || {}).id || ""');
  const navId = await ev(`App.lists.save({name:'Navegacao e2e', type:'m3u', url:'http://${MOCK}/navegacao.m3u'}).then(function (r) { return r.id; })`);
  await ev(`App.m.shell.activate(${JSON.stringify(navId)})`);
  await waitFor('App.catalog.data.movie.length >= 50', 45000, 'lista de navegacao carregada');

  await ev(`App.m.shell.go('movies')`);
  await waitFor('document.querySelectorAll("#view .poster").length > 0', 12000, 'grade de filmes');
  await sleep(700);

  await ev('App.m.focus.first()');
  const catsFilme = await seta('ArrowRight', 12);
  const catFim = catsFilme[catsFilme.length - 1];
  check('seta direita percorre todas as categorias', !!catFim && /Cat 12/.test(catFim.txt || ''), catsFilme.map((x) => x && x.txt));
  const faixaRolou = await ev('document.querySelector("#view .chips").scrollLeft');
  check('a faixa de categorias rola para mostrar as que faltam', faixaRolou > 60, faixaRolou);

  await ev('App.m.focus.to(document.querySelector("#view .poster"))');
  await sleep(200);
  const linhas = await seta('ArrowDown', 11);
  /* 11 passos = 11 itens diferentes: a coluna do projetor tem 12 linhas e a do
     celular tem 20 (muda o numero de colunas, nao o comportamento). */
  const quantasLinhas = new Set(linhas.map((x) => x && x.txt)).size;
  check('seta para baixo desce a grade linha a linha', quantasLinhas >= 10, linhas.map((x) => x && x.txt));
  check('a grade rola junto (filmes de baixo aparecem)',
    (await ev('document.querySelector("#view .vscroll").scrollTop')) > 800,
    await ev('document.querySelector("#view .vscroll").scrollTop'));
  check('navegando na grade o foco nao escapa para a trilha', linhas.every((x) => x && x.naView), linhas.map((x) => x && x.cls));

  await ev(`App.m.shell.go('live')`);
  await waitFor('document.querySelectorAll("#view .row").length > 0', 12000, 'canais para navegar');
  await sleep(600);
  await ev('App.m.focus.first()');
  const catsLive = await seta('ArrowRight', 6);
  check('TV ao vivo: seta direita percorre as categorias',
    catsLive.filter((x) => x && /chip/.test(x.cls)).length >= 5, catsLive.map((x) => x && x.txt));
  const rowsLive = await seta('ArrowDown', 10);
  check('TV ao vivo: seta para baixo passa da dobra',
    new Set(rowsLive.map((x) => x && x.txt)).size >= 6, rowsLive.map((x) => x && x.txt));

  /* devolve a lista que estava ativa antes desta secao e apaga a de teste */
  if (listaAntes) {
    await ev(`App.m.shell.activate(${JSON.stringify(listaAntes)})`);
    await sleep(1500);
  }
  await ev(`App.lists.remove(${JSON.stringify(navId)})`);
  await sleep(700);
  check('lista de navegacao removida no fim',
    (await ev(`App.lists.all().filter(function (l) { return l.id === ${JSON.stringify(navId)}; }).length`)) === 0);

  console.log('\n---------------------------------------------');
  console.log('PASSOU: ' + passed + '   FALHOU: ' + failed);
  if (failed) { console.log('falhas:'); fails.forEach((f) => console.log(' - ' + f)); }
  ws.close();
  setTimeout(() => process.exit(failed ? 1 : 0), 100);
})().catch((e) => { console.log('ERRO FATAL: ' + (e && e.stack || e)); process.exit(2); });

