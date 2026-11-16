/* Nomes de canais IPC do Space IPTV Desktop — contrato único main/preload.
 *
 * Só o processo principal e o preload importam este arquivo (CommonJS).
 * O renderer nunca vê estes nomes: usa `window.space.*` exposto pelo preload.
 * Não renomeie um canal sem atualizar o CONTRACTS.md e os dois lados.
 */
'use strict';

module.exports = {
  /* app */
  APP_INFO: 'space:app:info',
  APP_VERSION: 'space:app:version',
  APP_QUIT: 'space:app:quit',
  APP_MINIMIZE: 'space:app:minimize',
  APP_HIDE_TO_TRAY: 'space:app:hide-to-tray',

  /* arquivos (somente leitura do que o usuário escolher no dialog nativo) */
  FILES_PICK_M3U: 'space:files:pick-m3u',

  /* configuração */
  CONFIG_GET: 'space:config:get',
  CONFIG_SET: 'space:config:set',
  CONFIG_PICK_FOLDER: 'space:config:pick-folder',
  CONFIG_VALIDATE_DIR: 'space:config:validate-dir',

  /* sessão (nunca token/senha; só o perfil público em cache para o modo offline) */
  SESSION_GET_USER: 'space:session:get-user',
  SESSION_SET_USER: 'space:session:set-user',
  SESSION_CLEAR_USER: 'space:session:clear-user',
  SESSION_CLEAR_COOKIES: 'space:session:clear-cookies',

  /* downloads */
  DL_PROBE: 'space:downloads:probe',
  DL_ADD: 'space:downloads:add',
  DL_PAUSE: 'space:downloads:pause',
  DL_RESUME: 'space:downloads:resume',
  DL_CANCEL: 'space:downloads:cancel',
  DL_RETRY: 'space:downloads:retry',
  DL_REMOVE: 'space:downloads:remove',
  DL_LIST: 'space:downloads:list',
  DL_REVEAL: 'space:downloads:reveal',
  DL_OPEN_FOLDER: 'space:downloads:open-folder',

  /* autostart (login item per-user) */
  AUTOSTART_GET: 'space:autostart:get',
  AUTOSTART_SET: 'space:autostart:set',

  /* janela */
  WINDOW_GET_FULLSCREEN: 'space:window:get-fullscreen',
  WINDOW_TOGGLE_FULLSCREEN: 'space:window:toggle-fullscreen',

  /* utilidades */
  EXTERNAL_OPEN: 'space:external:open',
  REGISTER_MEDIA_HOSTS: 'space:media-hosts:register',

  /* eventos main -> renderer (payload: { channel, payload }) */
  EVENT: 'space:event'
};
