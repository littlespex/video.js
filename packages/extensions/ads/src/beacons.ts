import { noop } from '@videojs/utils/function';
import { isFunction } from '@videojs/utils/predicate';

import type { Interstitial, Slot } from './interstitial';
import type { AdPlacement } from './placement';
import type { TrackingEvent } from './records';
import type { AdSession } from './session';

/**
 * Performs the HTTP side of a due {@link TrackingEvent}. Set one on the session, or leave `session.beacons` null and
 * handle `tracking` events yourself.
 *
 * @experimental
 */
export interface BeaconSender {
  /** Called once per due record. Implementations perform VAST macro replacement and issue the requests. */
  send(event: TrackingEvent, context: TrackingContext): void;
}

/**
 * Where a tracking record fell due.
 *
 * @experimental
 */
export interface TrackingContext {
  readonly session: AdSession;
  readonly interstitial: Interstitial | null;
  readonly slot: Slot | null;
  readonly placement: AdPlacement | null;
  readonly streamTime: number;
  readonly contentTime: number;
  readonly firstPlay: boolean;
}

/** @experimental */
export interface DefaultBeaconSenderOptions {
  /** Issues one request. Defaults to a `no-cors`, `keepalive` `fetch`, falling back to an image request. */
  request?: ((url: string) => void) | undefined;
}

const MACRO_PATTERN = /\[(CACHEBUSTING|TIMESTAMP|CONTENTPLAYHEAD|MEDIAPLAYHEAD|ADPLAYHEAD|ASSETURI)\]/g;

function formatPlayhead(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const ms = Math.round((Math.max(0, seconds) - whole) * 1000);
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');

  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

function defaultRequest(url: string): void {
  if (isFunction(globalThis.fetch)) {
    globalThis.fetch(url, { mode: 'no-cors', keepalive: true, credentials: 'omit' }).catch(noop);
    return;
  }

  if (typeof Image !== 'undefined') new Image().src = url;
}

/**
 * Replaces the VAST macros a player can fill without an ad server (`[CACHEBUSTING]`, `[TIMESTAMP]`,
 * `[CONTENTPLAYHEAD]`, `[MEDIAPLAYHEAD]`, `[ADPLAYHEAD]`, `[ASSETURI]`) and issues one request per URL.
 *
 * @experimental
 */
export class DefaultBeaconSender implements BeaconSender {
  readonly #request: (url: string) => void;

  constructor(options: DefaultBeaconSenderOptions = {}) {
    this.#request = options.request ?? defaultRequest;
  }

  send(event: TrackingEvent, context: TrackingContext): void {
    for (const url of event.urls) {
      this.#request(DefaultBeaconSender.replaceMacros(url, context));
    }
  }

  /** @internal Exposed for tests. */
  static replaceMacros(url: string, context: TrackingContext): string {
    return url.replace(MACRO_PATTERN, (_match, macro: string) => {
      switch (macro) {
        case 'CACHEBUSTING':
          return String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
        case 'TIMESTAMP':
          return encodeURIComponent(new Date().toISOString());
        case 'CONTENTPLAYHEAD':
        case 'MEDIAPLAYHEAD':
          return formatPlayhead(context.contentTime);
        case 'ADPLAYHEAD':
          return formatPlayhead(context.slot?.currentTime ?? context.placement?.currentTime ?? 0);
        case 'ASSETURI':
          return encodeURIComponent(context.session.primaryElement.currentSrc);
        default:
          return _match;
      }
    });
  }
}
