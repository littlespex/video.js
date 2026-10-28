import { describe, expect, it } from 'vite-plus/test';

import { decodeEnvelope, encodeEnvelope, podOf, slotsOf, toSlotInit, toTrackingEvent } from '../envelope';

describe('decodeEnvelope', () => {
  it('round-trips a base64 envelope', () => {
    const envelope = { version: 2, type: 'pod' as const, payload: [{ start: 10 }] };

    expect(decodeEnvelope(encodeEnvelope(envelope))).toEqual(envelope);
  });

  it('decodes URL-safe base64 without padding and non-ASCII text', () => {
    const envelope = { type: 'slot' as const, payload: [{ start: 0, duration: 10, title: 'Café ★ 広告' }] };
    const urlSafe = encodeEnvelope(envelope).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    expect(decodeEnvelope(urlSafe)).toEqual(envelope);
  });

  it('accepts raw JSON and a pre-parsed object', () => {
    const json = '{"type":"slot","payload":[]}';

    expect(decodeEnvelope(json)).toEqual({ type: 'slot', payload: [] });
    expect(decodeEnvelope({ type: 'slot', payload: [] })).toEqual({ type: 'slot', payload: [] });
  });

  it('rejects malformed input', () => {
    expect(decodeEnvelope('not base64 or json !!!')).toBeNull();
    expect(decodeEnvelope({ type: 'slot' })).toBeNull();
    expect(decodeEnvelope(null)).toBeNull();
    expect(decodeEnvelope(42)).toBeNull();
  });
});

describe('toSlotInit', () => {
  it('maps SVTA fields and turns skipOffset into a skip control', () => {
    expect(
      toSlotInit({
        start: 0,
        duration: 15,
        identifiers: [{ scheme: 'urn:a', value: 'b' }],
        media: [{ id: 'm', type: 'video/mp4', uri: 'https://x/ad.mp4' }],
        tracking: [{ type: 'impression', urls: ['https://x/i'] }],
        skipOffset: 5,
        clickThrough: 'https://x/click',
      })
    ).toEqual({
      type: 'linear',
      start: 0,
      duration: 15,
      identifiers: [{ scheme: 'urn:a', value: 'b' }],
      media: [{ id: 'm', type: 'video/mp4', uri: 'https://x/ad.mp4' }],
      tracking: [{ type: 'impression', offset: null, urls: ['https://x/i'] }],
      verifications: [],
      skipControl: { offset: 5, duration: null, labelId: null },
      clickThrough: 'https://x/click',
    });
  });

  it('leaves skipControl null when there is no skip offset', () => {
    expect(toSlotInit({ start: 0, duration: 10 }).skipControl).toBeNull();
  });
});

describe('toTrackingEvent', () => {
  it('defaults a missing offset to null', () => {
    expect(toTrackingEvent({ type: 'progress', urls: ['u'] })).toEqual({ type: 'progress', offset: null, urls: ['u'] });
    expect(toTrackingEvent({ type: 'progress', offset: 2, urls: ['u'] })).toEqual({
      type: 'progress',
      offset: 2,
      urls: ['u'],
    });
  });
});

describe('podOf and slotsOf', () => {
  it('reads the pod of a pod envelope and nothing from a slot envelope', () => {
    expect(podOf({ type: 'pod', payload: [{ start: 5 }] })).toEqual({ start: 5 });
    expect(podOf({ type: 'slot', payload: [] })).toBeNull();
  });

  it('reads the slots of a slot envelope and nothing from a pod envelope', () => {
    expect(slotsOf({ type: 'slot', payload: [{ start: 0, duration: 10 }] })).toHaveLength(1);
    expect(slotsOf({ type: 'pod', payload: [{ start: 5 }] })).toEqual([]);
  });
});
