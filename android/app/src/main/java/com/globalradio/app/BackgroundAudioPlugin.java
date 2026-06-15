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
import android.webkit.ValueCallback;

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
 * v2.0.22: the v2.0.21 audio-focus implementation looked correct on paper
 * but on Xiaomi POCO F5 / HyperOS 3.0.40 the radio kept playing on top of
 * other apps' audio. Hardening:
 *   - Eagerly initialize the focus listener + AudioFocusRequest in load()
 *     so they exist before any first request, never lazily.
 *   - Aggressive logcat on every focus boundary (request / loss / gain /
 *     listener identity hash) so future regressions are diagnosable.
 *   - Belt-and-braces JS dispatch: notifyListeners (Capacitor event) AND
 *     bridge.eval(window.dispatchEvent(new CustomEvent(...))) — JS now
 *     listens to both. If either path fires, we pause.
 *   - Native fallback: on every LOSS we also evaluate
 *     `document.querySelectorAll('audio').forEach(a => a.pause())` directly
 *     against the WebView, so even if the JS bridge is asleep / not yet
 *     hooked / Capacitor swallows the event, the underlying audio element
 *     still gets paused at the DOM level.
 *
 * JS contract:
 *   - BackgroundAudio.start({ title, subtitle })   → acquire CPU + Wi-Fi locks
 *   - BackgroundAudio.stop()                       → release them
 *   - BackgroundAudio.requestAudioFocus()          → request AUDIOFOCUS_GAIN
 *   - BackgroundAudio.abandonAudioFocus()          → release focus
 *   - addListener('audioFocusLost',  ...)          → { transient: boolean }
 *   - addListener('audioFocusGained',...)          → {}
 *   - window 'audioFocusLost' / 'audioFocusGained' CustomEvent (backup path)
 */
@CapacitorPlugin(name = "BackgroundAudio")
public class BackgroundAudioPlugin extends Plugin {

    private static final String TAG = "BackgroundAudioPlugin";

