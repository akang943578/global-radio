package com.globalradio.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Background-audio helper plugin.
 *
 * History: v2.0.6 introduced a dedicated foreground service
 * ({@code MediaPlaybackService}) that posted its own (intentionally minimal)
 * notification on top of the one already published by
 * {@code @jofr/capacitor-media-session}. Two foreground services with
 * {@code foregroundServiceType="mediaPlayback"} ended up confusing the
 * system / OEM (especially MIUI/HyperOS), which would collapse them into a
 * single entry and pick the wrong (minimal) one — making the rich MediaStyle
 * "now playing" card disappear from the notification shade.
 *
 * v2.0.13 onwards: we no longer run our own service. The {@code @jofr}
 * plugin already owns the only foreground service with mediaPlayback type
 * (which is enough to keep playback alive after screen-off on API 34+).
 * Our remaining responsibility is to hold a {@code PARTIAL_WAKE_LOCK} +
 * {@code WifiLock} while audio is playing so Doze mode doesn't suspend
 * the radio stream. WakeLocks don't need a service — any component with a
 * {@link Context} can hold them — so we just acquire/release them directly
 * from the plugin's start/stop methods.
 *
 * v2.0.21: also owns Android audio-focus management. The HTML5
 * {@code <audio>} element inside a Capacitor WebView does <strong>not</strong>
 * automatically request {@link AudioManager#AUDIOFOCUS_GAIN}, so without
 * this plugin radio audio happily mixes on top of Spotify / phone calls /
 * navigation prompts. We expose {@link #requestAudioFocus(PluginCall)} +
 * {@link #abandonAudioFocus(PluginCall)} for JS to call around playback,
 * and bridge focus-change events back to JS via {@code notifyListeners}
 * so the player store can pause / auto-resume per Android UX guidelines.
 *
 * JS contract:
 *   - BackgroundAudio.start({ title, subtitle })   → acquire CPU + Wi-Fi locks
 *   - BackgroundAudio.stop()                       → release them
 *   - BackgroundAudio.requestAudioFocus()          → request AUDIOFOCUS_GAIN
 *   - BackgroundAudio.abandonAudioFocus()          → release focus
 *   - addListener('audioFocusLost',  ...)          → { transient: boolean }
 *   - addListener('audioFocusGained',...)          → {}
 */
@CapacitorPlugin(name = "BackgroundAudio")
public class BackgroundAudioPlugin extends Plugin {

    private static final String TAG = "BackgroundAudioPlugin";

    private static final String WAKELOCK_TAG = "GlobalRadio:Playback";
    private static final String WIFILOCK_TAG = "GlobalRadio:WifiLock";

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    // Audio focus state. Created lazily in requestAudioFocus and reused so
    // we hand the same listener instance to abandonAudioFocus() — required
    // by AudioManager.abandonAudioFocus / AudioFocusRequest semantics.
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest; // API 26+
    private AudioManager.OnAudioFocusChangeListener focusListener;
    private boolean focusHeld = false;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void start(PluginCall call) {
        acquireLocks();
        JSObject result = new JSObject();
        result.put("started", true);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        releaseLocks();
        JSObject result = new JSObject();
        result.put("stopped", true);
        call.resolve(result);
    }

    /**
     * Request {@link AudioManager#AUDIOFOCUS_GAIN} for media playback.
     * Resolves with {@code { granted: boolean }}. JS should still proceed
     * with playback even on {@code granted: false} (older / unusual OEMs
     * sometimes refuse focus but allow audio anyway), so the caller can
     * decide policy.
     */
    @PluginMethod
    public void requestAudioFocus(PluginCall call) {
        boolean granted = false;
        try {
            AudioManager am = ensureAudioManager();
            if (am == null) {
                JSObject result = new JSObject();
                result.put("granted", false);
                call.resolve(result);
                return;
            }
            ensureFocusListener();

            int requestResult;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (audioFocusRequest == null) {
                    AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build();
                    audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(attrs)
                        .setAcceptsDelayedFocusGain(false)
                        .setOnAudioFocusChangeListener(focusListener, mainHandler)
                        .build();
                }
                requestResult = am.requestAudioFocus(audioFocusRequest);
            } else {
                requestResult = am.requestAudioFocus(
                    focusListener,
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN
                );
            }

            granted = requestResult == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
            focusHeld = granted;
            Log.i(TAG, "requestAudioFocus -> " + (granted ? "GRANTED" : "DENIED (" + requestResult + ")"));
        } catch (Exception e) {
            Log.w(TAG, "requestAudioFocus threw", e);
        }
        JSObject result = new JSObject();
        result.put("granted", granted);
        call.resolve(result);
    }

    /**
     * Release any audio focus we hold. Safe to call repeatedly / when not
     * currently holding focus.
     */
    @PluginMethod
    public void abandonAudioFocus(PluginCall call) {
        try {
            AudioManager am = ensureAudioManager();
            if (am != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    if (audioFocusRequest != null) {
                        am.abandonAudioFocusRequest(audioFocusRequest);
                    }
                } else if (focusListener != null) {
                    am.abandonAudioFocus(focusListener);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "abandonAudioFocus threw", e);
        } finally {
            focusHeld = false;
        }
        JSObject result = new JSObject();
        result.put("abandoned", true);
        call.resolve(result);
    }

    @Override
    protected void handleOnDestroy() {
        releaseLocks();
        // Best effort: drop focus + clear listener so we don't leak through
        // process restart edge cases.
        try {
            AudioManager am = ensureAudioManager();
            if (am != null) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    if (audioFocusRequest != null) {
                        am.abandonAudioFocusRequest(audioFocusRequest);
                    }
                } else if (focusListener != null) {
                    am.abandonAudioFocus(focusListener);
                }
            }
        } catch (Exception ignored) {
            // No-op on teardown
        } finally {
            focusHeld = false;
        }
        super.handleOnDestroy();
    }

    private AudioManager ensureAudioManager() {
        if (audioManager == null) {
            try {
                audioManager = (AudioManager) getContext()
                    .getApplicationContext()
                    .getSystemService(Context.AUDIO_SERVICE);
            } catch (Exception e) {
                Log.w(TAG, "ensureAudioManager failed", e);
            }
        }
        return audioManager;
    }

    private void ensureFocusListener() {
        if (focusListener != null) return;
        focusListener = focusChange -> {
            // The framework can deliver these on the main thread (when we
            // pass mainHandler to AudioFocusRequest), but on older API levels
            // the callback can land on whatever thread the system chooses.
            // notifyListeners is thread-safe in Capacitor, so we just emit.
            switch (focusChange) {
                case AudioManager.AUDIOFOCUS_LOSS: {
                    focusHeld = false;
                    JSObject data = new JSObject();
                    data.put("transient", false);
                    data.put("canDuck", false);
                    Log.i(TAG, "AUDIOFOCUS_LOSS");
                    notifyListeners("audioFocusLost", data);
                    break;
                }
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT: {
                    focusHeld = false;
                    JSObject data = new JSObject();
                    data.put("transient", true);
                    data.put("canDuck", false);
                    Log.i(TAG, "AUDIOFOCUS_LOSS_TRANSIENT");
                    notifyListeners("audioFocusLost", data);
                    break;
                }
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK: {
                    // We treat duck-permission the same as a transient pause —
                    // radio streams don't duck nicely (lyrics get clipped, the
                    // mix sounds bad), users much prefer a hard pause.
                    focusHeld = false;
                    JSObject data = new JSObject();
                    data.put("transient", true);
                    data.put("canDuck", true);
                    Log.i(TAG, "AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK (treated as transient pause)");
                    notifyListeners("audioFocusLost", data);
                    break;
                }
                case AudioManager.AUDIOFOCUS_GAIN: {
                    focusHeld = true;
                    Log.i(TAG, "AUDIOFOCUS_GAIN");
                    notifyListeners("audioFocusGained", new JSObject());
                    break;
                }
                default:
                    Log.d(TAG, "Audio focus change: " + focusChange);
            }
        };
    }

    private void acquireLocks() {
        try {
            Context ctx = getContext();
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
                if (pm != null) {
                    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKELOCK_TAG);
                    wakeLock.setReferenceCounted(false);
                }
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire();
            }

            if (wifiLock == null) {
                WifiManager wm = (WifiManager) ctx.getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
                if (wm != null) {
                    int mode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                        ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                        : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                    wifiLock = wm.createWifiLock(mode, WIFILOCK_TAG);
                    wifiLock.setReferenceCounted(false);
                }
            }
            if (wifiLock != null && !wifiLock.isHeld()) {
                wifiLock.acquire();
            }
        } catch (Exception ignored) {
            // Locks are best-effort; failure here shouldn't crash playback.
        }
    }

    private void releaseLocks() {
        try {
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
            if (wifiLock != null && wifiLock.isHeld()) {
                wifiLock.release();
            }
        } catch (Exception ignored) {
            // No-op
        }
    }
}
