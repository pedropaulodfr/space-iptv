package app.spaceiptv.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.KeyEvent;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONObject;

/**
 * Host do app: uma WebView transparente por cima de uma camada de video nativa.
 *
 * A pagina carrega do APK (file:///android_asset) e usa a MESMA logica de negocio do app
 * Tizen (js/ compartilhado). O que muda e a interface, reescrita para toque, e o motor de
 * video, que aqui e o ExoPlayer.
 */
public class MainActivity extends Activity {

    private static final String TAG = "SpaceIPTV";

    private WebView web;
    private FrameLayout root;
    private FrameLayout playerLayer;
    private PlayerManager player;
    private NativeBridge bridge;
    private SecretsStore secrets;

    private volatile int insetTop, insetBottom, insetLeft, insetRight;
    private volatile int insetIme;
    private boolean immersive;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setBackgroundDrawable(new ColorDrawable(0xFF050711));

        secrets = new SecretsStore(this);

        root = new FrameLayout(this);
        playerLayer = new FrameLayout(this);   // video fica ATRAS da pagina
        web = new WebView(this);

        root.addView(playerLayer, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        configureWebView();

        /* O controle remoto (IR ou air mouse) manda eventos de tecla para a View
           que tem foco. Sem isto a WebView nasce sem foco e as setas nao chegam
           na pagina - foi o que deixou o app inutil no projetor. */
        web.setFocusable(true);
        web.setFocusableInTouchMode(true);
        web.requestFocus();

        player = new PlayerManager(this, playerLayer, this::emitToJs);
        bridge = new NativeBridge(this, secrets, player);
        web.addJavascriptInterface(bridge, "SpaceNative");

        edgeToEdge();
        watchInsets();

        web.loadUrl("file:///android_asset/mobile/index.html");
    }

    // ---------------------------------------------------------------- WebView

