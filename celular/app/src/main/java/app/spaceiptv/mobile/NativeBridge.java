package app.spaceiptv.mobile;

import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Ponte JS <-> Android. Tudo que o aplicativo precisa do sistema passa por aqui.
 *
 * Os metodos chamados pelo JS rodam numa thread de binder (NAO na thread de UI), por isso
 * qualquer coisa que toque em View/Player e despachada para runOnUiThread.
 */
public final class NativeBridge {

    private static final String TAG = "SpaceNative";

    private final MainActivity act;
    private final SecretsStore secrets;
    private final PlayerManager player;

    NativeBridge(MainActivity act, SecretsStore secrets, PlayerManager player) {
        this.act = act;
        this.secrets = secrets;
        this.player = player;
    }

    // ------------------------------------------------------------- informacoes

    @JavascriptInterface
    public String info() {
        try {
            JSONObject o = new JSONObject();
            o.put("version", act.appVersion());
            o.put("model", android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL);
            o.put("sdk", android.os.Build.VERSION.SDK_INT);
            o.put("density", act.getResources().getDisplayMetrics().density);
            o.put("platform", "android");
            /* O JS usa estes para escolher o modo de tela (celular x projetor) e
               para afrouxar o visual em aparelhos de 1 GB. */
            o.put("lowRam", act.isLowRam());
            o.put("touch", act.hasTouchscreen());
            o.put("refresh", act.refreshRate());
            o.put("heap", act.memoryClass());
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    /* Area de transferencia do sistema. A WebView nao consegue ler o clipboard
       por conta propria (a pagina roda em file:// e o toque longo esta desligado
       de proposito), entao o botao "Colar" dos formularios vem por aqui. */
    @JavascriptInterface
    public String clipboard() {
        try {
            android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) act.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
            if (cm == null || !cm.hasPrimaryClip()) return "";
            android.content.ClipData d = cm.getPrimaryClip();
            if (d == null || d.getItemCount() == 0) return "";
            CharSequence t = d.getItemAt(0).coerceToText(act);
            return t == null ? "" : t.toString();
        } catch (Exception e) {
            Log.w(TAG, "clipboard indisponivel: " + e.getClass().getSimpleName());
            return "";
        }
    }

    @JavascriptInterface
    public String insets() {
        return act.insetsJson();
    }

    @JavascriptInterface
    public void log(String msg) {
        Log.i("SPACEJS", msg == null ? "" : msg);
    }

    @JavascriptInterface
    public void exit() {
        act.runOnUiThread(act::finish);
    }

    // ------------------------------------------------------------- seguranca

    @JavascriptInterface
    public String seal(String plain) {
        return secrets.seal(plain);
    }

    @JavascriptInterface
    public String open(String sealed) {
        return secrets.open(sealed);
    }

    // ------------------------------------------------------------- janela

    @JavascriptInterface
    public void orientation(String mode) {
        act.runOnUiThread(() -> act.setOrientationMode(mode));
    }

    @JavascriptInterface
    public void keepScreenOn(final boolean on) {
        act.runOnUiThread(() -> act.keepScreenOn(on));
    }

    @JavascriptInterface
    public void immersive(final boolean on) {
        act.runOnUiThread(() -> act.applyImmersive(on));
    }

    @JavascriptInterface
    public void webTransparent(final boolean on) {
        act.setWebTransparent(on);
    }

    // ------------------------------------------------------------- player

    @JavascriptInterface
    public void playerOpen(final int slot, final String urlsJson, final boolean live, final long startMs) {
        final String[] list = parseUrls(urlsJson);
        if (list.length == 0) return;
        act.runOnUiThread(() -> player.open(slot, list, live, startMs));
    }

    @JavascriptInterface
    public void playerPlay(final int slot) {
        act.runOnUiThread(() -> player.play(slot));
    }

    @JavascriptInterface
    public void playerPause(final int slot) {
        act.runOnUiThread(() -> player.pause(slot));
    }

    @JavascriptInterface
    public void playerToggle(final int slot) {
        act.runOnUiThread(() -> player.toggle(slot));
    }

    @JavascriptInterface
    public void playerSeek(final int slot, final long ms) {
        act.runOnUiThread(() -> player.seek(slot, ms));
    }

    @JavascriptInterface
    public void playerVolume(final int slot, final float v) {
        act.runOnUiThread(() -> player.setVolume(slot, v));
    }

    @JavascriptInterface
    public void playerAudio(final int slot) {
        act.runOnUiThread(() -> player.setAudio(slot));
    }

    @JavascriptInterface
    public void playerBounds(final int slot, final int x, final int y, final int w, final int h) {
        act.runOnUiThread(() -> player.setBounds(slot, x, y, w, h));
    }

    @JavascriptInterface
    public void playerAspect(final int slot, final int mode) {
        act.runOnUiThread(() -> player.setAspect(slot, mode));
    }

    @JavascriptInterface
    public void playerStop(final int slot) {
        act.runOnUiThread(() -> player.stop(slot));
    }

    @JavascriptInterface
    public void playerClose(final int slot) {
        act.runOnUiThread(() -> player.close(slot));
    }

    @JavascriptInterface
    public void playerReleaseAll() {
        act.runOnUiThread(() -> player.releaseAll());
    }

    @JavascriptInterface
    public String playerState(int slot) {
        return player.snapshot(slot);
    }

    private static String[] parseUrls(String json) {
        if (json == null || json.isEmpty()) return new String[0];
        try {
            JSONArray a = new JSONArray(json);
            String[] out = new String[a.length()];
            for (int i = 0; i < a.length(); i++) out[i] = a.getString(i);
            return out;
        } catch (Exception e) {
            Log.w(TAG, "lista de URLs invalida");
            return new String[0];
        }
    }
}
