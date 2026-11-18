package com.aurasound.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.CommandButton;
import androidx.media3.session.DefaultMediaNotificationProvider;
import androidx.media3.session.MediaNotification;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import com.google.common.collect.ImmutableList;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

public final class AuraSoundPlaybackService extends MediaSessionService {
    private static final String ACTION_NOTIFICATION_DISMISSED = "com.aurasound.app.ACTION_MEDIA_NOTIFICATION_DISMISSED";
    private static final int MEDIA_NOTIFICATION_ID = 3006;
    private static volatile AuraSoundPlaybackService activeInstance;
    private MediaSession mediaSession;
    private final Handler persistenceHandler = new Handler(Looper.getMainLooper());
    private final Runnable persistenceTask = new Runnable() {
        @Override
        public void run() {
            AuraSoundPlaybackService.this.persistPlaybackState();
            if (AuraSoundPlaybackService.this.player != null && AuraSoundPlaybackService.this.player.isPlaying()) {
                AuraSoundPlaybackService.this.persistenceHandler.postDelayed(this, 750L);
            }
        }
    };
    private ExoPlayer player;
    private Player.Listener playerListener;

    @Override
    public void onCreate() {
        super.onCreate();
        activeInstance = this;
        setMediaNotificationProvider(new AuraSoundMediaNotificationProvider(this));
        setShowNotificationForIdlePlayer(1);
        this.player = new ExoPlayer.Builder(this).setAudioAttributes(new AudioAttributes.Builder().setUsage(1).setContentType(2).build(), true).setHandleAudioBecomingNoisy(true).setMaxSeekToPreviousPositionMs(0L).build();
        this.player.setVolume(Math.max(0.0f, Math.min(1.0f, getSharedPreferences("aurasound_playback", 0).getFloat("volume", 0.15f))));
        Player.Listener listener = new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean z) {
                AuraSoundPlaybackService.this.persistPlaybackState();
                AuraSoundPlaybackService.this.sendPlaybackState();
                AuraSoundPlaybackService.this.persistenceHandler.removeCallbacks(AuraSoundPlaybackService.this.persistenceTask);
                if (z) {
                    AuraSoundPlaybackService.this.persistenceHandler.postDelayed(AuraSoundPlaybackService.this.persistenceTask, 750L);
                }
            }

            @Override
            public void onPlaybackStateChanged(int i) {
                AuraSoundPlaybackService.this.persistPlaybackState();
                AuraSoundPlaybackService.this.sendPlaybackState();
                if (i != 4 || AuraSoundPlaybackService.this.player.hasNextMediaItem()) {
                    return;
                }
                MainActivity.sendMediaAction("ended", AuraSoundPlaybackService.this.player.getCurrentMediaItem() == null ? null : AuraSoundPlaybackService.this.player.getCurrentMediaItem().mediaId);
            }

            @Override
            public void onMediaItemTransition(MediaItem mediaItem, int i) {
                AuraSoundPlaybackService.this.persistPlaybackState();
                AuraSoundPlaybackService.this.sendPlaybackState();
                if (mediaItem != null) {
                    if (i == 1 || i == 2) {
                        MainActivity.sendMediaAction("nativeTransition", mediaItem.mediaId);
                    }
                }
            }

            @Override
            public void onPlaybackParametersChanged(PlaybackParameters playbackParameters) {
                AuraSoundPlaybackService.this.sendPlaybackState();
            }

            @Override
            public void onPositionDiscontinuity(Player.PositionInfo positionInfo, Player.PositionInfo positionInfo2, int i) {
                AuraSoundPlaybackService.this.persistPlaybackState();
                AuraSoundPlaybackService.this.sendPlaybackState();
            }