    private static final String WAKELOCK_TAG = "GlobalRadio:Playback";
    private static final String WIFILOCK_TAG = "GlobalRadio:WifiLock";

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    // Audio focus state. The listener and AudioFocusRequest are built once,
    // up front, in load() so they have stable identities for the whole
    // lifetime of the plugin instance — and so the system holds the listener
    // strongly via the AudioFocusRequest (no GC surprise).
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest; // API 26+ (built lazily but only once)
    private AudioManager.OnAudioFocusChangeListener focusListener;
    private boolean focusHeld = false;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        super.load();
        // Eagerly create the listener so it exists with a stable identity
        // before anyone touches focus. requestAudioFocus() will reuse this
        // exact instance for AudioFocusRequest.setOnAudioFocusChangeListener.
        ensureFocusListener();
        // Pre-warm the AudioManager too — failure to fetch it here is
        // unusual, but logging it now means we never silently no-op later.
        ensureAudioManager();
        Log.i(TAG, "load() done; listener=" + System.identityHashCode(focusListener)
            + " audioManager=" + (audioManager != null));
    }

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
        int requestResult = -1;
        try {
            AudioManager am = ensureAudioManager();
            if (am == null) {
                Log.w(TAG, "requestAudioFocus: AudioManager null, can't request");
                JSObject result = new JSObject();
                result.put("granted", false);
                call.resolve(result);
                return;
            }
            ensureFocusListener();

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (audioFocusRequest == null) {
                    AudioAttributes attrs = new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build();
                    AudioFocusRequest.Builder b =
                        new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                            .setAudioAttributes(attrs)
                            .setAcceptsDelayedFocusGain(false)
                            .setOnAudioFocusChangeListener(focusListener, mainHandler);
                    // Tell the OS we'd rather pause than duck — radio streams
                    // sound terrible at -20 dB next to a navigation voice
                    // prompt, hard pause is the right behavior. Older devices
                    // ignore this hint, in which case our LOSS_TRANSIENT_CAN_DUCK
                    // listener still maps to a pause anyway.
                    try {
                        b.setWillPauseWhenDucked(true);
                    } catch (Throwable ignored) {
                        // Method exists on API 26+ but be defensive
                    }
                    audioFocusRequest = b.build();
                    Log.i(TAG, "requestAudioFocus: built AudioFocusRequest=" + System.identityHashCode(audioFocusRequest)
                        + " listener=" + System.identityHashCode(focusListener));
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
            Log.i(TAG, "requestAudioFocus result=" + requestResult
                + " (" + (granted ? "GRANTED"
                          : requestResult == AudioManager.AUDIOFOCUS_REQUEST_DELAYED ? "DELAYED"
                          : requestResult == AudioManager.AUDIOFOCUS_REQUEST_FAILED ? "FAILED" : "?")
                + ") focusHeld=" + focusHeld);
        } catch (Exception e) {
            Log.w(TAG, "requestAudioFocus threw", e);
        }
        JSObject result = new JSObject();
        result.put("granted", granted);
        result.put("rawResult", requestResult);
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
                int result;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    if (audioFocusRequest != null) {
                        result = am.abandonAudioFocusRequest(audioFocusRequest);
                        Log.i(TAG, "abandonAudioFocusRequest result=" + result);
                    }
                } else if (focusListener != null) {
                    result = am.abandonAudioFocus(focusListener);
                    Log.i(TAG, "abandonAudioFocus(listener) result=" + result);
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
            // The framework dispatches on mainHandler when we passed it to
            // AudioFocusRequest. Even so, treat this as opaque-thread and
            // route everything through the standard plumbing.
            Log.i(TAG, "onAudioFocusChange focusChange=" + focusChange
                + " focusHeld(was)=" + focusHeld);
            switch (focusChange) {
                case AudioManager.AUDIOFOCUS_LOSS: {
                    focusHeld = false;
                    JSObject data = new JSObject();
                    data.put("transient", false);
                    data.put("canDuck", false);
                    notifyAudioFocusLost(data);
                    break;
                }
                case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT: {
                    focusHeld = false;
                    JSObject data = new JSObject();
                    data.put("transient", true);
                    data.put("canDuck", false);
                    notifyAudioFocusLost(data);
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
                    notifyAudioFocusLost(data);
                    break;
                }
                case AudioManager.AUDIOFOCUS_GAIN: {
                    focusHeld = true;
                    notifyAudioFocusGained();
                    break;
                }
                default:
                    Log.d(TAG, "Audio focus change (unhandled): " + focusChange);
            }
        };
        Log.i(TAG, "ensureFocusListener built listener=" + System.identityHashCode(focusListener));
    }

    /**
     * Belt-and-braces JS dispatch for an AUDIOFOCUS_LOSS:
     *   1. Capacitor plugin event {@code audioFocusLost} (the standard path).
     *   2. window-level CustomEvent (in case JS hadn't subscribed via the
     *      Capacitor listener yet — registers earlier in app boot, no async
     *      bridge handshake needed).
     *   3. Direct DOM-level pause of every {@code <audio>} on the page,
     *      evaluated against the WebView. This is the actual user-facing
     *      action; even if all our event plumbing somehow fails, the audio
     *      goes silent. JS-level state will reconcile via the audio
     *      element's own pause event handler.
     */
    private void notifyAudioFocusLost(JSObject data) {
        Log.i(TAG, "notifyAudioFocusLost transient=" + data.optBoolean("transient", false)
            + " canDuck=" + data.optBoolean("canDuck", false));
        try {
            notifyListeners("audioFocusLost", data);
        } catch (Exception e) {
            Log.w(TAG, "notifyListeners(audioFocusLost) threw", e);
        }
        try {
            String json = data.toString();
            String js = "window.dispatchEvent(new CustomEvent('audioFocusLost', { detail: " + json + " }));"
                + "document.querySelectorAll('audio').forEach(function(a){ try { a.pause(); } catch(e) {} });";
            evalOnWebView(js);
        } catch (Exception e) {
            Log.w(TAG, "evalOnWebView(audioFocusLost) threw", e);
        }
    }

    private void notifyAudioFocusGained() {
        Log.i(TAG, "notifyAudioFocusGained");
        try {
            notifyListeners("audioFocusGained", new JSObject());
        } catch (Exception e) {
            Log.w(TAG, "notifyListeners(audioFocusGained) threw", e);
        }
        try {
            // Don't auto-play from native — let JS decide based on whether
            // it was paused by us (transient loss) or by user. Just dispatch
            // the event so JS can react.
            String js = "window.dispatchEvent(new CustomEvent('audioFocusGained', { detail: {} }));";
            evalOnWebView(js);
        } catch (Exception e) {
            Log.w(TAG, "evalOnWebView(audioFocusGained) threw", e);
        }
    }

    private void evalOnWebView(final String js) {
        // Bridge isn't always available off the main thread; hop to main.
        if (Looper.myLooper() == Looper.getMainLooper()) {
            evalNow(js);
        } else {
            mainHandler.post(() -> evalNow(js));
        }
    }

    private void evalNow(String js) {
        try {
            if (getBridge() != null && getBridge().getWebView() != null) {
                getBridge().getWebView().evaluateJavascript(js, (ValueCallback<String>) value -> {
                    // We don't care about the return value, just that it ran.
                });
            } else {
                Log.w(TAG, "evalOnWebView: bridge/webview null, can't run js");
            }
        } catch (Exception e) {
            Log.w(TAG, "evaluateJavascript threw", e);
        }
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
