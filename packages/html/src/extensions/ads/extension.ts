import { AdsExtension, type AdsExtensionProps, type AdAdapter, type BeaconSender } from '@videojs/ads';
import { isString } from '@videojs/utils/predicate';

import { PlayerExtensionElement } from '../player-extension-element';

/**
 * Adds the ad session to the surrounding player as `<media-ads>`.
 *
 * Renders nothing — place it inside the player and it creates an `AdSession` on whatever media the player attaches,
 * runs the ad adapters (the SVTA2053 metadata-track adapter by default), and presents content time on the player clock
 * so the stock time slider and time display hide stitched ad time.
 *
 * Adapters and the beacon sender are object-valued, so set them as properties rather than attributes. Enforcement is on
 * by default, so the attribute is enumerated rather than boolean: `enforce-restrictions="false"` turns it off.
 *
 * @example
 *   ```html
 *   <video-player>
 *   <hlsjs-video src="https://example.com/stitched.m3u8"></hlsjs-video>
 *   <media-ads></media-ads>
 *   </video-player>
 *   ```;
 *
 * @internal
 */
export class MediaAdsExtension extends PlayerExtensionElement<AdsExtension> {
  static readonly tagName = 'media-ads';

  static override properties = {
    enforceRestrictions: { type: String, attribute: 'enforce-restrictions' },
    timeline: { type: String },
  };

  protected createExtension(): AdsExtension {
    return new AdsExtension();
  }

  /** The live ad session, or `null` before media attaches. Subscribe to it for analytics. */
  get session() {
    return this.extension.session;
  }

  /** Adapters attached to each session. Defaults to a single SVTA2053 adapter. */
  get adapters(): AdAdapter[] {
    return this.extension.adapters;
  }

  set adapters(value: AdAdapter[]) {
    this.extension.adapters = value;
  }

  /** Beacon sender for `tracking` events. `null` leaves beacon transport to a `tracking` listener. */
  get beacons(): BeaconSender | null {
    return this.extension.beacons;
  }

  set beacons(value: BeaconSender | null) {
    this.extension.beacons = value;
  }

  /**
   * Whether the session blocks restricted seeks. Defaults to `true`. The attribute form accepts `"false"` to turn
   * enforcement off; any other value, including an empty one, keeps it on.
   */
  get enforceRestrictions(): boolean {
    return this.extension.enforceRestrictions;
  }

  set enforceRestrictions(value: boolean | string | null) {
    this.extension.enforceRestrictions = isString(value) ? value.trim().toLowerCase() !== 'false' : value !== false;
  }

  /** Forces the time mapping (`vod` or `live`). Defaults to detection from the primary element. */
  get timeline(): AdsExtensionProps['timeline'] {
    return this.extension.timeline;
  }

  set timeline(value: AdsExtensionProps['timeline'] | null) {
    this.extension.timeline = value ?? undefined;
  }
}
