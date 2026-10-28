import type { TimelineMarker, TimelineMarkersState } from '@videojs/core';
import { definePlayerFeature } from '@videojs/core/dom';
import { createSelector } from '@videojs/store';
import { listen } from '@videojs/utils/dom';

import type { DismissReason, NavigationRestriction, PlacementKind, PlacementState } from './enums';
import type { PlacementLayout } from './placement';
import type { AdSession } from './session';

/**
 * The ad state a UI component renders from. Flat and `ad`-qualified, following the store's naming: a nested object
 * would take a new reference on every clock tick during a break and re-render every component that reads any ad field.
 * Analytics data stays on the session, not here.
 *
 * @experimental
 */
export interface AdsState {
  /** Whether the playhead is inside an interstitial. */
  adBreakActive: boolean;
  /** `ad` or `content`, or `null` outside a break. */
  adBreakKind: 'ad' | 'content' | null;
  /** Seconds left in the current break, or `null`. */
  adBreakRemaining: number | null;
  /** 1-based slot position in the break, or `null`. */
  adSlotIndex: number | null;
  /** Number of slots in the break, or `null`. */
  adSlotCount: number | null;
  /** Seconds left in the current slot, or `null`. */
  adSlotRemaining: number | null;
  adSlotTitle: string | null;
  adSkippable: boolean;
  adSkipLabelId: string | null;
  /** Seconds until the skip control may show, or `null` when it is already available or never will be. */
  adSkipAvailableIn: number | null;
  adClickThrough: string | null;
  /** Whether primary content is paused for an inserted or replaced break. */
  adContentPaused: boolean;
  adRestrictions: ReadonlyArray<NavigationRestriction>;
  /** A shallow projection of the active placements; read creative and interactivity from the session by id. */
  adPlacements: ReadonlyArray<{
    id: string;
    kind: PlacementKind;
    state: PlacementState;
    layout: PlacementLayout;
    remaining: number | null;
  }>;

  /** Skip the current slot. No-op when it is not skippable. */
  skipAd(): void;
  /** Report a click-through on the current slot. */
  clickAd(): void;
  /** Dismiss an active placement. */
  dismissAdPlacement(id: string, reason?: DismissReason): void;
}

/** The session events that can change {@link AdsState} or the markers. */
const ADS_EVENTS = [
  'scheduleupdated',
  'interstitialstart',
  'interstitialend',
  'interstitialresolved',
  'slotstart',
  'slotend',
  'slotskipstatechange',
  'contentpause',
  'contentresume',
  'placementscheduled',
  'placementactivating',
  'placementactive',
  'placementdeactivating',
  'placementdismissed',
  'timeupdate',
] as const;

type AdsSourceState = AdsState & TimelineMarkersState;

type AdPlacementProjection = AdsState['adPlacements'][number];

function adsOf(media: unknown): AdSession | null {
  const ads = (media as { ads?: unknown } | null | undefined)?.ads;

  return ads && typeof ads === 'object' && 'schedule' in ads ? (ads as AdSession) : null;
}

function markersEqual(a: readonly TimelineMarker[], b: readonly TimelineMarker[]): boolean {
  return (
    a.length === b.length &&
    a.every((marker, index) => {
      const other = b[index]!;

      return (
        marker.id === other.id &&
        marker.time === other.time &&
        marker.duration === other.duration &&
        marker.played === other.played &&
        marker.style === other.style
      );
    })
  );
}

function placementsEqual(a: readonly AdPlacementProjection[], b: readonly AdPlacementProjection[]): boolean {
  return (
    a.length === b.length &&
    a.every((placement, index) => {
      const other = b[index]!;

      return (
        placement.id === other.id &&
        placement.state === other.state &&
        placement.remaining === other.remaining &&
        placement.layout === other.layout
      );
    })
  );
}

