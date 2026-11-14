/* POST /api/sync/push — aplica um lote de operações em UMA transação.
 *
 * Contrato: { ops: [{table, op:"upsert"|"delete", row|key}] }, no máximo 200.
 *
 * Regras:
 *   - `table` na lista branca e colunas conhecidas (campo desconhecido é 400);
 *   - `user_id` NUNCA vem do corpo: o da sessão é usado em todas as linhas, e a
 *     RLS ainda barra qualquer linha de outro dono;
 *   - playlist vence pelo `updated_at` mais novo; o perdedor volta em `conflicts`;
 *   - `is_active` passa pela RPC `set_active_playlist` (índice único parcial);
 *   - o lote inteiro é atômico: erro no meio não deixa metade gravada.
 */

import { fail, defaultMessage } from '../../_lib/http.js';
import { tx, errorCode } from '../../_lib/db.js';

const MAX_OPS = 200;

const TABLES = {
  playlists: ['id', 'name', 'kind', 'server', 'xtream_user', 'is_active', 'last_error', 'created_at', 'updated_at'],
  playlist_secrets: ['playlist_id', 'm3u_url', 'xtream_pass', 'updated_at'],
  favorites: ['playlist_id', 'kind', 'item_id', 'title', 'created_at'],
  history: ['playlist_id', 'kind', 'item_id', 'title', 'ep', 'pos', 'dur', 'watched_at'],
  user_prefs: ['resume_last', 'health_check', 'last_channel', 'parental_enabled', 'parental_pin_hash', 'parental_pin_salt', 'updated_at']
};

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function badRequest(message) {
  return fail('invalid_input', message || defaultMessage('invalid_input'));
}

function isoOrNow(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
}

