import type { MediaOverride, PlayerExtension, PlayerTarget } from '@videojs/core/dom';
import { getMediaElement } from '@videojs/media/dom';

import type { AdAdapter } from './adapter';
import type { BeaconSender } from './beacons';
import { type AdSession, createAdSession } from './session';
import { SvtaAdapter } from './svta/adapter';

/** @experimental */
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
 *
 * `buffered` is left in stream time; during a stitched break the buffer bar can read slightly ahead of the content
 * clock, which does not affect seeking or the fill.
 *
 * @experimental
 */
export class AdsExtension implements PlayerExtension, AdsExtensionProps {
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
  #element: HTMLMediaElement | null = null;

  /** The live ad session, or `null` before the player attaches media. Analytics subscribes to this. */
  get session(): AdSession | null {
    return this.#session;
  }

  /** The content-time clock, the session, and the seek enforcement the store reads through the media facade. */
  get mediaOverride(): MediaOverride | null {
    const session = this.#session;
    const element = this.#element;
    if (!session || !element) return null;

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
    } as MediaOverride;
  }

  attach(target: PlayerTarget): void {
    const element = getMediaElement(target.media);
    if (!element) return;

    this.#element = element;
    this.#session = createAdSession({
      primaryElement: element,
      beacons: this.beacons ?? undefined,
      enforceRestrictions: this.enforceRestrictions,
      timeline: this.timeline,
    });

    const adapters = this.adapters.length > 0 ? this.adapters : [new SvtaAdapter()];

    for (const adapter of adapters) this.#session.attachAdapter(adapter);
  }

  detach(): void {
    this.#session?.destroy();
    this.#session = null;
    this.#element = null;
  }

  destroy(): void {
    this.detach();
  }
}