const INITIAL: Omit<AdsSourceState, 'skipAd' | 'clickAd' | 'dismissAdPlacement'> = {
  adBreakActive: false,
  adBreakKind: null,
  adBreakRemaining: null,
  adSlotIndex: null,
  adSlotCount: null,
  adSlotRemaining: null,
  adSlotTitle: null,
  adSkippable: false,
  adSkipLabelId: null,
  adSkipAvailableIn: null,
  adClickThrough: null,
  adContentPaused: false,
  adRestrictions: [],
  adPlacements: [],
  timelineMarkers: [],
};

/**
 * Projects the ad session into the flat player store. A field belongs here only if a component renders from it; beacon
 * and analytics data stay on the session. Compose it alongside `timeFeature`, which skins read for the countdown and
 * marker positions.
 *
 * @experimental
 */
export const adsFeature = definePlayerFeature({
  name: 'ads',
  state: ({ target }): AdsSourceState => {
    const session = () => adsOf(target().media);

    return {
      ...INITIAL,
      skipAd: () => session()?.schedule.currentSlot?.skip(),
      clickAd: () => session()?.schedule.currentSlot?.click(),
      dismissAdPlacement: (id: string, reason?: DismissReason) => session()?.placements.getById(id)?.dismiss(reason),
    };
  },

  attach({ target, signal, set, get }) {
    const session = adsOf(target.media);
    if (!session) return;

    const sync = () => {
      const current = session.schedule.current;
      const slot = session.schedule.currentSlot;
      const control = slot?.skipControl ?? null;
      const skipAvailableIn =
        control && slot && !slot.skippable ? Math.max(0, control.offset - slot.currentTime) : null;

      const markers: TimelineMarker[] = session.schedule.items
        .filter((item) => item.kind === 'ad' && item.startTime !== null)
        .map((item) => {
          const time = session.time.contentTimeForStreamTime(item.startTime!);
          // Width is the break's footprint in content time: zero for a stitched break on VOD (content time collapses
          // it, so it draws as a point) and the real span on live, where ad regions occupy the DVR bar.
          const contentWidth =
            item.timelineOccupancy === 'point' || item.endTime === null
              ? null
              : session.time.contentTimeForStreamTime(item.endTime) - time;

          return {
            id: item.id,
            time,
            duration: contentWidth,
            kind: 'ad' as const,
            label: null,
            played: item.played,
            style: item.timelineStyle,
          };
        });

      const placements: AdPlacementProjection[] = session.placements.active.map((placement) => ({
        id: placement.id,
        kind: placement.kind,
        state: placement.state,
        layout: placement.layout,
        remaining: placement.endTime !== null ? Math.max(0, placement.endTime - placement.currentTime) : null,
      }));

      // Reuse the previous array when its contents are unchanged, so a bare clock tick does not re-render marker and
      // placement consumers through the store's shallow equality.
      const previous = get() as AdsSourceState;

      set({
        adBreakActive: current !== null,
        adBreakKind: current?.kind ?? null,
        adBreakRemaining: current?.remainingTime ?? null,
        adSlotIndex: slot ? slot.index + 1 : null,
        adSlotCount: current ? current.slots.length : null,
        adSlotRemaining: slot?.remainingTime ?? null,
        adSlotTitle: slot?.title ?? null,
        adSkippable: slot?.skippable ?? false,
        adSkipLabelId: control?.labelId ?? null,
        adSkipAvailableIn: skipAvailableIn,
        adClickThrough: slot?.clickThrough ?? null,
        adContentPaused: current !== null && current.insertion !== 'stitched',
        adRestrictions: current ? [...current.restrictions] : INITIAL.adRestrictions,
        adPlacements: placementsEqual(previous.adPlacements, placements) ? previous.adPlacements : placements,
        timelineMarkers: markersEqual(previous.timelineMarkers, markers) ? previous.timelineMarkers : markers,
      });
    };

    sync();

    const off = ADS_EVENTS.map((type) => listen(session as unknown as EventTarget, type, sync, { signal }));

    signal.addEventListener('abort', () => off.forEach((remove) => remove()), { once: true });
  },
});

/** Select the ad state (break and slot progress, skip availability, placements, and the timeline markers). */
export const selectAds = createSelector(adsFeature);
