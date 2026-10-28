import type { MediaOverride, PlayerTarget } from '@videojs/core/dom';
import { getMediaElement } from '@videojs/media/dom';

import type { AdAdapter } from './adapter';
import type { BeaconSender } from './beacons';
import { type AdSession, createAdSession } from './session';
import { SvtaAdapter } from './svta/adapter';

/** @internal */
export interface AdsExtensionProps {
  /** Adapters attached to each session. Defaults to a single {@link SvtaAdapter}. */
  adapters: AdAdapter[];
  /** Beacon sender for `tracking` events. `null` leaves beacon transport to a `tracking` listener. */
  beacons: BeaconSender | null;
  /** Whether the session blocks restricted seeks. Defaults to `true`. */
  enforceRestrictions: boolean;
  /** Forces the time mapping. Defaults to detection from the primary element. */
  timeline: 'vod' | 'live' | undefined;
}

/**
 * The ad-aware player extension. It creates an {@link AdSession} on the native element behind whatever media the player
 * attaches, runs the ad adapters, and presents content time on `currentTime`, `duration` and `seekable` so the stock
 * time slider and time display hide stitched ad time. This is the v10 realization of the RFC's ad-aware media delegate,
 * built on the same media-override facade the player already uses for Google Cast.
 *
 * Its `currentTime` setter routes seeks through the session, so the navigation restrictions are enforced in one place.
 * `buffered` is mapped the same way, so the buffer bar lines up with the content clock after a stitched break.
 *
 * @internal
 */
export class AdsExtension implements AdsExtensionProps {
  static readonly defaultProps: AdsExtensionProps = {
    adapters: [],
    beacons: null,
    enforceRestrictions: true,
    timeline: undefined,
  };

  adapters: AdAdapter[] = [];
  beacons: BeaconSender | null = AdsExtension.defaultProps.beacons;
  enforceRestrictions = AdsExtension.defaultProps.enforceRestrictions;
  timeline: 'vod' | 'live' | undefined = AdsExtension.defaultProps.timeline;

  #session: AdSession | null = null;
  #override: MediaOverride | null = null;

  /** The live ad session, or `null` before the player attaches media. Analytics subscribes to this. */
  get session(): AdSession | null {
    return this.#session;
  }

  /**
   * The content-time clock, the session, and the seek enforcement the store reads through the media facade.
   *
   * @internal Player lifecycle; the player reads it.
   */
  get mediaOverride(): MediaOverride | null {
    return this.#override;
  }

  /** @internal Player lifecycle; the player calls it. */
  attach(target: PlayerTarget): void {
    const element = getMediaElement(target.media);
    if (!element) return;

    const session = createAdSession({
      primaryElement: element,
      beacons: this.beacons ?? undefined,
      enforceRestrictions: this.enforceRestrictions,
      timeline: this.timeline,
    });

    this.#session = session;
    this.#override = createOverride(session, element);

    const adapters = this.adapters.length > 0 ? this.adapters : [new SvtaAdapter()];

    for (const adapter of adapters) session.attachAdapter(adapter);
  }

  /** @internal Player lifecycle; the player calls it. */
  detach(): void {
    this.#session?.destroy();
    this.#session = null;
    this.#override = null;
  }

  destroy(): void {
    this.detach();
  }
}

/** One override per session: the facade reads it on every property access, so it is built once. */
function createOverride(session: AdSession, element: HTMLMediaElement): MediaOverride {
  return {
    get ads() {
      return session;
    },
    get currentTime() {
      return session.time.contentTime;
    },
    set currentTime(contentTime: number) {
      session.requestSeek(session.time.streamTimeForContentTime(contentTime));
    },
    get duration() {
      return session.time.contentDuration ?? element.duration;
    },
    get seekable() {
      return session.time.contentSeekable as unknown as TimeRanges;
    },
    get buffered() {
      return session.time.contentBuffered as unknown as TimeRanges;
    },
  } as MediaOverride;
}