            @Override
            public void onPlayerError(PlaybackException playbackException) {
                MainActivity.sendMediaAction("error", AuraSoundPlaybackService.this.player.getCurrentMediaItem() == null ? null : AuraSoundPlaybackService.this.player.getCurrentMediaItem().mediaId);
                AuraSoundPlaybackService.this.sendPlaybackState();
            }
        };
        this.playerListener = listener;
        this.player.addListener(listener);
        this.mediaSession = new MediaSession.Builder(this, this.player).setSessionActivity(PendingIntent.getActivity(this, MEDIA_NOTIFICATION_ID, new Intent(this, (Class<?>) MainActivity.class).setFlags(603979776), 201326592)).setCallback((MediaSession.Callback) new AuraSoundMediaSessionCallback()).build();
    }

    public void persistPlaybackState() {
        MediaItem currentMediaItem;
        ExoPlayer exoPlayer = this.player;
        if (exoPlayer == null || (currentMediaItem = exoPlayer.getCurrentMediaItem()) == null || currentMediaItem.mediaId == null || currentMediaItem.mediaId.isEmpty()) {
            return;
        }
        long positionMs = Math.max(0L, exoPlayer.getCurrentPosition());
        SharedPreferences preferences = getSharedPreferences("aurasound_playback", 0);
        if (currentMediaItem.mediaId.equals(preferences.getString("trackId", ""))
                && positionMs == preferences.getLong("positionMs", -1L)) {
            return;
        }
        preferences.edit().putString("trackId", currentMediaItem.mediaId).putLong("positionMs", positionMs).apply();
    }

    public void sendPlaybackState() {
        ExoPlayer exoPlayer = this.player;
        if (exoPlayer == null) {
            return;
        }
        long duration = exoPlayer.getDuration();
        long j = (duration == C.TIME_UNSET || duration < 0) ? 0L : duration;
        MediaItem currentMediaItem = this.player.getCurrentMediaItem();
        MainActivity.sendPlaybackState(this.player.isPlaying(), Math.max(0L, this.player.getCurrentPosition()), j, this.player.getPlaybackParameters().speed, currentMediaItem == null ? "" : currentMediaItem.mediaId);
    }

    private final class AuraSoundMediaNotificationProvider implements MediaNotification.Provider {
        private final DefaultMediaNotificationProvider delegate;

        AuraSoundMediaNotificationProvider(Context context) {
            DefaultMediaNotificationProvider defaultMediaNotificationProvider = new DefaultMediaNotificationProvider(context);
            this.delegate = defaultMediaNotificationProvider;
            defaultMediaNotificationProvider.setSmallIcon(R.drawable.ic_stat_aurasound);
        }

        @Override
        public MediaNotification createNotification(MediaSession mediaSession, ImmutableList<CommandButton> immutableList, MediaNotification.ActionFactory actionFactory, MediaNotification.Provider.Callback callback) {
            MediaNotification mediaNotificationCreateNotification = this.delegate.createNotification(mediaSession, immutableList, actionFactory, callback);
            mediaNotificationCreateNotification.notification.deleteIntent = PendingIntent.getBroadcast(AuraSoundPlaybackService.this, AuraSoundPlaybackService.MEDIA_NOTIFICATION_ID, new Intent(AuraSoundPlaybackService.this, (Class<?>) NotificationDismissReceiver.class).setAction(AuraSoundPlaybackService.ACTION_NOTIFICATION_DISMISSED), 201326592);
            return mediaNotificationCreateNotification;
        }

        @Override
        public MediaNotification.Provider.NotificationChannelInfo getNotificationChannelInfo() {
            return this.delegate.getNotificationChannelInfo();
        }

        @Override
        public boolean handleCustomCommand(MediaSession mediaSession, String str, Bundle bundle) {
            return this.delegate.handleCustomCommand(mediaSession, str, bundle);
        }
    }

    public void dismissNotificationAndStop() {
        ExoPlayer exoPlayer = this.player;
        if (exoPlayer != null) {
            exoPlayer.pause();
            persistPlaybackState();
        }
        this.persistenceHandler.removeCallbacks(this.persistenceTask);
        stopSelf();
    }

    public static final class NotificationDismissReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (AuraSoundPlaybackService.ACTION_NOTIFICATION_DISMISSED.equals(intent.getAction())) {
                AuraSoundPlaybackService auraSoundPlaybackService = AuraSoundPlaybackService.activeInstance;
                if (auraSoundPlaybackService != null) {
                    auraSoundPlaybackService.dismissNotificationAndStop();
                } else {
                    context.stopService(new Intent(context, (Class<?>) AuraSoundPlaybackService.class));
                }
            }
        }
    }

    private static final class AuraSoundMediaSessionCallback implements MediaSession.Callback {
        private AuraSoundMediaSessionCallback() {
        }

        @Override
        public ListenableFuture<MediaSession.ConnectionResult> onConnectAsync(MediaSession mediaSession, MediaSession.ControllerInfo controllerInfo) {
            if (mediaSession.isMediaNotificationController(controllerInfo)) {
                return Futures.immediateFuture(new MediaSession.ConnectionResult.AcceptedResultBuilder(mediaSession, controllerInfo).setAvailablePlayerCommands(MediaSession.ConnectionResult.DEFAULT_PLAYER_COMMANDS.buildUpon().remove(7).remove(9).build()).setMediaButtonPreferences(ImmutableList.of(new CommandButton.Builder(CommandButton.ICON_PREVIOUS).setPlayerCommand(6).setDisplayName("Previous").build(), new CommandButton.Builder(CommandButton.ICON_NEXT).setPlayerCommand(8).setDisplayName("Next").build())).build());
            }
            return Futures.immediateFuture(new MediaSession.ConnectionResult.AcceptedResultBuilder(mediaSession, controllerInfo).build());
        }
    }

    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return this.mediaSession;
    }

    @Override
    public void onTaskRemoved(Intent intent) {
        persistPlaybackState();
        ExoPlayer exoPlayer = this.player;
        if (exoPlayer != null) {
            exoPlayer.pause();
        }
        stopSelf();
    }

    @Override
    public void onDestroy() {
        this.persistenceHandler.removeCallbacks(this.persistenceTask);
        if (activeInstance == this) {
            activeInstance = null;
        }
        persistPlaybackState();
        ExoPlayer exoPlayer = this.player;
        if (exoPlayer != null) {
            exoPlayer.removeListener(this.playerListener);
        }
        MediaSession mediaSession = this.mediaSession;
        if (mediaSession != null) {
            mediaSession.release();
            this.mediaSession = null;
        }
        ExoPlayer exoPlayer2 = this.player;
        if (exoPlayer2 != null) {
            exoPlayer2.release();
            this.player = null;
        }
        this.playerListener = null;
        super.onDestroy();
    }
}
