import type { TrackingEventType } from './enums';

/**
 * SVTA2053 `AdIdentifier`. `scheme` is a URI naming the authority (for example Ad-ID).
 *
 * @experimental
 */
export interface AdIdentifier {
  scheme: string;
  value: string;
}

/**
 * SVTA2053 `MediaReference`. `type` is an IANA media type.
 *
 * @experimental
 */
export interface MediaReference {
  id: string;
  type: string;
  uri: string;
}

/**
 * SVTA2053 `TrackingEvent`. `offset` is seconds relative to the containing slot or interstitial start. When `null`,
 * timing is implied by `type`.
 *
 * @experimental
 */
export interface TrackingEvent {
  type: TrackingEventType;
  offset: number | null;
  urls: string[];
}

/**
 * SVTA2053 `Verification`. Opaque to the player; handed to the OMID or vendor SDK.
 *
 * @experimental
 */
export interface Verification {
  vendor: string;
  resource: string | null;
  parameters: string | null;
}

/**
 * When and how the skip control appears.
 *
 * @experimental
 */
export interface SkipControl {
  /** Seconds into the slot before the control may show. */
  offset: number;
  /** How long the control stays available; `null` means until the slot ends. */
  duration: number | null;
  /** Localization key for the button text (HLS `X-SKIP-CONTROL-LABEL-ID`). */
  labelId: string | null;
}
