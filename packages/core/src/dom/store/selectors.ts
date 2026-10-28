import { createSelector } from '@videojs/store';

import type { TimelineMarkersState } from '../../core/ui/time-slider/markers/core';
import { definePlayerFeature } from '../feature';
import { audioTrackFeature } from './features/audio-track';
import { bufferFeature } from './features/buffer';
import { controlsFeature } from './features/controls';
import { errorFeature } from './features/error';
import { fullscreenFeature } from './features/fullscreen';
import { liveFeature } from './features/live';
import { metadataFeature } from './features/metadata';
import { pipFeature } from './features/pip';
import { playbackFeature } from './features/playback';
import { playbackRateFeature } from './features/playback-rate';
import { qualityFeature } from './features/quality';
import { remotePlaybackFeature } from './features/remote-playback';
import { sourceFeature } from './features/source';
import { streamTypeFeature } from './features/stream-type';
import { textTrackFeature } from './features/text-track';
import { timeFeature } from './features/time';
import { volumeFeature } from './features/volume';

/** Select the audio track state (audioTrackList, selectAudioTrack). */
export const selectAudioTrack = createSelector(audioTrackFeature);
/** Select the buffer state (buffered, seekable). */
export const selectBuffer = createSelector(bufferFeature);
/** Select the controls state (controlsVisible, userActive, toggleControls, requestControlsLock). */
export const selectControls = createSelector(controlsFeature);
/** Select the error state (error, dismissError). */
export const selectError = createSelector(errorFeature);
/** Select the fullscreen state (isFullscreen, fullscreenAvailability, requestFullscreen, exitFullscreen). */
export const selectFullscreen = createSelector(fullscreenFeature);
/** Select the live state (`liveEdgeStart`, `targetLiveWindow`). */
export const selectLive = createSelector(liveFeature);
/** Select resolved content metadata (title, poster). */
export const selectMetadata = createSelector(metadataFeature);
/**
 * Select the PiP state (isPictureInPicture, pictureInPictureAvailability, requestPictureInPicture,
 * exitPictureInPicture).
 */
export const selectPiP = createSelector(pipFeature);
/** Select the playback state (paused, ended, play, pause). */
export const selectPlayback = createSelector(playbackFeature);
/** Select the playback rate state (playbackRate, playbackRates, setPlaybackRate). */
export const selectPlaybackRate = createSelector(playbackRateFeature);
/** Select the quality state (videoRenditionList, activeVideoRendition, selectVideoRendition). */
export const selectQuality = createSelector(qualityFeature);
/** Select the remote playback state (remotePlaybackState, remotePlaybackAvailability, promptRemotePlayback). */
export const selectRemotePlayback = createSelector(remotePlaybackFeature);
/** Select the source state (currentSrc, canPlay). */
export const selectSource = createSelector(sourceFeature);
/** Select the stream type state (`streamType`: `'on-demand' | 'live' | 'unknown'`). */
export const selectStreamType = createSelector(streamTypeFeature);
/**
 * Select the text track state (textTrackList, subtitlesShowing, toggleSubtitles, selectSubtitlesTrack, chaptersCues,
 * thumbnailsTrack).
 */
export const selectTextTrack = createSelector(textTrackFeature);
/** Select the time state (currentTime, duration, seek). */
export const selectTime = createSelector(timeFeature);
/** Select the volume state (volume, muted, setVolume, setMuted). */
export const selectVolume = createSelector(volumeFeature);

/**
 * The generic timeline-markers surface. A player gets the `timelineMarkers` key from whichever feature contributes it
 * (the ads feature today); this empty-default slice anchors {@link selectTimelineMarkers} so the selector is typed and
 * reads the key wherever it comes from. It is not part of any preset, so it never collides with a contributing
 * feature.
 */
const timelineMarkersAnchor = definePlayerFeature({
  name: 'timelineMarkers',
  state: (): TimelineMarkersState => ({ timelineMarkers: [] }),
});

/**
 * Select the generic timeline markers any feature may contribute (ad breaks today). The result is `undefined` when no
 * feature contributes markers, so a slider's markers part reads it with a fallback and renders nothing.
 *
 * @internal
 */
export const selectTimelineMarkers = createSelector(timelineMarkersAnchor);