    private void configureWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(false);
        // Equivalente Android do <access origin="*"> do Tizen: as listas M3U e os paineis
        // Xtream nao mandam cabecalho CORS, e sem isso o fetch/XHR seria bloqueado.
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);          // nao herda o "tamanho da fonte" do sistema
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        web.setBackgroundColor(0xFF050711);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setLongClickable(false);
        web.setHapticFeedbackEnabled(false);

        /* Depuracao da WebView so em build de depuracao: no APK de release isso abriria a
           inspecao do DevTools para qualquer um com acesso ao adb. */
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                return true;   // app de tela unica: nao navega para fora
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i("SPACEJS", m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")");
                return true;
            }
        });
    }

    void emitToJs(String json) {        final String js = "window.SpacePlayer&&window.SpacePlayer.onEvent(" + json + ");";
        runOnUiThread(() -> {
            if (web == null) return;
            try {
                web.evaluateJavascript(js, null);
            } catch (Exception ignored) {
            }
        });
    }

    /** Deixa a pagina transparente durante a reproducao: o video nativo aparece atras dela.
     *  A JANELA continua opaca de proposito. Janela translucida faz o Android parar de
     *  limpar o buffer entre quadros, e o que sobra na tela e a imagem antiga (a lista, o
     *  cabecalho do player) aparecendo nas faixas pretas do video. O video e uma View
     *  dentro da mesma janela, entao ele continua visivel atraves da pagina transparente. */
    void setWebTransparent(final boolean transparent) {
        runOnUiThread(() -> {
            int bg = transparent ? Color.TRANSPARENT : 0xFF050711;
            if (web != null) web.setBackgroundColor(bg);
            if (root != null) root.setBackgroundColor(bg);
            if (playerLayer != null) playerLayer.setBackgroundColor(Color.TRANSPARENT);
        });
    }

    // ---------------------------------------------------------------- janela

    private void edgeToEdge() {
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        if (Build.VERSION.SDK_INT >= 28) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }
    }

    private void watchInsets() {
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            int top = 0, bottom = 0, left = 0, right = 0;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                top = i.top;
                bottom = i.bottom;
                left = i.left;
                right = i.right;
            } else {
                top = insets.getSystemWindowInsetTop();
                bottom = insets.getSystemWindowInsetBottom();
                left = insets.getSystemWindowInsetLeft();
                right = insets.getSystemWindowInsetRight();
            }
            float d = getResources().getDisplayMetrics().density;
            insetTop = Math.round(top / d);
            insetBottom = Math.round(bottom / d);
            insetLeft = Math.round(left / d);
            insetRight = Math.round(right / d);

            /* Com edge-to-edge a janela NAO encolhe para o teclado: a altura coberta
               precisa ser enviada a pagina, senao formularios ficam atras do teclado. */
            int ime = 0;
            if (Build.VERSION.SDK_INT >= 30) ime = insets.getInsets(WindowInsets.Type.ime()).bottom;
            insetIme = Math.round(ime / d);

            pushInsets();
            return insets;
        });
        root.requestApplyInsets();
    }

    private void pushInsets() {
        emitToJs("{\"type\":\"insets\",\"top\":" + insetTop + ",\"bottom\":" + insetBottom
                + ",\"left\":" + insetLeft + ",\"right\":" + insetRight
                + ",\"ime\":" + insetIme + "}");
    }

    String insetsJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("top", insetTop);
            o.put("bottom", insetBottom);
            o.put("left", insetLeft);
            o.put("right", insetRight);
            o.put("ime", insetIme);
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    void setOrientationMode(String mode) {
        int o = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
        if ("landscape".equals(mode)) o = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;
        else if ("portrait".equals(mode)) o = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;
        else if ("sensor".equals(mode)) o = ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR;
        try {
            setRequestedOrientation(o);
        } catch (Exception ignored) {
        }
    }

    void keepScreenOn(boolean on) {
        if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    void applyImmersive(boolean on) {
        immersive = on;
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c == null) return;
            if (on) {
                c.hide(WindowInsets.Type.systemBars());
                c.setSystemBarsBehavior(
                        WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            } else {
                c.show(WindowInsets.Type.systemBars());
            }
        } else {
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
            if (on) {
                flags |= View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY;
            }
            getWindow().getDecorView().setSystemUiVisibility(flags);
        }
        root.requestApplyInsets();
    }

    String appVersion() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return pi.versionName == null ? "1.0.0" : pi.versionName;
        } catch (Exception e) {
            return "1.0.0";
        }
    }

    // ---------------------------------------------------------- aparelho

    /** Projetores e TV boxes de 1 GB se anunciam como low-ram: o app simplifica
     *  o visual e roda menos sondagens de saude ao mesmo tempo. */
    boolean isLowRam() {
        try {
            android.app.ActivityManager am =
                    (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
            return am != null && am.isLowRamDevice();
        } catch (Exception e) {
            return false;
        }
    }

    /** Alguns projetores declaram tela sensivel ao toque sem ter uma. Quem manda
     *  no modo de tela e o tamanho; este dado so ajuda a decidir. */
    boolean hasTouchscreen() {
        try {
            return getPackageManager().hasSystemFeature(
                    android.content.pm.PackageManager.FEATURE_TOUCHSCREEN);
        } catch (Exception e) {
            return true;
        }
    }

    float refreshRate() {
        try {
            return getWindowManager().getDefaultDisplay().getRefreshRate();
        } catch (Exception e) {
            return 60f;
        }
    }

    int memoryClass() {
        try {
            android.app.ActivityManager am =
                    (android.app.ActivityManager) getSystemService(ACTIVITY_SERVICE);
            return am == null ? 0 : am.getMemoryClass();
        } catch (Exception e) {
            return 0;
        }
    }

    // ---------------------------------------------------------------- ciclo de vida

    @Override
    protected void onPause() {
        super.onPause();
        if (player != null) {
            player.pauseAll();
            keepScreenOn(false);
        }
        if (web != null) web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (web != null) web.onResume();
        if (immersive) applyImmersive(true);
        if (player != null && player.anyPlaying()) keepScreenOn(true);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus && immersive) applyImmersive(true);
    }

    /* As teclas de midia do controle nem sempre viram evento de teclado na pagina.
       Aqui elas sao traduzidas para acoes do player. */
    private boolean forwardMediaKey(KeyEvent e) {
        String acao;
        switch (e.getKeyCode()) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE: acao = "toggle"; break;
            case KeyEvent.KEYCODE_MEDIA_PLAY: acao = "play"; break;
            case KeyEvent.KEYCODE_MEDIA_PAUSE: acao = "pause"; break;
            case KeyEvent.KEYCODE_MEDIA_NEXT: acao = "next"; break;
            case KeyEvent.KEYCODE_MEDIA_PREVIOUS: acao = "prev"; break;
            case KeyEvent.KEYCODE_CHANNEL_UP: acao = "zapup"; break;
            case KeyEvent.KEYCODE_CHANNEL_DOWN: acao = "zapdown"; break;
            default: return false;
        }
        if (e.getAction() == KeyEvent.ACTION_DOWN) {
            emitToJs("{\"type\":\"key\",\"key\":\"" + acao + "\"}");
        }
        return true;
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (web != null && forwardMediaKey(e)) return true;
        return super.dispatchKeyEvent(e);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript(
                "(function(){try{return !!(window.AndroidShell&&AndroidShell.back&&AndroidShell.back());}catch(e){return false;}})()",
                value -> {
                    if (!"true".equals(value)) finish();
                });
    }

    @Override
    protected void onDestroy() {
        if (player != null) player.releaseAll();
        if (web != null) {
            web.removeJavascriptInterface("SpaceNative");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
