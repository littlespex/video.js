/**
 * How an interstitial's media reaches the viewer. Everything that differs between SSAI, CSAI and SGAI follows from this
 * one field: whether content pause and resume events fire, whether a second player is needed, and how stream time maps
 * to content time.
 *
 * - `stitched`: the media is already in the primary stream (SSAI). The region marks where it is.
 * - `inserted`: primary pauses at `startTime`, separate media plays, primary resumes at `startTime + resumeOffset`.
 * - `replaced`: separate media plays in place of the primary span `[startTime, startTime + resumeOffset)`.
 *
 * @internal
 */
export type InsertionMode = 'stitched' | 'inserted' | 'replaced';

/**
 * Where an interstitial sits relative to primary content. Play-once semantics are a separate boolean, `playOnce`,
 * because they combine with any position.
 *
 * @internal
 */
export type CuePosition = 'pre' | 'mid' | 'post';

/**
 * UI hint for a progress bar: draw a marker at `startTime` (`point`) or a span of `duration` (`range`).
 *
 * @internal
 */
export type TimelineOccupancy = 'point' | 'range';

/**
 * UI hint for a progress bar: visually distinct from content (`highlight`) or drawn the same as content (`primary`).
 *
 * @internal
 */
export type TimelineStyle = 'highlight' | 'primary';

/**
 * Whether an interstitial's slot data is known. Independent of playback state, because resolution is often deferred
 * until the region is about to start.
 *
 * - `empty` and `error`: for `inserted` and `replaced` the player skips the region; for `stitched` it plays with no slot
 *   metadata.
 *
 * @internal
 */
export type ResolutionState = 'unresolved' | 'resolving' | 'resolved' | 'empty' | 'error';

/**
 * Playback state of an interstitial. There are no transitional states: a region is active from the moment the clock
 * enters it, whether or not its slots are resolved.
 *
 * @internal
 */
export type InterstitialState = 'scheduled' | 'active' | 'completed' | 'skipped' | 'error';

/** @internal */
export type SlotState = 'pending' | 'active' | 'completed' | 'skipped' | 'error';

/**
 * - `skip`: the viewer may not end the interstitial early (HLS `X-RESTRICT=SKIP`).
 * - `jump`: the viewer may not seek from before `startTime` to after it without the interstitial playing first (HLS
 *   `X-RESTRICT=JUMP`).
 * - `rate`: playback rate must be 1.0 for the interstitial to advance.
 *
 * @internal
 */
export type NavigationRestriction = 'skip' | 'jump' | 'rate';

/**
 * The SVTA2053 `EventType` enumeration. `progress` requires an `offset`; `firstQuartile`, `midpoint` and
 * `thirdQuartile` are accepted for VAST compatibility and treated as `progress` at 25, 50 and 75 percent of the slot
 * duration when no offset is given.
 *
 * @internal
 */
export type TrackingEventType =
  | 'clickTracking'
  | 'complete'
  | 'error'
  | 'firstQuartile'
  | 'impression'
  | 'loaded'
  | 'midpoint'
  | 'mute'
  | 'pause'
  | 'playerCollapse'
  | 'playerExpand'
  | 'podEnd'
  | 'podStart'
  | 'progress'
  | 'resume'
  | 'skip'
  | 'start'
  | 'thirdQuartile'
  | 'unmute';

/**
 * The IAB CTV non-linear formats plus VAST companions.
 *
 * @internal
 */
export type PlacementKind = 'pause' | 'screensaver' | 'menu' | 'overlay' | 'squeezeback' | 'inScene' | 'companion';

/**
 * Who drives a placement's lifecycle: the session's clock (`timeline`) or the adapter (every other trigger).
 *
 * @internal
 */
export type PlacementTrigger = 'timeline' | 'userAction' | 'deviceState' | 'programmatic' | 'composited';

/**
 * The transitional states survive here because squeezeback resizing and overlay fades are real intervals UI code needs
 * to know about.
 *
 * @internal
 */
export type PlacementState = 'scheduled' | 'activating' | 'active' | 'deactivating' | 'completed' | 'error';

/** @internal */
export type DismissReason =
  | 'completed'
  | 'viewerDismissed'
  | 'contentResumed'
  | 'navigatedAway'
  | 'deviceTimeout'
  | 'appExited'
  | 'skipped'
  | 'replaced';

/** @internal */
export type AudioPolicy = 'required' | 'optional' | 'none';

/**
 * Why an interstitial left the `active` state.
 *
 * @internal
 */
export type InterstitialEndReason = 'completed' | 'skipped' | 'seeked' | 'playoutLimit' | 'error';

/**
 * Why a slot left the `active` state.
 *
 * @internal
 */
export type SlotEndReason = 'completed' | 'skipped' | 'seeked' | 'error';
