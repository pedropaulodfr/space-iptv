/* Monitor de conectividade do processo principal.
 *
 * A tela reage sozinha a navigator.onLine, mas o main também precisa saber se o
 * backend está alcançável para: (a) avisar o renderer na bandeja/HUD, (b) evitar
 * auto-update inútil offline. Sonda barata em `GET <apiOrigin>/api/auth/capabilities`
 * (rota pública, sem cookie) e avisa só quando o estado MUDA.
 *
 * Sem `electron`, sem log de URL/credenciais.
 */
'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_INTERVAL_MS = 45000;
const DEFAULT_TIMEOUT_MS = 6000;

/**
 * @param {object} opts
 * @param {string} opts.apiOrigin
 * @param {number} [opts.intervalMs]
 * @param {number} [opts.timeoutMs]
 * @param {function({online:boolean, reason:string})} [opts.onChange]
 */
function createNetStatus(opts) {
  opts = opts || {};
  const apiOrigin = String(opts.apiOrigin || '');
  const intervalMs = Number(opts.intervalMs) > 0 ? Number(opts.intervalMs) : DEFAULT_INTERVAL_MS;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : null;

  let timer = null;
  let probing = null;
  let last = null;
  let stopped = true;

  /* Resolve true se QUALQUER resposta HTTP chegou (o servidor está de pé);
     false só quando a conexão falha de verdade. */
  function probe() {
    if (probing) return probing;
    if (!apiOrigin) {
      probing = Promise.resolve({ online: false, reason: 'not_configured' });
      return probing.then(function (r) { probing = null; return r; });
    }
    let target;
    try { target = new URL(apiOrigin); } catch (e) { target = null; }
    if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
      probing = Promise.resolve({ online: false, reason: 'invalid_origin' });
      return probing.then(function (r) { probing = null; return r; });
    }
    const lib = target.protocol === 'https:' ? https : http;
    probing = new Promise(function (resolve) {
      let done = false;
      function finish(result) {
        if (done) return;
        done = true;
        resolve(result);
      }
      let req;
      try {
        req = lib.request({
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: '/api/auth/capabilities',
          method: 'GET',
          headers: { 'user-agent': 'SpaceIPTV-Desktop', 'accept': 'application/json' },
          timeout: timeoutMs
        });
      } catch (e) {
        finish({ online: false, reason: 'request_failed' });
        return;
      }
      req.setTimeout(timeoutMs, function () {
        try { req.destroy(new Error('timeout')); } catch (e) { /* ignore */ }
      });
      req.on('response', function (res) {
        try { res.resume(); } catch (e) { /* ignore */ }
        /* qualquer status HTTP = servidor alcançável */
        finish({ online: true, reason: 'reachable', status: res.statusCode });
      });
      req.on('error', function (err) {
        const code = err && (err.code || err.message) || 'error';
        finish({ online: false, reason: String(code) });
      });
      req.end();
    }).then(function (result) {
      probing = null;
      return result;
    });
    return probing;
  }

  function apply(result) {
    if (!result) return;
    const online = result.online === true;
    if (last != null && last.online === online) return;
    last = { online: online, reason: result.reason || '' };
    if (onChange) { try { onChange(last); } catch (e) { /* ignore */ } }
  }

  function checkNow() {
    return probe().then(apply, function () { return null; });
  }

  function start() {
    if (!stopped) return;
    stopped = false;
    checkNow();
    timer = setInterval(function () { checkNow(); }, intervalMs);
    if (timer.unref) timer.unref();
  }

  function stop() {
    stopped = true;
    if (timer) { clearInterval(timer); timer = null; }
  }

  return {
    start: start,
    stop: stop,
    checkNow: checkNow,
    state: function () { return last ? { online: last.online, reason: last.reason } : null; }
  };
}

module.exports = { createNetStatus: createNetStatus };
