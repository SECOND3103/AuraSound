package com.aurasound.app;

import android.content.ComponentName;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.AssetFileDescriptor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.media.AudioAttributes;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.media.MediaMetadataRetriever;
import android.media.MediaRouter;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.MimeTypes;
import androidx.media3.session.MediaController;
import androidx.media3.session.SessionToken;
import androidx.palette.graphics.Palette;
import com.getcapacitor.BridgeActivity;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Locale;
import java.util.Objects;
import java.util.concurrent.Executor;
import java.util.function.Consumer;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import java.util.zip.ZipOutputStream;
import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends BridgeActivity {
    private static final int REQUEST_EXPORT_BACKUP = 2601;
    private static final int REQUEST_IMPORT_BACKUP = 2602;
    private static volatile String currentView = "home";
    private static volatile boolean overlayOpen = false;
    private static WeakReference<WebView> webViewRef;
    private File currentImportFile;
    private FileOutputStream currentImportStream;
    private MediaController mediaController;
    private ListenableFuture<MediaController> mediaControllerFuture;
    private File musicDirectory;
    private String pendingBackupJson;
    private final ArrayDeque<Consumer<MediaController>> pendingPlayerCommands = new ArrayDeque<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final AudioAttributes musicAttributes = new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build();
    private final MediaRouter.SimpleCallback mediaRouteChanges = new MediaRouter.SimpleCallback() {
        @Override public void onRouteSelected(MediaRouter router, int type, MediaRouter.RouteInfo route) { updateAudioOutput(); }
        @Override public void onRouteChanged(MediaRouter router, MediaRouter.RouteInfo route) { updateAudioOutput(); }
    };
    private final AudioDeviceCallback audioDeviceChanges = new AudioDeviceCallback() {
        @Override public void onAudioDevicesAdded(AudioDeviceInfo[] devices) { updateAudioOutput(); }
        @Override public void onAudioDevicesRemoved(AudioDeviceInfo[] devices) { updateAudioOutput(); }
    };

    private void updateAudioOutput() {
        AudioManager audio = getSystemService(AudioManager.class);
        MediaRouter router = getSystemService(MediaRouter.class);
        MediaRouter.RouteInfo route = router.getSelectedRoute(MediaRouter.ROUTE_TYPE_LIVE_AUDIO);
        boolean bluetoothRoute = route != null && route.getDeviceType() == MediaRouter.RouteInfo.DEVICE_TYPE_BLUETOOTH;
        String kind = "";
        CharSequence name = "";
        java.util.List<AudioDeviceInfo> devices = Build.VERSION.SDK_INT >= 33
                ? audio.getAudioDevicesForAttributes(musicAttributes) : java.util.Collections.emptyList();
        for (AudioDeviceInfo device : devices) {
            switch (device.getType()) {
                case AudioDeviceInfo.TYPE_BLUETOOTH_A2DP:
                case AudioDeviceInfo.TYPE_BLUETOOTH_SCO:
                case AudioDeviceInfo.TYPE_BLE_HEADSET:
                case AudioDeviceInfo.TYPE_HEARING_AID:
                    kind = "bluetooth";
                    name = bluetoothRoute ? route.getName() : device.getProductName();
                    break;
                case AudioDeviceInfo.TYPE_WIRED_HEADSET:
                case AudioDeviceInfo.TYPE_WIRED_HEADPHONES:
                case AudioDeviceInfo.TYPE_USB_HEADSET:
                    kind = "wired";
                    name = "유선 이어폰";
                    break;
                default: continue;
            }
            break;
        }
        if (devices.isEmpty()) {
            if (bluetoothRoute) {
                kind = "bluetooth";
                name = route.getName();
            } else if (audio.isWiredHeadsetOn()) {
                kind = "wired";
                name = "유선 이어폰";
            }
        }
        if (kind.equals("bluetooth") && (name == null || name.length() == 0)) name = "블루투스 오디오";
        getBridge().getWebView().evaluateJavascript("window.app?.setAudioOutput("
                + JSONObject.quote(kind) + "," + JSONObject.quote(name.toString()) + ","
                + (Build.VERSION.SDK_INT >= 34) + ")", null);
    }

    @Override
    public void onCreate(Bundle bundle) {
        super.onCreate(bundle);
        WebView webView = getBridge().getWebView();
        applyStatusBarAppearance();
        webViewRef = new WeakReference<>(webView);
        webView.addJavascriptInterface(new AuraSoundBridge(), "AuraSoundNative");
        getOnBackPressedDispatcher().addCallback(this, new BackPressCallback(true));
        File externalFilesDir = getExternalFilesDir(Environment.DIRECTORY_MUSIC);
        if (externalFilesDir == null) {
            externalFilesDir = getFilesDir();
        }
        File file = new File(externalFilesDir, "AuraSound");
        this.musicDirectory = file;
        if (!file.exists()) {
            this.musicDirectory.mkdirs();
        }
        if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(this, "android.permission.POST_NOTIFICATIONS") == 0) {
            return;
        }
        ActivityCompat.requestPermissions(this, new String[]{"android.permission.POST_NOTIFICATIONS"}, 202);
    }

    class BackPressCallback extends OnBackPressedCallback {
        BackPressCallback(boolean z) {
            super(z);
        }

        @Override
        public void handleOnBackPressed() {
            WebView webView = MainActivity.webViewRef != null ? (WebView) MainActivity.webViewRef.get() : null;
            if (webView == null) {
                MainActivity.this.finish();
            } else {
                webView.evaluateJavascript("window.app && typeof window.app.handleBackNavigation === 'function' ? window.app.handleBackNavigation() : false;", new ValueCallback() {
                    @Override
                    public final void onReceiveValue(Object obj) {
                        BackPressCallback.this.lambda$handleOnBackPressed$0((String) obj);
                    }
                });
            }
        }

        public void lambda$handleOnBackPressed$0(String str) {
            if ("false".equals(str) || "null".equals(str)) {
                MainActivity.this.finish();
            }
        }
    }

    private void applyStatusBarAppearance() {
        getWindow().setStatusBarColor(Color.BLACK);
        WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView()).setAppearanceLightStatusBars(false);
    }

    @Override
    public void onResume() {
        super.onResume();
        applyStatusBarAppearance();
    }

    @Override
    public void onWindowFocusChanged(boolean z) {
        super.onWindowFocusChanged(z);
        if (z) {
            applyStatusBarAppearance();
        }
    }

    private void connectToPlaybackService() {
        if (this.mediaController == null && this.mediaControllerFuture == null) {
            ListenableFuture<MediaController> listenableFutureBuildAsync = new MediaController.Builder(this, new SessionToken(this, new ComponentName(this, (Class<?>) AuraSoundPlaybackService.class))).buildAsync();
            this.mediaControllerFuture = listenableFutureBuildAsync;
            Runnable runnable = new Runnable() {
                @Override
                public final void run() {
                    MainActivity.this.lambda$connectToPlaybackService$0();
                }
            };
            final Handler handler = this.mainHandler;
            Objects.requireNonNull(handler);
            listenableFutureBuildAsync.addListener(runnable, new Executor() {
                @Override
                public final void execute(Runnable runnable2) {
                    handler.post(runnable2);
                }
            });
        }
    }

    public void lambda$connectToPlaybackService$0() {
        try {
            this.mediaController = this.mediaControllerFuture.get();
            while (!this.pendingPlayerCommands.isEmpty()) {
                Consumer<MediaController> consumerPoll = this.pendingPlayerCommands.poll();
                if (consumerPoll != null) {
                    consumerPoll.accept(this.mediaController);
                }
            }
        } catch (Exception unused) {
            this.pendingPlayerCommands.clear();
        }
    }

    public void withMediaController(final Consumer<MediaController> consumer) {
        runOnUiThread(new Runnable() {
            @Override
            public final void run() {
                MainActivity.this.lambda$withMediaController$1(consumer);
            }
        });
    }

    public void lambda$withMediaController$1(Consumer consumer) {
        MediaController mediaController = this.mediaController;
        if (mediaController != null) {
            consumer.accept(mediaController);
        } else if (this.pendingPlayerCommands.size() < 32) {
            this.pendingPlayerCommands.add(consumer);
        }
    }

    public void loadTrackIntoPlayer(final JSONObject jSONObject) {
        withMediaController(new Consumer() {
            @Override
            public final void accept(Object obj) {
                MainActivity.this.lambda$loadTrackIntoPlayer$2(jSONObject, (MediaController) obj);
            }
        });
    }

    public void lambda$loadTrackIntoPlayer$2(JSONObject jSONObject, MediaController mediaController) {
        String strOptString = jSONObject.optString("trackId", "");
        String strOptString2 = jSONObject.optString("title", "AuraSound");
        String strOptString3 = jSONObject.optString("artist", "");
        String strOptString4 = jSONObject.optString("album", "");
        String strOptString5 = jSONObject.optString("artworkData", "");
        String strOptString6 = jSONObject.optString("filePath", "");
        float fOptDouble = (float) jSONObject.optDouble("speed", 1.0d);
        File fileResolveMusicFile = resolveMusicFile(strOptString6);
        if (fileResolveMusicFile == null || !fileResolveMusicFile.isFile()) {
            sendMediaAction("error", null);
            return;
        }
        MediaItem currentMediaItem = mediaController.getCurrentMediaItem();
        if (currentMediaItem == null || !strOptString.equals(currentMediaItem.mediaId) || (!mediaController.isPlaying() && mediaController.getPlaybackState() == 1)) {
            MediaMetadata.Builder albumTitle = new MediaMetadata.Builder().setTitle(strOptString2.isEmpty() ? "AuraSound" : strOptString2).setArtist(strOptString3).setAlbumTitle(strOptString4);
            byte[] bArrDecodeArtwork = decodeArtwork(strOptString5);
            if (bArrDecodeArtwork != null && bArrDecodeArtwork.length > 0) {
                albumTitle.setArtworkData(bArrDecodeArtwork, 3);
            }
            MediaItem.Builder builder = new MediaItem.Builder();
            if (strOptString.isEmpty()) {
                strOptString = fileResolveMusicFile.getName();
            }
            mediaController.setMediaItem(builder.setMediaId(strOptString).setUri(Uri.fromFile(fileResolveMusicFile)).setMediaMetadata(albumTitle.build()).build(), Math.round(Math.max(0.0d, jSONObject.optDouble("position", 0.0d)) * 1000.0d));
            if (fOptDouble <= 0.0f) {
                fOptDouble = 1.0f;
            }
            mediaController.setPlaybackSpeed(fOptDouble);
            mediaController.prepare();
            mediaController.pause();
        }
    }

    public void syncQueueIntoPlayer(final JSONObject jSONObject) {
        withMediaController(new Consumer() {
            @Override
            public final void accept(Object obj) {
                MainActivity.this.lambda$syncQueueIntoPlayer$3(jSONObject, (MediaController) obj);
            }
        });
    }

    public void lambda$syncQueueIntoPlayer$3(JSONObject jSONObject, MediaController mediaController) {
        String str;
        int iMax;
        File fileResolveMusicFile;
        try {
            JSONArray jSONArrayOptJSONArray = jSONObject.optJSONArray("items");
            if (jSONArrayOptJSONArray != null && jSONArrayOptJSONArray.length() != 0) {
                ArrayList arrayList = new ArrayList();
                HashMap<String, byte[]> artworkCache = new HashMap<>();
                int i = 0;
                while (true) {
                    str = "";
                    if (i >= jSONArrayOptJSONArray.length()) {
                        break;
                    }
                    JSONObject jSONObjectOptJSONObject = jSONArrayOptJSONArray.optJSONObject(i);
                    if (jSONObjectOptJSONObject != null && (fileResolveMusicFile = resolveMusicFile(jSONObjectOptJSONObject.optString("filePath", ""))) != null && fileResolveMusicFile.isFile()) {
                        MediaMetadata.Builder albumTitle = new MediaMetadata.Builder().setTitle(jSONObjectOptJSONObject.optString("title", "AuraSound")).setArtist(jSONObjectOptJSONObject.optString("artist", "")).setAlbumTitle(jSONObjectOptJSONObject.optString("album", ""));
                        String artwork = jSONObjectOptJSONObject.optString("artworkData", "");
                        byte[] bArrDecodeArtwork = artworkCache.get(artwork);
                        if (bArrDecodeArtwork == null && !artwork.isEmpty()) {
                            bArrDecodeArtwork = decodeArtwork(artwork);
                            if (bArrDecodeArtwork != null) artworkCache.put(artwork, bArrDecodeArtwork);
                        }
                        if (bArrDecodeArtwork != null && bArrDecodeArtwork.length > 0) {
                            albumTitle.setArtworkData(bArrDecodeArtwork, 3);
                        }
                        arrayList.add(new MediaItem.Builder().setMediaId(jSONObjectOptJSONObject.optString("trackId", fileResolveMusicFile.getName())).setUri(Uri.fromFile(fileResolveMusicFile)).setMediaMetadata(albumTitle.build()).build());
                    }
                    i++;
                }
                if (arrayList.isEmpty()) {
                    mediaController.pause();
                    mediaController.clearMediaItems();
                    if (jSONArrayOptJSONArray.length() > 0) {
                        sendMediaAction("error", null);
                        return;
                    }
                    return;
                }
                String strOptString = jSONObject.optString("currentTrackId", "");
                if (strOptString.isEmpty()) {
                    iMax = -1;
                } else {
                    iMax = 0;
                    while (true) {
                        if (iMax >= arrayList.size()) {
                            iMax = -1;
                            break;
                        } else if (strOptString.equals(((MediaItem) arrayList.get(iMax)).mediaId)) {
                            break;
                        } else {
                            iMax++;
                        }
                    }
                }
                if (iMax < 0 && strOptString.isEmpty()) {
                    JSONObject jSONObjectOptJSONObject2 = jSONArrayOptJSONArray.optJSONObject(Math.max(0, jSONObject.optInt("index", 0)));
                    String strOptString2 = jSONObjectOptJSONObject2 == null ? "" : jSONObjectOptJSONObject2.optString("trackId", "");
                    if (!strOptString2.isEmpty()) {
                        for (int i2 = 0; i2 < arrayList.size(); i2++) {
                            if (strOptString2.equals(((MediaItem) arrayList.get(i2)).mediaId)) {
                                iMax = i2;
                                break;
                            }
                        }
                    }
                }
                if (iMax < 0) {
                    if (!strOptString.isEmpty()) {
                        mediaController.pause();
                        mediaController.clearMediaItems();
                        sendMediaAction("error", null);
                        return;
                    }
                    iMax = Math.max(0, Math.min(jSONObject.optInt("index", 0), arrayList.size() - 1));
                }
                if (mediaController.getCurrentMediaItem() != null) {
                    str = mediaController.getCurrentMediaItem().mediaId;
                }
                String str2 = ((MediaItem) arrayList.get(iMax)).mediaId;
                if (!str.isEmpty() && str.equals(str2)) {
                    HashSet hashSet = new HashSet();
                    Iterator it = arrayList.iterator();
                    while (it.hasNext()) {
                        hashSet.add(((MediaItem) it.next()).mediaId);
                    }
                    for (int mediaItemCount = mediaController.getMediaItemCount() - 1; mediaItemCount >= 0; mediaItemCount--) {
                        if (!hashSet.contains(mediaController.getMediaItemAt(mediaItemCount).mediaId)) {
                            mediaController.removeMediaItem(mediaItemCount);
                        }
                    }
                    HashSet<String> existingIds = new HashSet<>();
                    boolean uniqueItems = hashSet.size() == arrayList.size();
                    for (int itemIndex = 0; itemIndex < mediaController.getMediaItemCount(); itemIndex++) {
                        if (!existingIds.add(mediaController.getMediaItemAt(itemIndex).mediaId)) uniqueItems = false;
                    }
                    for (int i3 = 0; i3 < arrayList.size(); i3++) {
                        MediaItem mediaItem = (MediaItem) arrayList.get(i3);
                        int i4 = uniqueItems && i3 < mediaController.getMediaItemCount()
                                && mediaItem.mediaId.equals(mediaController.getMediaItemAt(i3).mediaId) ? i3 : 0;
                        while (true) {
                            if (i4 >= mediaController.getMediaItemCount()) {
                                i4 = -1;
                                break;
                            } else if (mediaItem.mediaId.equals(mediaController.getMediaItemAt(i4).mediaId)) {
                                break;
                            } else {
                                i4++;
                            }
                        }
                        if (i4 < 0) {
                            mediaController.addMediaItem(Math.min(i3, mediaController.getMediaItemCount()), mediaItem);
                        } else if (i4 != i3) {
                            mediaController.moveMediaItem(i4, Math.min(i3, mediaController.getMediaItemCount() - 1));
                        }
                    }
                    int playbackState = mediaController.getPlaybackState();
                    if (playbackState == 1 || playbackState == 4) {
                        mediaController.seekTo(mediaController.getCurrentMediaItemIndex(), Math.max(0L, Math.round(jSONObject.optDouble("position", 0.0d) * 1000.0d)));
                        mediaController.prepare();
                        mediaController.pause();
                    } else {
                        sendPlaybackState(mediaController.isPlaying(), mediaController.getCurrentPosition(),
                                Math.max(0L, mediaController.getDuration()), mediaController.getPlaybackParameters().speed, str2);
                    }
                } else {
                    boolean zIsPlaying = mediaController.isPlaying();
                    mediaController.setMediaItems(arrayList, iMax, Math.max(0L, Math.round(jSONObject.optDouble("position", 0.0d) * 1000.0d)));
                    mediaController.prepare();
                    if (zIsPlaying) {
                        mediaController.play();
                    } else {
                        mediaController.pause();
                    }
                }
                mediaController.setRepeatMode(repeatModeFromString(jSONObject.optString("repeatMode", "off")));
                mediaController.setShuffleModeEnabled(jSONObject.optBoolean("shuffle", false));
                return;
            }
            mediaController.clearMediaItems();
        } catch (Exception unused) {
        }
    }

    private static int repeatModeFromString(String str) {
        if ("one".equals(str)) {
            return 1;
        }
        return "all".equals(str) ? 2 : 0;
    }

    public void syncRepeatMode(final String str) {
        withMediaController(new Consumer() {
            @Override
            public final void accept(Object obj) {
                ((MediaController) obj).setRepeatMode(MainActivity.repeatModeFromString(str));
            }
        });
    }

    public void syncShuffleMode(final boolean z) {
        withMediaController(new Consumer() {
            @Override
            public final void accept(Object obj) {
                ((MediaController) obj).setShuffleModeEnabled(z);
            }
        });
    }

    private void releaseMediaController() {
        ListenableFuture<MediaController> listenableFuture = this.mediaControllerFuture;
        if (listenableFuture != null) {
            MediaController.releaseFuture(listenableFuture);
            this.mediaControllerFuture = null;
        }
        this.mediaController = null;
        this.pendingPlayerCommands.clear();
    }

    @Override
    public void onStart() {
        super.onStart();
        connectToPlaybackService();
        getSystemService(MediaRouter.class).addCallback(MediaRouter.ROUTE_TYPE_LIVE_AUDIO, mediaRouteChanges);
        getSystemService(AudioManager.class).registerAudioDeviceCallback(audioDeviceChanges, mainHandler);
        updateAudioOutput();
    }

    @Override
    public void onStop() {
        getSystemService(MediaRouter.class).removeCallback(mediaRouteChanges);
        getSystemService(AudioManager.class).unregisterAudioDeviceCallback(audioDeviceChanges);
        releaseMediaController();
        super.onStop();
    }

    @Override
    public void onDestroy() {
        releaseMediaController();
        webViewRef = null;
        super.onDestroy();
    }

    public static void sendPlaybackState(boolean z, long j, long j2, float f, String str) {
        WeakReference<WebView> weakReference = webViewRef;
        final WebView webView = weakReference != null ? weakReference.get() : null;
        if (webView == null) {
            return;
        }
        StringBuilder sbAppend = new StringBuilder("window.__auraSoundNativePlaybackState && window.__auraSoundNativePlaybackState(").append(z).append(",").append(j).append(",").append(j2).append(",").append(f).append(",");
        if (str == null) {
            str = "";
        }
        final String string = sbAppend.append(JSONObject.quote(str)).append(");").toString();
        webView.post(new Runnable() {
            @Override
            public final void run() {
                webView.evaluateJavascript(string, null);
            }
        });
    }

    public static void sendMediaAction(String str, Object obj) {
        final String strValueOf;
        WeakReference<WebView> weakReference = webViewRef;
        final WebView webView = weakReference != null ? weakReference.get() : null;
        if (webView == null) {
            return;
        }
        final String strQuote = JSONObject.quote(str);
        if (obj == null) {
            strValueOf = "null";
        } else if ((obj instanceof Number) || (obj instanceof Boolean)) {
            strValueOf = String.valueOf(obj);
        } else {
            strValueOf = JSONObject.quote(String.valueOf(obj));
        }
        webView.post(new Runnable() {
            @Override
            public final void run() {
                webView.evaluateJavascript("window.__auraSoundNativeAction && window.__auraSoundNativeAction(" + strQuote + "," + strValueOf + ");", null);
            }
        });
    }

    private String sanitizeFileName(String str) {
        if (str == null) {
            str = MimeTypes.BASE_TYPE_AUDIO;
        }
        String strTrim = str.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        return strTrim.isEmpty() ? MimeTypes.BASE_TYPE_AUDIO : strTrim;
    }

    private File resolveMusicFile(String str) {
        if (str == null || !str.startsWith("Music/")) {
            return null;
        }
        String strSubstring = str.substring("Music/".length());
        if (strSubstring.contains("/") || strSubstring.contains("\\") || strSubstring.contains("..")) {
            return null;
        }
        return new File(this.musicDirectory, strSubstring);
    }

    private byte[] decodeArtwork(String str) {
        if (str != null && !str.isEmpty()) {
            try {
                int iIndexOf = str.indexOf(44);
                if (iIndexOf >= 0) {
                    str = str.substring(iIndexOf + 1);
                }
                return Base64.decode(str, 0);
            } catch (IllegalArgumentException unused) {
            }
        }
        return null;
    }

    private File findBackupSource(JSONObject jSONObject) {
        File file;
        File[] fileArrListFiles;
        File fileResolveMusicFile = resolveMusicFile(jSONObject.optString("filePath", ""));
        if (fileResolveMusicFile != null && fileResolveMusicFile.exists() && fileResolveMusicFile.isFile()) {
            return fileResolveMusicFile;
        }
        String strSanitizeFileName = sanitizeFileName(jSONObject.optString("id", ""));
        if (strSanitizeFileName.isEmpty() || (file = this.musicDirectory) == null || !file.isDirectory() || (fileArrListFiles = this.musicDirectory.listFiles()) == null) {
            return null;
        }
        String str = strSanitizeFileName + "_";
        for (File file2 : fileArrListFiles) {
            if (file2.isFile() && file2.getName().startsWith(str)) {
                return file2;
            }
        }
        return null;
    }

    public String beginImport(String str, String str2) throws IOException {
        cancelImport();
        String str3 = ((str == null || str.trim().isEmpty()) ? "track" : sanitizeFileName(str)) + "_" + sanitizeFileName(str2);
        File file = new File(this.musicDirectory, str3);
        int iLastIndexOf = str3.lastIndexOf(46);
        String strSubstring = iLastIndexOf > 0 ? str3.substring(0, iLastIndexOf) : str3;
        String strSubstring2 = iLastIndexOf > 0 ? str3.substring(iLastIndexOf) : "";
        int i = 1;
        while (file.exists()) {
            str3 = strSubstring + "_" + i + strSubstring2;
            i++;
            file = new File(this.musicDirectory, str3);
        }
        this.currentImportFile = file;
        this.currentImportStream = new FileOutputStream(file, false);
        return "Music/" + str3;
    }

    public void appendImport(String str) throws IOException {
        if (this.currentImportStream == null) {
            throw new IOException("No active import");
        }
        this.currentImportStream.write(Base64.decode(str, 0));
    }

    public void finishImport() throws IOException {
        FileOutputStream fileOutputStream = this.currentImportStream;
        if (fileOutputStream != null) {
            fileOutputStream.flush();
            this.currentImportStream.close();
        }
        this.currentImportStream = null;
        this.currentImportFile = null;
    }

    public void cancelImport() {
        try {
            FileOutputStream fileOutputStream = this.currentImportStream;
            if (fileOutputStream != null) {
                fileOutputStream.close();
            }
        } catch (IOException unused) {
        }
        this.currentImportStream = null;
        File file = this.currentImportFile;
        if (file != null && file.exists()) {
            this.currentImportFile.delete();
        }
        this.currentImportFile = null;
    }

    public boolean deleteMusicFile(String str) {
        File fileResolveMusicFile = resolveMusicFile(str);
        if (fileResolveMusicFile == null) {
            return false;
        }
        return (fileResolveMusicFile.exists() && !fileResolveMusicFile.delete() && fileResolveMusicFile.exists()) ? false : true;
    }

    public void clearMusicFiles() {
        File[] fileArrListFiles;
        File file = this.musicDirectory;
        if (file == null || !file.exists() || (fileArrListFiles = this.musicDirectory.listFiles()) == null) {
            return;
        }
        for (File file2 : fileArrListFiles) {
            if (file2.isFile()) {
                file2.delete();
            }
        }
    }

    public long getMusicFileSize(String str) {
        File fileResolveMusicFile = resolveMusicFile(str);
        if (fileResolveMusicFile == null || !fileResolveMusicFile.exists()) {
            return -1L;
        }
        return fileResolveMusicFile.length();
    }

    public String readMusicFileChunk(String str, long j, int i) throws IOException {
        File fileResolveMusicFile = resolveMusicFile(str);
        if (fileResolveMusicFile == null || !fileResolveMusicFile.exists()) {
            throw new IOException("Music file not found");
        }
        if (j < 0 || i < 0 || j > fileResolveMusicFile.length()) {
            throw new IOException("Invalid file range");
        }
        int length = (int) Math.min(i, fileResolveMusicFile.length() - j);
        byte[] bytes = new byte[length];
        try (FileInputStream input = new FileInputStream(fileResolveMusicFile)) {
            input.getChannel().position(j);
            int bytesRead = 0;
            while (bytesRead < length) {
                int read = input.read(bytes, bytesRead, length - bytesRead);
                if (read < 0) break;
                bytesRead += read;
            }
            return Base64.encodeToString(bytes, 0, bytesRead, Base64.NO_WRAP);
        }
    }

    private void sendBackupResult(String str, String str2) {
        WeakReference<WebView> weakReference = webViewRef;
        final WebView webView = weakReference != null ? weakReference.get() : null;
        if (webView == null) {
            return;
        }
        StringBuilder sbAppend = new StringBuilder("window.__auraSoundBackupResult && window.__auraSoundBackupResult(").append(JSONObject.quote(str)).append(",");
        if (str2 == null) {
            str2 = "";
        }
        final String string = sbAppend.append(JSONObject.quote(str2)).append(");").toString();
        webView.post(new Runnable() {
            @Override
            public final void run() {
                webView.evaluateJavascript(string, null);
            }
        });
    }

    private String sanitizeBackupEntryName(String str) {
        String strReplaceAll = str == null ? "file" : str.replaceAll("[^a-zA-Z0-9._-]", "_");
        return strReplaceAll.isEmpty() ? "file" : strReplaceAll;
    }

    public void launchBackupExport(String str) {
        this.pendingBackupJson = str;
        Intent intent = new Intent("android.intent.action.CREATE_DOCUMENT");
        intent.addCategory("android.intent.category.OPENABLE");
        intent.setType("application/octet-stream");
        intent.putExtra("android.intent.extra.TITLE", "AuraSound-" + new SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(new Date()) + ".asbackup");
        startActivityForResult(intent, REQUEST_EXPORT_BACKUP);
    }

    public void launchBackupImport() {
        Intent intent = new Intent("android.intent.action.OPEN_DOCUMENT");
        intent.addCategory("android.intent.category.OPENABLE");
        intent.setType("application/octet-stream");
        intent.putExtra("android.intent.extra.MIME_TYPES", new String[]{"application/octet-stream", "application/zip", "*/*"});
        startActivityForResult(intent, REQUEST_IMPORT_BACKUP);
    }

    private void writeTextEntry(ZipOutputStream zipOutputStream, String str, String str2) throws IOException {
        zipOutputStream.putNextEntry(new ZipEntry(str));
        zipOutputStream.write(str2.getBytes(StandardCharsets.UTF_8));
        zipOutputStream.closeEntry();
    }

    private void exportBackup(Uri uri, String backupJson) throws Exception {
        if (backupJson == null) {
            throw new IOException("백업 데이터가 없습니다.");
        }
        JSONObject jSONObject = new JSONObject(backupJson);
        JSONArray jSONArrayOptJSONArray = jSONObject.optJSONArray("tracks");
        if (jSONArrayOptJSONArray == null) {
            jSONArrayOptJSONArray = new JSONArray();
        }
        OutputStream outputStreamOpenOutputStream = getContentResolver().openOutputStream(uri);
        if (outputStreamOpenOutputStream == null) {
            throw new IOException("백업 파일을 만들 수 없습니다.");
        }
        try {
            try {
                ZipOutputStream zipOutputStream = new ZipOutputStream(outputStreamOpenOutputStream);
                try {
                    writeTextEntry(zipOutputStream, "manifest.json", new JSONObject().put("format", "AuraSoundBackup").put("version", 1).put("appVersion", "1.0.2").toString());
                    writeTextEntry(zipOutputStream, "tracks.json", jSONArrayOptJSONArray.toString());
                    String string = "[]";
                    writeTextEntry(zipOutputStream, "playlists.json", jSONObject.optJSONArray("playlists") == null ? "[]" : jSONObject.optJSONArray("playlists").toString());
                    if (jSONObject.optJSONArray("appState") != null) {
                        string = jSONObject.optJSONArray("appState").toString();
                    }
                    writeTextEntry(zipOutputStream, "appState.json", string);
                    writeTextEntry(zipOutputStream, "artistCovers.json", jSONObject.optJSONObject("artistCovers") == null ? "{}" : jSONObject.optJSONObject("artistCovers").toString());
                    byte[] bArr = new byte[65536];
                    for (int i = 0; i < jSONArrayOptJSONArray.length(); i++) {
                        JSONObject jSONObjectOptJSONObject = jSONArrayOptJSONArray.optJSONObject(i);
                        if (jSONObjectOptJSONObject != null) {
                            String strOptString = jSONObjectOptJSONObject.optString("filePath", "");
                            File fileFindBackupSource = findBackupSource(jSONObjectOptJSONObject);
                            if (fileFindBackupSource == null) {
                                throw new IOException("음악 파일을 찾을 수 없습니다: " + jSONObjectOptJSONObject.optString("fileName", strOptString));
                            }
                            zipOutputStream.putNextEntry(new ZipEntry("music/" + sanitizeBackupEntryName(jSONObjectOptJSONObject.optString("backupFile", "track-" + i + "-" + sanitizeBackupEntryName(fileFindBackupSource.getName())))));
                            FileInputStream fileInputStream = new FileInputStream(fileFindBackupSource);
                            while (true) {
                                try {
                                    int i2 = fileInputStream.read(bArr);
                                    if (i2 == -1) {
                                        break;
                                    } else {
                                        zipOutputStream.write(bArr, 0, i2);
                                    }
                                } catch (Throwable th) {
                                    try {
                                        fileInputStream.close();
                                    } catch (Throwable th2) {
                                        th.addSuppressed(th2);
                                    }
                                    throw th;
                                }
                            }
                            fileInputStream.close();
                            zipOutputStream.closeEntry();
                        }
                    }
                    zipOutputStream.finish();
                    zipOutputStream.close();
                    if (outputStreamOpenOutputStream != null) {
                        outputStreamOpenOutputStream.close();
                    }
                    this.pendingBackupJson = null;
                } catch (Throwable th5) {
                    zipOutputStream.close();
                    throw th5;
                }
            } catch (Throwable th6) {
                if (outputStreamOpenOutputStream != null) {
                    outputStreamOpenOutputStream.close();
                }
                throw th6;
            }
        } catch (Throwable th7) {
            this.pendingBackupJson = null;
            throw th7;
        }
    }

    private String readZipText(ZipInputStream zipInputStream, ZipEntry zipEntry) throws IOException {
        ByteArrayOutputStream byteArrayOutputStream = new ByteArrayOutputStream();
        byte[] bArr = new byte[16384];
        do {
            int i = zipInputStream.read(bArr);
            if (i != -1) {
                byteArrayOutputStream.write(bArr, 0, i);
            } else {
                return byteArrayOutputStream.toString(StandardCharsets.UTF_8.name());
            }
        } while (byteArrayOutputStream.size() <= 16777216);
        throw new IOException("백업 메타데이터가 너무 큽니다.");
    }

    private String uniqueMusicName(String str) {
        String strSanitizeFileName = sanitizeFileName(str);
        File file = new File(this.musicDirectory, strSanitizeFileName);
        int iLastIndexOf = strSanitizeFileName.lastIndexOf(46);
        String strSubstring = iLastIndexOf > 0 ? strSanitizeFileName.substring(0, iLastIndexOf) : strSanitizeFileName;
        String strSubstring2 = iLastIndexOf > 0 ? strSanitizeFileName.substring(iLastIndexOf) : "";
        int i = 1;
        while (file.exists()) {
            file = new File(this.musicDirectory, strSubstring + "_" + i + strSubstring2);
            i++;
        }
        return file.getName();
    }

    private void deleteDirectory(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        File[] fileArrListFiles = file.listFiles();
        if (fileArrListFiles != null) {
            for (File file2 : fileArrListFiles) {
                if (file2.isDirectory()) {
                    deleteDirectory(file2);
                } else {
                    file2.delete();
                }
            }
        }
        file.delete();
    }

    private static final class CountingInputStream extends FilterInputStream {
        private final MainActivity activity;
        private long bytesRead;
        private long lastReportedBytes;
        private final long totalBytes;

        CountingInputStream(InputStream inputStream, long j, MainActivity mainActivity) {
            super(inputStream);
            this.bytesRead = 0L;
            this.lastReportedBytes = 0L;
            this.totalBytes = j;
            this.activity = mainActivity;
        }

        @Override
        public int read() throws IOException {
            int i = super.read();
            if (i >= 0) {
                this.bytesRead++;
                reportProgress();
            }
            return i;
        }

        @Override
        public int read(byte[] bArr, int i, int i2) throws IOException {
            int i3 = super.read(bArr, i, i2);
            if (i3 > 0) {
                this.bytesRead += (long) i3;
                reportProgress();
            }
            return i3;
        }

        private void reportProgress() {
            long j = this.totalBytes;
            if (j > 0) {
                long j2 = this.bytesRead;
                if (j2 - this.lastReportedBytes < 524288) {
                    return;
                }
                this.lastReportedBytes = j2;
                this.activity.sendImportProgress((int) Math.min(65L, ((j2 * 60) / j) + 5), "백업 파일을 읽는 중입니다.");
            }
        }
    }

    private long getUriSize(Uri uri) {
        long length;
        try {
            AssetFileDescriptor assetFileDescriptorOpenAssetFileDescriptor = getContentResolver().openAssetFileDescriptor(uri, "r");
            if (assetFileDescriptorOpenAssetFileDescriptor == null) {
                length = -1;
            } else {
                try {
                    length = assetFileDescriptorOpenAssetFileDescriptor.getLength();
                } catch (Throwable th) {
                    if (assetFileDescriptorOpenAssetFileDescriptor != null) {
                        try {
                            assetFileDescriptorOpenAssetFileDescriptor.close();
                        } catch (Throwable th2) {
                            th.addSuppressed(th2);
                        }
                    }
                    throw th;
                }
            }
            if (assetFileDescriptorOpenAssetFileDescriptor != null) {
                assetFileDescriptorOpenAssetFileDescriptor.close();
            }
            return length;
        } catch (Exception unused) {
            return -1L;
        }
    }

    public void sendImportProgress(int i, String str) {
        JSONObject jSONObject = new JSONObject();
        try {
            jSONObject.put("percent", Math.max(0, Math.min(100, i)));
            if (str == null) {
                str = "불러오는 중입니다.";
            }
            jSONObject.put("message", str);
        } catch (Exception unused) {
        }
        sendBackupResult("progress", jSONObject.toString());
    }

    private String importBackup(Uri uri, long totalBytes) throws Exception {
        File temporaryDirectory = new File(this.musicDirectory, ".backup_import_" + System.currentTimeMillis());
        if (!temporaryDirectory.mkdirs()) {
            throw new IOException("임시 백업 폴더를 만들 수 없습니다.");
        }

        String tracksJson = "[]";
        String playlistsJson = "[]";
        String appStateJson = "[]";
        String artistCoversJson = "{}";

        InputStream sourceStream = getContentResolver().openInputStream(uri);
        if (sourceStream == null) {
            throw new IOException("백업 파일을 열 수 없습니다.");
        }

        try (CountingInputStream countingStream = new CountingInputStream(sourceStream, totalBytes, this);
             ZipInputStream zipStream = new ZipInputStream(countingStream)) {
            sendImportProgress(5, "백업 파일을 열었습니다.");
            byte[] buffer = new byte[65536];
            ZipEntry entry;
            while ((entry = zipStream.getNextEntry()) != null) {
                String entryName = entry.getName();
                if (entryName.contains("..") || entryName.startsWith("/") || entryName.startsWith("\\")) {
                    throw new IOException("잘못된 백업 경로입니다.");
                }

                if ("manifest.json".equals(entryName)) {
                    JSONObject manifest = new JSONObject(readZipText(zipStream, entry));
                    if (!"AuraSoundBackup".equals(manifest.optString("format"))) {
                        throw new IOException("AuraSound 백업 파일이 아닙니다.");
                    }
                } else if ("tracks.json".equals(entryName)) {
                    tracksJson = readZipText(zipStream, entry);
                } else if ("playlists.json".equals(entryName)) {
                    playlistsJson = readZipText(zipStream, entry);
                } else if ("appState.json".equals(entryName)) {
                    appStateJson = readZipText(zipStream, entry);
                } else if ("artistCovers.json".equals(entryName)) {
                    artistCoversJson = readZipText(zipStream, entry);
                } else if (entryName.startsWith("music/") && !entry.isDirectory()) {
                    String fileName = entryName.substring("music/".length());
                    if (fileName.isEmpty() || fileName.contains("/") || fileName.contains("\\")) {
                        throw new IOException("잘못된 음악 파일 경로입니다.");
                    }
                    File extractedFile = new File(temporaryDirectory, sanitizeFileName(fileName));
                    try (FileOutputStream output = new FileOutputStream(extractedFile, false)) {
                        int read;
                        while ((read = zipStream.read(buffer)) != -1) {
                            output.write(buffer, 0, read);
                        }
                    }
                }
                zipStream.closeEntry();
            }
        }

        sendImportProgress(65, "백업 파일의 정보를 확인하고 있습니다.");
        JSONArray sourceTracks = new JSONArray(tracksJson);
        JSONArray restoredTracks = new JSONArray();
        JSONArray trackResults = new JSONArray();
        int trackCount = Math.max(1, sourceTracks.length());

        for (int index = 0; index < sourceTracks.length(); index++) {
            JSONObject sourceTrack = sourceTracks.optJSONObject(index);
            if (sourceTrack != null) {
                String trackId = sourceTrack.optString("id", "");
                String title = sourceTrack.optString("title", sourceTrack.optString("fileName", "이름 없는 곡"));
                JSONObject result = new JSONObject();
                result.put("id", trackId);
                result.put("title", title);
                try {
                    String backupFileName = sourceTrack.optString("backupFile", "");
                    if (backupFileName.isEmpty()) {
                        result.put("status", "failed");
                        result.put("reason", "백업 파일 정보가 없습니다.");
                    } else {
                        File extractedFile = new File(temporaryDirectory, sanitizeFileName(backupFileName));
                        if (!extractedFile.exists()) {
                            result.put("status", "failed");
                            result.put("reason", "백업 안에서 음악 파일을 찾을 수 없습니다.");
                        } else {
                            String restoredFileName = uniqueMusicName(extractedFile.getName());
                            File restoredFile = new File(this.musicDirectory, restoredFileName);
                            if (!extractedFile.renameTo(restoredFile)) {
                                result.put("status", "failed");
                                result.put("reason", "음악 파일을 저장하지 못했습니다.");
                            } else {
                                sourceTrack.put("filePath", "Music/" + restoredFileName);
                                sourceTrack.remove("backupFile");
                                restoredTracks.put(sourceTrack);
                                result.put("status", "success");
                                result.put("reason", "불러오기 성공");
                            }
                        }
                    }
                } catch (Exception exception) {
                    result.put("status", "failed");
                    result.put("reason", exception.getMessage() == null
                            ? "곡 처리 중 오류가 발생했습니다."
                            : exception.getMessage());
                }
                trackResults.put(result);
            }
            int completed = index + 1;
            sendImportProgress(65 + (int) ((completed * 30.0) / trackCount),
                    "음악 파일을 복원하고 있습니다. (" + completed + "/" + sourceTracks.length() + ")");
        }

        deleteDirectory(temporaryDirectory);
        JSONObject result = new JSONObject();
        result.put("tracks", restoredTracks);
        result.put("trackResults", trackResults);
        result.put("playlists", new JSONArray(playlistsJson));
        result.put("appState", new JSONArray(appStateJson));
        result.put("artistCovers", new JSONObject(artistCoversJson));
        return result.toString();
    }

    @Override
    protected void onActivityResult(int i, int i2, Intent intent) {
        super.onActivityResult(i, i2, intent);
        if (i2 != -1 || intent == null || intent.getData() == null) {
            if (i == REQUEST_EXPORT_BACKUP || i == REQUEST_IMPORT_BACKUP) {
                sendBackupResult("cancel", "");
            }
            this.pendingBackupJson = null;
            return;
        }
        try {
            if (i == REQUEST_EXPORT_BACKUP) {
                final Uri destination = intent.getData();
                final String backupJson = this.pendingBackupJson;
                new Thread(() -> {
                    try {
                        exportBackup(destination, backupJson);
                        sendBackupResult("exported", "");
                    } catch (Exception exception) {
                        this.pendingBackupJson = null;
                        sendBackupResult("error", exception.getMessage() == null
                                ? "백업 처리에 실패했습니다." : exception.getMessage());
                    }
                }, "AuraSoundBackupExport").start();
            } else if (i == REQUEST_IMPORT_BACKUP) {
                final Uri data = intent.getData();
                sendImportProgress(1, "불러오기를 준비하고 있습니다.");
                new Thread(new Runnable() {
                    @Override
                    public final void run() {
                        MainActivity.this.lambda$onActivityResult$9(data);
                    }
                }, "AuraSoundBackupImport").start();
            }
        } catch (Exception e) {
            this.pendingBackupJson = null;
            sendBackupResult("error", e.getMessage() == null ? "백업 처리에 실패했습니다." : e.getMessage());
        }
    }

    public void lambda$onActivityResult$9(Uri uri) {
        try {
            String strImportBackup = importBackup(uri, getUriSize(uri));
            sendImportProgress(100, "불러오기가 완료되었습니다.");
            sendBackupResult("imported", strImportBackup);
        } catch (Exception e) {
            sendBackupResult("error", e.getMessage() == null ? "백업 처리에 실패했습니다." : e.getMessage());
        }
    }

    public String extractArtworkPaletteColor(String str) {
        int iRgb = Color.rgb(25, 20, 20);
        if (str != null && !str.isEmpty()) {
            Bitmap bitmap = null;
            try {
                int iIndexOf = str.indexOf(44);
                if (iIndexOf >= 0) {
                    str = str.substring(iIndexOf + 1);
                }
                byte[] bArrDecode = Base64.decode(str, 0);
                BitmapFactory.Options options = new BitmapFactory.Options();
                options.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(bArrDecode, 0, bArrDecode.length, options);
                if (options.outWidth > 0 && options.outHeight > 0) {
                    int i = 1;
                    while (Math.max(options.outWidth / i, options.outHeight / i) > 128) {
                        i *= 2;
                    }
                    BitmapFactory.Options options2 = new BitmapFactory.Options();
                    options2.inSampleSize = i;
                    options2.inPreferredConfig = Bitmap.Config.ARGB_8888;
                    bitmap = BitmapFactory.decodeByteArray(bArrDecode, 0, bArrDecode.length, options2);
                    if (bitmap != null) {
                        Palette palette = Palette.from(bitmap).maximumColorCount(24).generate();
                        int accent = palette.getDarkVibrantColor(palette.getVibrantColor(
                                palette.getDarkMutedColor(palette.getMutedColor(palette.getDominantColor(iRgb)))));
                        return String.format(Locale.US, "#%06X", accent & 0xFFFFFF);
                    }
                    return "#191414";
                }
                return "#191414";
            } catch (Exception unused) {
            } finally {
                if (bitmap != null && !bitmap.isRecycled()) {
                    bitmap.recycle();
                }
            }
        }
        return "#191414";
    }

    public class AuraSoundBridge {
        public AuraSoundBridge() {
        }

        @JavascriptInterface
        public void requestAudioOutput() {
            runOnUiThread(MainActivity.this::updateAudioOutput);
        }

        @JavascriptInterface
        public void openAudioOutput() {
            if (Build.VERSION.SDK_INT >= 34) {
                runOnUiThread(() -> android.media.MediaRouter2.getInstance(MainActivity.this).showSystemOutputSwitcher());
            }
        }

        @JavascriptInterface
        public double getMusicDuration(String relativePath) {
            File file = MainActivity.this.resolveMusicFile(relativePath);
            if (file == null || !file.isFile()) return 0;
            MediaMetadataRetriever retriever = new MediaMetadataRetriever();
            try {
                retriever.setDataSource(file.getAbsolutePath());
                String duration = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
                return duration == null ? 0 : Math.max(0, Long.parseLong(duration)) / 1000.0;
            } catch (Exception exception) {
                return 0;
            } finally {
                try { retriever.release(); } catch (Exception ignored) {}
            }
        }

        @JavascriptInterface
        public void getArtworkPaletteColor(String str, String str2) {
            String strExtractArtworkPaletteColor = MainActivity.this.extractArtworkPaletteColor(str);
            final WebView webView = MainActivity.webViewRef != null ? (WebView) MainActivity.webViewRef.get() : null;
            if (webView == null) {
                return;
            }
            StringBuilder sb = new StringBuilder("window.app && window.app.setMiniPlayerPaletteColor(");
            if (str2 == null) {
                str2 = "";
            }
            final String string = sb.append(JSONObject.quote(str2)).append(",").append(JSONObject.quote(strExtractArtworkPaletteColor)).append(");").toString();
            webView.post(new Runnable() {
                @Override
                public final void run() {
                    webView.evaluateJavascript(string, null);
                }
            });
        }

        @JavascriptInterface
        public String getSavedPlaybackState() {
            SharedPreferences sharedPreferences = MainActivity.this.getSharedPreferences("aurasound_playback", 0);
            JSONObject jSONObject = new JSONObject();
            try {
                jSONObject.put("trackId", sharedPreferences.getString("trackId", ""));
                jSONObject.put("position", Math.max(0L, sharedPreferences.getLong("positionMs", 0L)) / 1000.0d);
            } catch (Exception unused) {
            }
            return jSONObject.toString();
        }

        @JavascriptInterface
        public void postMessage(String str) {
            try {
                final JSONObject jSONObject = new JSONObject(str);
                String strOptString = jSONObject.optString("type", "");
                switch (strOptString.hashCode()) {
                    case -1091287984:
                        if (strOptString.equals("overlay")) {
                            MainActivity.overlayOpen = jSONObject.optBoolean("open", false);
                        }
                        break;
                    case -934531685:
                        if (strOptString.equals("repeat")) {
                            MainActivity.this.syncRepeatMode(jSONObject.optString("mode", "off"));
                        }
                        break;
                    case -810883302:
                        if (strOptString.equals("volume")) {
                            final float fMax = (float) Math.max(0.0d, Math.min(1.0d, jSONObject.optDouble("volume", 0.15d)));
                            MainActivity.this.getSharedPreferences("aurasound_playback", 0).edit().putFloat("volume", fMax).apply();
                            MainActivity.this.withMediaController(new Consumer() {
                                @Override
                                public final void accept(Object obj) {
                                    ((MediaController) obj).setVolume(fMax);
                                }
                            });
                        }
                        break;
                    case 3443508:
                        if (strOptString.equals("play")) {
                            MainActivity.this.withMediaController(new Consumer() {
                                @Override
                                public final void accept(Object obj) {
                                    ((MediaController) obj).play();
                                }
                            });
                        }
                        break;
                    case 3526264:
                        if (strOptString.equals("seek")) {
                            MainActivity.this.withMediaController(new Consumer() {
                                @Override
                                public final void accept(Object obj) {
                                    ((MediaController) obj).seekTo(Math.max(0L, Math.round(jSONObject.optDouble("position", 0.0d) * 1000.0d)));
                                }
                            });
                        }
                        break;
                    case 3540994:
                        if (strOptString.equals("stop")) {
                            MainActivity.this.withMediaController(new Consumer() {
                                @Override
                                public final void accept(Object obj) {
                                    ((MediaController) obj).stop();
                                }
                            });
                        }
                        break;
                    case 3619493:
                        if (strOptString.equals("view")) {
                            MainActivity.currentView = jSONObject.optString("view", "home");
                        }
                        break;
                    case 106440182:
                        if (strOptString.equals("pause")) {
                            final long jMax = Math.max(0L, Math.round(jSONObject.optDouble("position", -1.0d) * 1000.0d));
                            MainActivity.this.withMediaController(new Consumer() {
                                @Override
                                public final void accept(Object obj) {
                                    MainActivity.AuraSoundBridge.lambda$postMessage$1(jSONObject, jMax, (MediaController) obj);
                                }
                            });
                        }
                        break;
                    case 107944209:
                        if (strOptString.equals("queue")) {
                            MainActivity.this.syncQueueIntoPlayer(jSONObject);
                        }
                        break;
                    case 109641799:
                        if (strOptString.equals("speed")) {
                            MainActivity.this.withMediaController(new Consumer() {
                                @Override
                                public final void accept(Object obj) {
                                    ((MediaController) obj).setPlaybackSpeed((float) Math.max(0.1d, jSONObject.optDouble("speed", 1.0d)));
                                }
                            });
                        }
                        break;
                    case 110621003:
                        if (strOptString.equals("track")) {
                            MainActivity.this.loadTrackIntoPlayer(jSONObject);
                        }
                        break;
                    case 637769866:
                        if (strOptString.equals("resetPlayback")) {
                            MainActivity.this.withMediaController(new Consumer() {
                                @Override
                                public final void accept(Object obj) {
                                    AuraSoundBridge.this.lambda$postMessage$2((MediaController) obj);
                                }
                            });
                        }
                        break;
                    case 2072332025:
                        if (strOptString.equals("shuffle")) {
                            MainActivity.this.syncShuffleMode(jSONObject.optBoolean("enabled", false));
                        }
                        break;
                    default:
                        break;
                }
            } catch (Exception unused) {
            }
        }

        static void lambda$postMessage$1(JSONObject jSONObject, long j, MediaController mediaController) {
            mediaController.pause();
            if (jSONObject.has("position")) {
                mediaController.seekTo(j);
            }
        }

        public void lambda$postMessage$2(MediaController mediaController) {
            mediaController.stop();
            mediaController.clearMediaItems();
            mediaController.setRepeatMode(0);
            mediaController.setShuffleModeEnabled(false);
            mediaController.setPlaybackSpeed(1.0f);
            mediaController.setVolume(0.15f);
            MainActivity.this.getSharedPreferences("aurasound_playback", 0).edit().clear().putFloat("volume", 0.15f).apply();
        }

        @JavascriptInterface
        public synchronized String beginImport(String str, String str2, String str3) {
            try {
                return MainActivity.this.beginImport(str, str2);
            } catch (Exception unused) {
                return "";
            }
        }

        @JavascriptInterface
        public synchronized boolean appendImport(String str) {
            try {
                MainActivity.this.appendImport(str);
            } catch (Exception unused) {
                return false;
            }
            return true;
        }

        @JavascriptInterface
        public synchronized boolean finishImport() {
            try {
                MainActivity.this.finishImport();
            } catch (Exception unused) {
                MainActivity.this.cancelImport();
                return false;
            }
            return true;
        }

        @JavascriptInterface
        public synchronized void cancelImport() {
            MainActivity.this.cancelImport();
        }

        @JavascriptInterface
        public synchronized boolean deleteMusicFile(String str) {
            return MainActivity.this.deleteMusicFile(str);
        }

        @JavascriptInterface
        public synchronized void clearMusicFiles() {
            MainActivity.this.clearMusicFiles();
        }

        @JavascriptInterface
        public synchronized long getMusicFileSize(String str) {
            return MainActivity.this.getMusicFileSize(str);
        }

        @JavascriptInterface
        public synchronized String readMusicFileChunk(String str, long j, int i) {
            try {
                return MainActivity.this.readMusicFileChunk(str, j, i);
            } catch (Exception unused) {
                return "";
            }
        }

        public void lambda$exportBackup$6(String str) {
            MainActivity.this.launchBackupExport(str);
        }

        @JavascriptInterface
        public synchronized void exportBackup(final String str) {
            MainActivity.this.runOnUiThread(new Runnable() {
                @Override
                public final void run() {
                    AuraSoundBridge.this.lambda$exportBackup$6(str);
                }
            });
        }

        @JavascriptInterface
        public synchronized void importBackup() {
            final MainActivity mainActivity = MainActivity.this;
            mainActivity.runOnUiThread(new Runnable() {
                @Override
                public final void run() {
                    mainActivity.launchBackupImport();
                }
            });
        }
    }
}
