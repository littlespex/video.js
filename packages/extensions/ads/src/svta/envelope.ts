import type { TrackingEventType } from '../enums';
import type { SlotInit } from '../interstitial';
import type { AdIdentifier, MediaReference, TrackingEvent, Verification } from '../records';

/**
 * The SVTA2053 Ad Creative Signaling schemes this adapter accepts. The working draft's normative text and every
 * published example disagree on the name, so both are treated as one scheme.
 *
 * @internal
 */
export const SVTA_SCHEMES: readonly string[] = [
  'urn:svta:advertising-wg:ad-creative-signaling',
  'urn:svta:advertising-wg:ad-id-signaling',
];

/**
 * The DATERANGE attribute, and the HLS Interstitial attributes, that carry the SVTA envelope and interstitial fields.
 *
 * @internal
 */
export const SVTA_ATTRIBUTE = 'X-AD-CREATIVE-SIGNALING';

/**
 * A reference to a payload fetched late. The SVTA model defers slot and tracking data behind `$remote` keys so a pod
 * can be signaled before its creatives are decided.
 *
 * @internal
 */
export interface SvtaRemote {
  slots?: string;
  tracking?: string;
  verifications?: string;
}

/**
 * The SVTA2053 Pod object: the fields this adapter reads from a `type: 'pod'` envelope.
 *
 * @internal
 */
export interface SvtaPod {
  start?: number;
  duration?: number;
  tracking?: SvtaTracking[];
  $remote?: SvtaRemote;
}

/**
 * The SVTA2053 Slot object.
 *
 * @internal
 */
export interface SvtaSlot {
  type?: 'linear';
  start: number;
  duration: number;
  identifiers?: AdIdentifier[];
  media?: MediaReference[];
  tracking?: SvtaTracking[];
  verifications?: Verification[];
  clickThrough?: string | null;
  skipOffset?: number | null;
}

/**
 * The SVTA2053 TrackingEvent object, before runtime offsets are normalized.
 *
 * @internal
 */
export interface SvtaTracking {
  type: TrackingEventType;
  offset?: number | null;
  urls: string[];
}

/**
 * An SVTA2053 Ad Creative Signaling envelope: a version, a payload type, and the payload array. `pod` and `slot` are
 * the types this adapter maps; others (`trackingEvent`, `verification`, `offer`) are ignored at the top level.
 *
 * @internal
 */
export interface SvtaEnvelope {
  version?: number;
  type: 'pod' | 'slot' | 'trackingEvent' | 'verification' | (string & {});
  payload: unknown[];
}

/**
 * Decode a base64 (or already-parsed) envelope. Returns `null` when the value is not a usable envelope.
 *
 * @internal
 */
export function decodeEnvelope(value: unknown): SvtaEnvelope | null {
  let parsed: unknown = value;

  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(isLikelyBase64(value) ? decodeBase64(value) : value);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const envelope = parsed as Partial<SvtaEnvelope>;
  if (typeof envelope.type !== 'string' || !Array.isArray(envelope.payload)) return null;

  return envelope as SvtaEnvelope;
}

/**
 * Encode an envelope as the base64 JSON an `X-AD-CREATIVE-SIGNALING` attribute carries. For fixtures and tests.
 *
 * @internal
 */
export function encodeEnvelope(envelope: SvtaEnvelope): string {
  return encodeBase64(JSON.stringify(envelope));
}

/**
 * Map an SVTA Slot to a {@link SlotInit}, turning `skipOffset` into a skip control.
 *
 * @internal
 */
export function toSlotInit(slot: SvtaSlot): SlotInit {
  return {
    type: slot.type ?? 'linear',
    start: slot.start,
    duration: slot.duration,
    identifiers: slot.identifiers ?? [],
    media: slot.media ?? [],
    tracking: (slot.tracking ?? []).map(toTrackingEvent),
    verifications: slot.verifications ?? [],
    skipControl:
      slot.skipOffset === null || slot.skipOffset === undefined
        ? null
        : { offset: slot.skipOffset, duration: null, labelId: null },
    clickThrough: slot.clickThrough ?? null,
  };
}

/** Normalize an SVTA TrackingEvent: a missing offset becomes `null`. */
export function toTrackingEvent(tracking: SvtaTracking): TrackingEvent {
  return { type: tracking.type, offset: tracking.offset ?? null, urls: tracking.urls };
}

/** The single Pod of a `type: 'pod'` envelope, or `null`. */
export function podOf(envelope: SvtaEnvelope): SvtaPod | null {
  return envelope.type === 'pod' ? ((envelope.payload[0] as SvtaPod | undefined) ?? null) : null;
}

/** The slots of a `type: 'slot'` envelope. */
export function slotsOf(envelope: SvtaEnvelope): SvtaSlot[] {
  return envelope.type === 'slot' ? (envelope.payload as SvtaSlot[]) : [];
}

// ----------------------------------------
// base64
// ----------------------------------------

/** Standard or URL-safe base64, with or without padding, is anything that is not JSON text. */
function isLikelyBase64(value: string): boolean {
  return !value.trimStart().startsWith('{') && /^[A-Za-z0-9+/\-_=\s]+$/.test(value);
}

function decodeBase64(value: string): string {
  const standard = value.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, '=');
  const binary = atob(padded);

  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function encodeBase64(value: string): string {
  let binary = '';

  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);

  return btoa(binary);
}
