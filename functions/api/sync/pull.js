/* GET /api/sync/pull — tudo o que o usuário tem na nuvem, em UMA transação.
 *
 * O isolamento é do banco: a transação roda com app.uid e app.role = 'user', e
 * as policies de RLS filtram por user_id. O catálogo (canais/filmes/séries) não
 * trafega aqui: ele é derivado da lista e continua no IndexedDB do aparelho. */

import { fail, json, methodNotAllowed, defaultMessage } from '../../_lib/http.js';
import { tx, errorCode, asJson, asBool, asInt } from '../../_lib/db.js';

const FAV_MAX = 5000;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET') return methodNotAllowed('GET');

  const authData = (context.data && context.data.auth) || null;
  if (!authData || !authData.payload) {
    return fail('unauthorized', 'Sessão expirada. Entre de novo.');
  }

  const uid = authData.payload.u;

  try {
    const results = await tx(env, { uid: uid, role: 'user' }, [
      { query: 'select id, name, kind, server, xtream_user, is_active, last_error, created_at, updated_at from playlists order by created_at asc' },
      { query: 'select playlist_id, m3u_url, xtream_pass, updated_at from playlist_secrets' },
      { query: 'select playlist_id, kind, item_id, title, created_at from favorites order by created_at asc limit ' + (FAV_MAX + 1) },
      { query: 'select playlist_id, kind, item_id, title, ep, pos, dur, watched_at from history order by watched_at desc limit 200' },
      { query: 'select resume_last, health_check, last_channel, parental_enabled, parental_pin_hash, parental_pin_salt, updated_at from user_prefs' }
    ]);

    const playlists = (results[0] && results[0].rows) || [];
    const secrets = (results[1] && results[1].rows) || [];
    const favorites = (results[2] && results[2].rows) || [];
    const history = (results[3] && results[3].rows) || [];
    const prefsRows = (results[4] && results[4].rows) || [];

    const truncated = favorites.length > FAV_MAX;
    const payload = {
      serverTime: new Date().toISOString(),
      playlists: playlists.map(function (p) {
        return {
          id: p.id,
          name: p.name,
          kind: p.kind,
          server: p.server || '',
          xtream_user: p.xtream_user || '',
          is_active: asBool(p.is_active),
          last_error: p.last_error || '',
          created_at: p.created_at,
          updated_at: p.updated_at
        };
      }),
      secrets: secrets,
      favorites: truncated ? favorites.slice(0, FAV_MAX) : favorites,
      history: history.map(function (h) {
        return {
          playlist_id: h.playlist_id,
          kind: h.kind,
          item_id: h.item_id,
          title: h.title || '',
          ep: asJson(h.ep),
          pos: asInt(h.pos),
          dur: asInt(h.dur),
          watched_at: h.watched_at
        };
      }),
      prefs: prefsRows.length ? {
        resume_last: asBool(prefsRows[0].resume_last),
        health_check: asBool(prefsRows[0].health_check),
        last_channel: asJson(prefsRows[0].last_channel),
        parental_enabled: asBool(prefsRows[0].parental_enabled),
        parental_pin_hash: prefsRows[0].parental_pin_hash || null,
        parental_pin_salt: prefsRows[0].parental_pin_salt || null,
        updated_at: prefsRows[0].updated_at
      } : null
    };
    if (truncated) payload.favoritesTruncated = true;

    return json(payload);
  } catch (e) {
    if (e && e.code === 'not_configured') return fail('not_configured', defaultMessage('not_configured'));
    return fail('upstream_error', 'Não foi possível carregar seus dados agora. Tente de novo.');
  }
}
