package app.spaceiptv.mobile;

import android.content.Context;
import android.graphics.Color;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.FrameLayout;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.VideoSize;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Motor de reproducao: dois slots independentes de ExoPlayer dentro de um FrameLayout que
 * fica ATRAS do WebView (a pagina desenha por cima, com fundo transparente, exatamente como
 * o AVPlay do Tizen desenha atras da pagina). Cada slot usa TextureView (ver
 * res/layout/player_view.xml), e nao SurfaceView, para que a pagina fique comprovadamente
 * acima do video em qualquer aparelho.
 *
 * O JS manda as coordenadas de cada slot em pixels fisicos, entao a divisao da tela do
 * MultiView, o PiP e a tela cheia sao decididos no CSS/JS - nao no Java.
 *
 * Cada slot tenta as URLs na ordem (Xtream: .m3u8 e depois .ts) e, ao vivo, reconecta ate
 * 3 vezes antes de desistir - o mesmo comportamento que o player da TV ja tinha.
 */
public final class PlayerManager {

    public interface Callback {
        void emit(String json);
    }

    private static final String TAG = "SpacePlayer";
    private static final int SLOTS = 2;
    private static final int MAX_RECONNECT = 3;

    /* Muitos paineis IPTV recusam clientes desconhecidos: usa UA de navegador, como o AVPlay fazia. */
    private static final String UA =
            "Mozilla/5.0 (Linux; Android 12; SpaceIPTV) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/126.0.0.0 Safari/537.36";

    private final Context ctx;
    private final FrameLayout host;
    private final Callback cb;

    private final ExoPlayer[] players = new ExoPlayer[SLOTS];
    private final PlayerView[] views = new PlayerView[SLOTS];
    private final String[][] urls = new String[SLOTS][];
    private final int[] urlIdx = new int[SLOTS];
    private final int[] retries = new int[SLOTS];
    private final boolean[] live = new boolean[SLOTS];
    private final long[] startAt = new long[SLOTS];
    private final float[] volume = new float[]{1f, 0f};
    private final boolean[] opened = new boolean[SLOTS];

    /* instantaneo para o JS poder perguntar sem tocar no ExoPlayer de outra thread */
    private final long[] snapPos = new long[SLOTS];
    private final long[] snapDur = new long[SLOTS];
    private final boolean[] snapPlaying = new boolean[SLOTS];
    private final boolean[] snapBuffering = new boolean[SLOTS];

