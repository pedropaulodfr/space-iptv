package app.spaceiptv.mobile;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Protecao das credenciais (URL da lista M3U, senha do Xtream, PIN parental).
 *
 * A chave AES-256 vive no Android Keystore (protegida por hardware quando o aparelho tem
 * TEE/StrongBox) e NUNCA sai de la: o JS pede para cifrar/decifrar, nunca recebe a chave.
 * E o equivalente Android do App.secrets que o app Tizen implementa em JS puro - na TV a
 * chave ficava no localStorage ao lado do texto cifrado.
 *
 * Formatos aceitos, em ordem de preferencia:
 *   n1:iv:ct  -> Keystore (hardware). O melhor caso.
 *   l1:iv:ct  -> chave AES aleatoria guardada nas preferencias do app. Usado em
 *                projetores/caixas baratas cujo Keystore recusa criar chaves
 *                ("Keystore operation failed", comum no Rockchip RK3326 do HY300).
 *                Equivale ao que o app Tizen faz: o texto nao fica legivel num dump
 *                casual, mas a chave esta no mesmo aparelho.
 *   p0:base64 -> ultima reserva (so se nem a chave local puder ser criada). Mantida
 *                para o app nunca perder a lista ja cadastrada.
 *
 * Os tres formatos continuam legiveis: atualizar o app nao obriga a recadastrar nada.
 */
public final class SecretsStore {

    private static final String TAG = "SpaceSecrets";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String ALIAS = "spaceiptv.secrets.v1";
    private static final String PREFIX_HW = "n1:";
    private static final String PREFIX_LOCAL = "l1:";
    private static final String PREFIX_RAW = "p0:";
    private static final String PREFS = "spaceiptv";
    private static final String PREF_KEY = "secrets.k";
    private static final int IV_LEN = 12;
    private static final int TAG_BITS = 128;

    private final Context ctx;
    private SecretKey key;        /* chave do Keystore (n1) */
    private SecretKey local;      /* chave local (l1) */
    private boolean hwTried;

    public SecretsStore(Context ctx) {
        this.ctx = ctx;
    }

    // ------------------------------------------------------------- chaves

    private synchronized SecretKey key() throws Exception {
        if (key != null) return key;
        if (hwTried && key == null) throw new Exception("Keystore sem chave");
        hwTried = true;

        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            try {
                key = (SecretKey) ks.getKey(ALIAS, null);
                if (key != null) return key;
            } catch (Exception e) {
                Log.w(TAG, "chave existente ilegivel, criando outra: " + e);
                try { ks.deleteEntry(ALIAS); } catch (Exception ignored) { }
            }
        }
        /* Alguns aparelhos baratos recusam AES-256 no Keystore. Tenta 128 bits antes
           de desistir. O init sem KeyGenParameterSpec nao serve no AndroidKeyStore. */
        int[] tamanhos = new int[]{256, 128};
        Exception ultimo = null;
        for (int i = 0; i < tamanhos.length; i++) {
            try {
                KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
                kg.init(new KeyGenParameterSpec.Builder(ALIAS,
                        KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                        .setKeySize(tamanhos[i])
                        .build());
                key = kg.generateKey();
                if (key != null) {
                    Log.i(TAG, "chave do Keystore criada com " + tamanhos[i] + " bits");
                    return key;
                }
            } catch (Exception e) {
                ultimo = e;
                Log.w(TAG, "Keystore recusou " + tamanhos[i] + " bits: " + e);
                try { ks.deleteEntry(ALIAS); } catch (Exception ignored) { }
            }
        }
        throw ultimo == null ? new Exception("Keystore indisponivel") : ultimo;
    }

    /** Chave AES aleatoria deste aparelho, guardada nas preferencias do app. */
    private synchronized SecretKey localKey() throws Exception {
        if (local != null) return local;
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String guardado = sp.getString(PREF_KEY, null);
        if (guardado != null) {
            byte[] raw = Base64.decode(guardado, Base64.NO_WRAP);
            if (raw != null && raw.length == 32) {
                local = new SecretKeySpec(raw, "AES");
                return local;
            }
        }
        byte[] raw = new byte[32];
        new SecureRandom().nextBytes(raw);
        sp.edit().putString(PREF_KEY, Base64.encodeToString(raw, Base64.NO_WRAP)).commit();
        local = new SecretKeySpec(raw, "AES");
        Log.i(TAG, "chave local criada (Keystore indisponivel neste aparelho)");
        return local;
    }

    // ------------------------------------------------------------- operacoes

    /** Cifra um texto. Devolve "" para entrada vazia. */
    public synchronized String seal(String plain) {
        if (plain == null || plain.isEmpty()) return "";
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            return PREFIX_HW + b64(iv) + ":" + b64(ct);
        } catch (Exception e) {
            Log.w(TAG, "Keystore indisponivel para selar: " + e);
        }
        try {
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.ENCRYPT_MODE, localKey());
            byte[] iv = c.getIV();
            byte[] ct = c.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            return PREFIX_LOCAL + b64(iv) + ":" + b64(ct);
        } catch (Exception e) {
            Log.w(TAG, "falha ao selar (usando reserva em base64): " + e);
            return PREFIX_RAW + b64(plain.getBytes(StandardCharsets.UTF_8));
        }
    }

    /** Decifra. Devolve "" quando o texto nao foi gerado neste aparelho (Keystore reiniciado). */
    public synchronized String open(String sealed) {
        if (sealed == null || sealed.isEmpty()) return "";
        try {
            if (sealed.startsWith(PREFIX_RAW)) {
                return new String(unb64(sealed.substring(3)), StandardCharsets.UTF_8);
            }
            boolean local1 = sealed.startsWith(PREFIX_LOCAL);
            if (!local1 && !sealed.startsWith(PREFIX_HW)) return "";
            String[] p = sealed.split(":");
            if (p.length != 3) return "";
            SecretKey k = local1 ? localKey() : key();
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(TAG_BITS, unb64(p[1])));
            return new String(c.doFinal(unb64(p[2])), StandardCharsets.UTF_8);
        } catch (Exception e) {
            Log.w(TAG, "falha ao abrir segredo: " + e);
            return "";
        }
    }

    /** Diagnostico para a tela "Sobre": qual protecao esta em uso. */
    public synchronized String kind() {
        try {
            key();
            return "keystore";
        } catch (Exception e) {
            return "local";
        }
    }

    private static String b64(byte[] b) {
        return Base64.encodeToString(b, Base64.NO_WRAP);
    }

    private static byte[] unb64(String s) {
        return Base64.decode(s, Base64.NO_WRAP);
    }
}
