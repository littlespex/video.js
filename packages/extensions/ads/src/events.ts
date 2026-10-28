import type { TrackingContext } from './beacons';
import type { DismissReason, InterstitialEndReason, SlotEndReason } from './enums';
import type { Interstitial, Slot } from './interstitial';
import type { AdPlacement } from './placement';
import type { TrackingEvent } from './records';

/**
 * Every event an `AdSession` dispatches, as `CustomEvent`s whose `detail` carries the target object and context. There
 * is no bubbling hierarchy: a listener that wants one region's events filters on `detail.interstitial.id`.
 *
 * `interstitialstart`, `interstitialend`, `slotstart` and `slotend` carry `firstPlay`, which is `false` when the region
 * had `played === true` at the moment it started. UI treats both the same; analytics typically suppresses beacons on
 * replay.
 *
 * `tracking` is cancelable: `preventDefault()` in a listener stops the session's beacon sender from issuing the
 * request.
 *
 * @experimental
 */
export interface AdSessionEventMap {
  // Schedule
  scheduleupdated: { added: Interstitial[]; removed: Interstitial[]; changed: Interstitial[] };

  // Interstitials
  interstitialresolved: { interstitial: Interstitial };
  interstitialstart: { interstitial: Interstitial; firstPlay: boolean };
  interstitialend: { interstitial: Interstitial; reason: InterstitialEndReason; firstPlay: boolean };
  interstitialerror: { interstitial: Interstitial; error: Error };

  // Slots
  slotstart: { slot: Slot; firstPlay: boolean };
  slotprogress: { slot: Slot; offset: number; fraction: number };
  slotskipstatechange: { slot: Slot; skippable: boolean };
  slotskip: { slot: Slot };
  slotclick: { slot: Slot };
  slotend: { slot: Slot; reason: SlotEndReason; firstPlay: boolean };
  sloterror: { slot: Slot; error: Error };

  // Tracking (both layers)
  tracking: { event: TrackingEvent; context: TrackingContext };

  // Navigation
  seekblocked: { interstitial: Interstitial; from: number; to: number };
  snapback: { interstitial: Interstitial; from: number; to: number };
  contentpause: { interstitial: Interstitial };
  contentresume: { interstitial: Interstitial; resumeAt: number };

  // Placements
  placementscheduled: { placement: AdPlacement };
  placementactivating: { placement: AdPlacement };
  placementactive: { placement: AdPlacement };
  placementimpression: { placement: AdPlacement };
  placementdeactivating: { placement: AdPlacement };
  placementdismissed: { placement: AdPlacement; reason: DismissReason };
  placementclick: { placement: AdPlacement };
  placementrefresh: { placement: AdPlacement };
  placementerror: { placement: AdPlacement; error: Error };

  // Clock
  timeupdate: { streamTime: number; contentTime: number; interstitial: Interstitial | null; slot: Slot | null };
}

/** @experimental */
export type AdSessionEventType = keyof AdSessionEventMap;

/** @experimental */
export type AdSessionEvent<K extends AdSessionEventType = AdSessionEventType> = CustomEvent<AdSessionEventMap[K]>;