    private final Handler h = new Handler(Looper.getMainLooper());
    private boolean ticking;
    private int audioSlot = 0;

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            boolean alive = false;
            for (int s = 0; s < SLOTS; s++) {
                ExoPlayer p = players[s];
                if (p == null || !opened[s]) continue;
                snapPos[s] = Math.max(0, p.getCurrentPosition());
                long d = p.getDuration();
                snapDur[s] = d == C.TIME_UNSET ? 0 : Math.max(0, d);
                snapPlaying[s] = p.isPlaying();
                snapBuffering[s] = p.getPlaybackState() == Player.STATE_BUFFERING;
                send(progress(s));
                alive = true;
            }
            if (alive) h.postDelayed(this, 700);
            else ticking = false;
        }
    };

    public PlayerManager(Context ctx, FrameLayout host, Callback cb) {
        this.ctx = ctx;
        this.host = host;
        this.cb = cb;
    }

    private boolean ehLowRam() {
        try {
            android.app.ActivityManager am =
                    (android.app.ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
            return am != null && am.isLowRamDevice();
        } catch (Exception e) {
            return false;
        }
    }

    // ---------------------------------------------------------------- ciclo de vida

    /** Cria o player do slot (sob demanda) e o PlayerView correspondente. */
    private void ensure(final int slot) {
        if (players[slot] != null) return;

        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent(UA)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(20000)
                .setAllowCrossProtocolRedirects(true);

        /* 1 GB de RAM (projetor HY300): buffer curto e teto de memoria. O padrao do
           ExoPlayer guarda ate 60 s de video e estoura a heap de 128 MB junto com a
           WebView; 10 s bastam para ao vivo e nao travam o aparelho. */
        boolean magro = ehLowRam();
        DefaultLoadControl.Builder lb = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(magro ? 10000 : 15000, magro ? 30000 : 60000, 1500, 3000);
        if (magro) lb.setTargetBufferBytes(16 * 1024 * 1024);
        DefaultLoadControl load = lb.build();

        ExoPlayer p = new ExoPlayer.Builder(ctx)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(ctx).setDataSourceFactory(http))
                .setLoadControl(load)
                .setHandleAudioBecomingNoisy(true)
                .build();

        // So o slot principal pede foco de audio; o segundo toca mudo. Assim o MultiView
        // nao briga por foco e a troca de audio e so volume.
        p.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build(), slot == 0);
        p.setVolume(slot == audioSlot ? 1f : 0f);

        // Inflado do XML para nascer com surface_type="texture_view": com SurfaceView o
        // video e composto numa camada do sistema e acaba desenhado POR CIMA da WebView
        // (controles, titulo e barra de progresso escondidos). TextureView e uma View
        // comum, entao a WebView - que vem depois no FrameLayout - fica sempre por cima.
        PlayerView v = (PlayerView) LayoutInflater.from(ctx)
                .inflate(R.layout.player_view, host, false);
        v.setUseController(false);
        v.setPlayer(p);
        v.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        v.setShutterBackgroundColor(Color.TRANSPARENT);
        v.setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER);
        v.setLayoutParams(bounds(0, 0, 0, 0));
        v.setVisibility(View.GONE);

        p.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                emit("state", slot, "\"state\":\"" + stateName(state) + "\"");
                if (state == Player.STATE_READY) {
                    retries[slot] = 0;
                    if (startAt[slot] > 0) {
                        long to = startAt[slot];
                        startAt[slot] = 0;
                        if (to > 1000) players[slot].seekTo(to);
                    }
                }
                startTicker();
            }

            @Override
            public void onIsPlayingChanged(boolean playing) {
                emit("playing", slot, "\"playing\":" + playing);
            }

            @Override
            public void onVideoSizeChanged(VideoSize size) {
                emit("videoSize", slot, "\"w\":" + size.width + ",\"h\":" + size.height);
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                handleError(slot, error);
            }
        });

        players[slot] = p;
        views[slot] = v;
        host.addView(v);
    }

    private FrameLayout.LayoutParams bounds(int x, int y, int w, int h) {
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(w, h);
        lp.leftMargin = x;
        lp.topMargin = y;
        return lp;
    }

    /** Abre um stream num slot. urls: ordem de tentativa. startMs: retomada (VOD). */
    public void open(int slot, String[] list, boolean isLive, long startMs) {
        if (slot < 0 || slot >= SLOTS || list == null || list.length == 0) return;
        ensure(slot);
        urls[slot] = list;
        urlIdx[slot] = 0;
        retries[slot] = 0;
        live[slot] = isLive;
        startAt[slot] = startMs;
        opened[slot] = true;
        views[slot].setVisibility(View.VISIBLE);
        emit("open", slot, "\"live\":" + isLive + ",\"urls\":" + list.length);
        prepare(slot);
        startTicker();
    }

    private void prepare(int slot) {
        ExoPlayer p = players[slot];
        if (p == null || urls[slot] == null) return;
        String url = urls[slot][urlIdx[slot]];
        try {
            MediaItem item = itemFor(url);
            p.setMediaSource(new DefaultMediaSourceFactory(ctx)
                    .setDataSourceFactory(httpFactory())
                    .createMediaSource(item));
            p.prepare();
            p.setPlayWhenReady(true);
        } catch (Exception e) {
            Log.w(TAG, "falha ao preparar slot " + slot + ": " + e.getClass().getSimpleName());
            handleError(slot, null);
        }
    }

    private DefaultHttpDataSource.Factory httpFactory() {
        return new DefaultHttpDataSource.Factory()
                .setUserAgent(UA)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(20000)
                .setAllowCrossProtocolRedirects(true);
    }

    private MediaItem itemFor(String url) {
        String u = url.toLowerCase();
        MediaItem.Builder b = new MediaItem.Builder().setUri(Uri.parse(url));
        if (u.contains(".m3u8")) b.setMimeType(MimeTypes.APPLICATION_M3U8);
        else if (u.contains(".mpd")) b.setMimeType(MimeTypes.APPLICATION_MPD);
        return b.build();
    }

    public void play(int slot) {
        ExoPlayer p = players[slot];
        if (p == null) return;
        if (p.getPlaybackState() == Player.STATE_IDLE) prepare(slot);
        else p.setPlayWhenReady(true);
        startTicker();
    }

    public void pause(int slot) {
        ExoPlayer p = players[slot];
        if (p != null) p.setPlayWhenReady(false);
    }

    public void toggle(int slot) {
        ExoPlayer p = players[slot];
        if (p == null) return;
        if (p.getPlaybackState() == Player.STATE_IDLE) prepare(slot);
        else p.setPlayWhenReady(!p.getPlayWhenReady());
    }

    public void seek(int slot, long ms) {
        ExoPlayer p = players[slot];
        if (p == null) return;
        long d = p.getDuration();
        long to = Math.max(0, ms);
        if (d != C.TIME_UNSET && d > 0) to = Math.min(to, d - 1000);
        p.seekTo(to);
    }

    public void setVolume(int slot, float v) {
        volume[slot] = v;
        ExoPlayer p = players[slot];
        if (p != null) p.setVolume(v);
    }

    /** Troca qual slot tem audio (MultiView): um mudo, o outro nao. */
    public void setAudio(int slot) {
        audioSlot = (slot == 1) ? 1 : 0;
        for (int s = 0; s < SLOTS; s++) if (players[s] != null) players[s].setVolume(s == audioSlot ? 1f : 0f);
        emit("audio", audioSlot, "\"audio\":" + audioSlot);
    }

    public void setBounds(int slot, int x, int y, int w, int h) {
        ensure(slot);
        PlayerView v = views[slot];
        if (v == null) return;
        v.setLayoutParams(bounds(x, y, w, h));
        boolean visible = w > 0 && h > 0;
        v.setVisibility(visible ? View.VISIBLE : View.GONE);
        if (!visible && opened[slot]) {
            /* slot escondido (ex.: PiP fechado) continua tocando, mas sem audio */
            if (players[slot] != null && audioSlot != slot) players[slot].setVolume(0f);
        }
    }

    /** 0 = ajustar (fit), 1 = preencher (zoom), 2 = esticar. */
    public void setAspect(int slot, int mode) {
        PlayerView v = views[slot];
        if (v == null) return;
        int r = AspectRatioFrameLayout.RESIZE_MODE_FIT;
        if (mode == 1) r = AspectRatioFrameLayout.RESIZE_MODE_ZOOM;
        else if (mode == 2) r = AspectRatioFrameLayout.RESIZE_MODE_FILL;
        v.setResizeMode(r);
    }

    public void stop(int slot) {
        ExoPlayer p = players[slot];
        opened[slot] = false;
        snapPlaying[slot] = false;
        snapBuffering[slot] = false;
        snapPos[slot] = 0;
        snapDur[slot] = 0;
        if (p != null) {
            try {
                p.stop();
                p.clearMediaItems();
            } catch (Exception ignored) {
            }
        }
        if (views[slot] != null) views[slot].setVisibility(View.GONE);
        emit("stop", slot, "");
    }

    /** Libera o slot e remove a view (fim do modo MultiView / saida do player). */
    public void close(int slot) {
        stop(slot);
        ExoPlayer p = players[slot];
        PlayerView v = views[slot];
        players[slot] = null;
        views[slot] = null;
        if (p != null) {
            try {
                p.release();
            } catch (Exception ignored) {
            }
        }
        if (v != null) host.removeView(v);
        if (slot == 1) setAudio(0);
    }

    public void releaseAll() {
        h.removeCallbacks(ticker);
        ticking = false;
        for (int s = 0; s < SLOTS; s++) close(s);
    }

    public void pauseAll() {
        for (int s = 0; s < SLOTS; s++) pause(s);
    }

    public boolean anyPlaying() {
        for (int s = 0; s < SLOTS; s++) if (players[s] != null && players[s].isPlaying()) return true;
        return false;
    }

    /** Instantaneo do slot (lido pela bridge, em outra thread). */
    public String snapshot(int slot) {
        if (slot < 0 || slot >= SLOTS) slot = 0;
        try {
            JSONObject o = new JSONObject();
            o.put("slot", slot);
            o.put("opened", opened[slot]);
            o.put("playing", snapPlaying[slot]);
            o.put("buffering", snapBuffering[slot]);
            o.put("pos", snapPos[slot]);
            o.put("dur", snapDur[slot]);
            o.put("audio", audioSlot);
            return o.toString();
        } catch (Exception e) {
            return "{}";
        }
    }

    private void startTicker() {
        if (ticking) return;
        ticking = true;
        h.postDelayed(ticker, 300);
    }

    // ---------------------------------------------------------------- erros

    private void handleError(int slot, PlaybackException error) {
        String code = mapCode(error);
        JSONArray arr = new JSONArray();
        String detail = error == null ? "" : String.valueOf(error.getErrorCodeName());

        /* 1) proxima URL da lista (Xtream ao vivo: .m3u8 -> .ts) */
        if (urls[slot] != null && urlIdx[slot] + 1 < urls[slot].length) {
            urlIdx[slot]++;
            emit("retry", slot, "\"reason\":\"url\",\"index\":" + urlIdx[slot]);
            prepare(slot);
            return;
        }
        /* 2) ao vivo: reconexao com espera crescente */
        if (live[slot] && retries[slot] < MAX_RECONNECT) {
            retries[slot]++;
            final int s = slot;
            final int attempt = retries[slot];
            emit("retry", slot, "\"reason\":\"reconnect\",\"attempt\":" + attempt);
            if (players[s] != null) players[s].stop();
            h.postDelayed(() -> {
                if (opened[s]) prepare(s);
            }, 1500L * attempt);
            return;
        }
        emit("error", slot, "\"code\":\"" + code + "\",\"detail\":\"" + jsonEscape(detail) + "\"");
    }

    private static String jsonEscape(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    private static String mapCode(PlaybackException e) {
        if (e == null) return "unknown";
        switch (e.errorCode) {
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED:
            case PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT:
                return "timeout";
            case PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS:
            case PlaybackException.ERROR_CODE_IO_FILE_NOT_FOUND:
                return "http";
            case PlaybackException.ERROR_CODE_DECODER_INIT_FAILED:
            case PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED:
            case PlaybackException.ERROR_CODE_DECODING_FAILED:
                return "codec";
            case PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED:
            case PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED:
            case PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED:
            case PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED:
                return "format";
            default:
                return "play";
        }
    }

    private static String stateName(int state) {
        switch (state) {
            case Player.STATE_IDLE:
                return "idle";
            case Player.STATE_BUFFERING:
                return "buffering";
            case Player.STATE_READY:
                return "ready";
            case Player.STATE_ENDED:
                return "ended";
            default:
                return "unknown";
        }
    }

    // ---------------------------------------------------------------- eventos

    private String progress(int slot) {
        return "{\"type\":\"progress\",\"slot\":" + slot + ",\"pos\":" + snapPos[slot]
                + ",\"dur\":" + snapDur[slot] + ",\"playing\":" + snapPlaying[slot]
                + ",\"buffering\":" + snapBuffering[slot] + "}";
    }

    private void emit(String type, int slot, String extra) {
        StringBuilder sb = new StringBuilder(64);
        sb.append("{\"type\":\"").append(type).append("\",\"slot\":").append(slot);
        if (extra != null && !extra.isEmpty()) sb.append(',').append(extra);
        sb.append('}');
        cb.emit(sb.toString());
    }

    /** Envia um JSON ja montado (usado pelo ticker de progresso). */
    private void send(String json) {
        cb.emit(json);
    }
}