function normalizeRow(table, raw) {
  const allowed = TABLES[table];
  const out = {};
  for (const key in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
    if (allowed.indexOf(key) < 0) return null;
    out[key] = raw[key];
  }
  return out;
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed', message: 'Método não permitido.' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST', 'Cache-Control': 'no-store' }
    });
  }

  const authData = (context.data && context.data.auth) || null;
  if (!authData || !authData.payload) return fail('unauthorized', 'Sessão expirada. Entre de novo.');
  const uid = authData.payload.u;

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return badRequest('Corpo da requisição inválido.');
  }
  if (!isPlainObject(payload) || !Array.isArray(payload.ops)) return badRequest('Envie { ops: [...] }.');
  if (payload.ops.length > MAX_OPS) {
    return fail('invalid_input', 'Envie no máximo ' + MAX_OPS + ' operações por vez.', 413);
  }

  /* ---------- validação ---------- */
  const ops = [];
  for (let i = 0; i < payload.ops.length; i++) {
    const op = payload.ops[i];
    if (!isPlainObject(op)) return badRequest('Operação inválida.');
    const table = String(op.table || '');
    if (!TABLES[table]) return badRequest('Tabela não permitida: ' + table + '.');
    const kind = String(op.op || '');
    if (kind === 'upsert') {
      if (!isPlainObject(op.row)) return badRequest('Falta a linha da operação.');
      const row = normalizeRow(table, op.row);
      if (!row) return badRequest('A linha tem campo não permitido em ' + table + '.');
      ops.push({ table: table, op: kind, row: row });
    } else if (kind === 'delete') {
      if (!isPlainObject(op.key)) return badRequest('Falta a chave da exclusão.');
      ops.push({ table: table, op: kind, key: op.key });
    } else {
      return badRequest('Operação desconhecida.');
    }
  }

  const statements = [];
  const conflicts = [];
  let applied = 0;

  /* ---------- playlists (upsert com detecção de conflito) ---------- */
  const playlistUpserts = ops.filter(function (o) { return o.table === 'playlists' && o.op === 'upsert'; });
  const playlistIds = [];
  const activations = [];

  playlistUpserts.forEach(function (o) {
    const r = o.row;
    if (!r.id) throw new Error('missing_playlist_id');
    const wantsActive = r.is_active === true;
    if (wantsActive) activations.push(r.id);
    playlistIds.push(r.id);
    statements.push({
      query:
        'insert into playlists (id, user_id, name, kind, server, xtream_user, is_active, last_error, created_at, updated_at) ' +
        'values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ' +
        'on conflict (user_id, id) do update set name = excluded.name, kind = excluded.kind, ' +
        'server = excluded.server, xtream_user = excluded.xtream_user, is_active = excluded.is_active, ' +
        'last_error = excluded.last_error, updated_at = excluded.updated_at ' +
        'where excluded.updated_at >= playlists.updated_at ' +
        'returning id',
      params: [r.id, uid, r.name || 'Lista', r.kind === 'xtream' ? 'xtream' : 'm3u', r.server || '',
        r.xtream_user || '', false, r.last_error || '', isoOrNow(r.created_at), isoOrNow(r.updated_at)]
    });
  });
  if (playlistUpserts.length) applied += playlistUpserts.length;

  /* ---------- demais upserts ---------- */
  ops.forEach(function (o) {
    if (o.op !== 'upsert' || o.table === 'playlists') return;
    const r = o.row;
    if (o.table === 'playlist_secrets') {
      if (!r.playlist_id) throw new Error('missing_playlist_id');
      statements.push({
        query:
          'insert into playlist_secrets (playlist_id, user_id, m3u_url, xtream_pass, updated_at) values ($1,$2,$3,$4,$5) ' +
          'on conflict (playlist_id) do update set m3u_url = excluded.m3u_url, xtream_pass = excluded.xtream_pass, ' +
          'updated_at = excluded.updated_at where playlist_secrets.user_id = $2',
        params: [r.playlist_id, uid, r.m3u_url || '', r.xtream_pass || '', isoOrNow(r.updated_at)]
      });
    } else if (o.table === 'favorites') {
      statements.push({
        query:
          'insert into favorites (user_id, playlist_id, kind, item_id, title, created_at) values ($1,$2,$3,$4,$5,$6) ' +
          'on conflict (user_id, playlist_id, kind, item_id) do update set title = excluded.title',
        params: [uid, r.playlist_id, r.kind, String(r.item_id), r.title || '', isoOrNow(r.created_at)]
      });
    } else if (o.table === 'history') {
      statements.push({
        query:
          'insert into history (user_id, playlist_id, kind, item_id, title, ep, pos, dur, watched_at) ' +
          'values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) ' +
          'on conflict (user_id, playlist_id, kind, item_id) do update set title = excluded.title, ep = excluded.ep, ' +
          'pos = excluded.pos, dur = excluded.dur, watched_at = excluded.watched_at',
        params: [uid, r.playlist_id, r.kind, String(r.item_id), r.title || '',
          r.ep == null ? null : JSON.stringify(r.ep), Math.max(0, Number(r.pos) || 0),
          Math.max(0, Number(r.dur) || 0), isoOrNow(r.watched_at)]
      });
    } else if (o.table === 'user_prefs') {
      statements.push({
        query:
          'insert into user_prefs (user_id, resume_last, health_check, last_channel, parental_enabled, ' +
          'parental_pin_hash, parental_pin_salt, updated_at) values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) ' +
          'on conflict (user_id) do update set resume_last = excluded.resume_last, health_check = excluded.health_check, ' +
          'last_channel = excluded.last_channel, parental_enabled = excluded.parental_enabled, ' +
          'parental_pin_hash = excluded.parental_pin_hash, parental_pin_salt = excluded.parental_pin_salt, ' +
          'updated_at = excluded.updated_at',
        params: [uid, r.resume_last === true, r.health_check !== false,
          r.last_channel == null ? null : JSON.stringify(r.last_channel), r.parental_enabled === true,
          r.parental_pin_hash || null, r.parental_pin_salt || null, isoOrNow(r.updated_at)]
      });
    }
    applied += 1;
  });

  /* ---------- exclusões ---------- */
  ops.filter(function (o) { return o.op === 'delete'; }).forEach(function (o) {
    const k = o.key || {};
    if (o.table === 'playlists') {
      statements.push({ query: 'delete from playlists where id = $1', params: [k.id] });
    } else if (o.table === 'playlist_secrets') {
      statements.push({ query: 'delete from playlist_secrets where playlist_id = $1', params: [k.playlist_id] });
    } else if (o.table === 'favorites') {
      statements.push({
        query: 'delete from favorites where playlist_id = $1 and kind = $2 and item_id = $3',
        params: [k.playlist_id, k.kind, String(k.item_id)]
      });
    } else if (o.table === 'history') {
      statements.push({
        query: 'delete from history where playlist_id = $1 and kind = $2 and item_id = $3',
        params: [k.playlist_id, k.kind, String(k.item_id)]
      });
    } else if (o.table === 'user_prefs') {
      statements.push({ query: 'delete from user_prefs where user_id = $1', params: [uid] });
    }
    applied += 1;
  });

  /* ---------- ativação transacional ---------- */
  activations.forEach(function (id) {
    statements.push({ query: 'select public.set_active_playlist($1) as ok', params: [id] });
  });

  if (!statements.length) {
    return new Response(JSON.stringify({ applied: 0, conflicts: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Cookie' }
    });
  }

  try {
    const results = await tx(env, { uid: uid, role: 'user' }, statements);

    /* Quais playlists não voltaram? São as que perderam para o servidor. */
    if (playlistUpserts.length) {
      const returned = {};
      for (let i = 0; i < playlistUpserts.length; i++) {
        const res = results[i];
        const row = res && res.rows && res.rows[0];
        if (row && row.id) returned[row.id] = true;
      }
      const missing = playlistIds.filter(function (id) { return !returned[id]; });
      if (missing.length) {
        const server = await tx(env, { uid: uid, role: 'user' }, [{
          query: 'select id, name, kind, server, xtream_user, is_active, last_error, created_at, updated_at ' +
            'from playlists where id = any($1::uuid[])',
          params: ['{' + missing.join(',') + '}']
        }]);
        const rows = (server[0] && server[0].rows) || [];
        rows.forEach(function (r) {
          conflicts.push({ table: 'playlists', key: { id: r.id }, serverRow: r });
          applied -= 1;
        });
      }
    }

    return new Response(JSON.stringify({ applied: Math.max(0, applied), conflicts: conflicts }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Vary': 'Cookie' }
    });
  } catch (e) {
    const code = errorCode(e);
    if (code === 'invalid_input') return badRequest('Os dados não respeitam as regras do banco.');
    if (code === 'conflict') return fail('conflict', 'A operação conflita com o estado atual.', 409);
    if (e && e.message === 'missing_playlist_id') return badRequest('Playlist sem id.');
    return fail('upstream_error', 'Não foi possível salvar agora. Tente de novo.');
  }
}
