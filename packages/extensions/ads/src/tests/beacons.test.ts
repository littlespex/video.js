import { describe, expect, it, vi } from 'vite-plus/test';

import { DefaultBeaconSender, type TrackingContext } from '../beacons';
import type { AdSession } from '../session';

function context(overrides: Partial<TrackingContext> = {}): TrackingContext {
  return {
    session: { primaryElement: { currentSrc: 'https://cdn.example/a b.m3u8' } } as AdSession,
    interstitial: null,
    slot: { currentTime: 3.25 } as TrackingContext['slot'],
    placement: null,
    streamTime: 75.5,
    contentTime: 65.5,
    firstPlay: true,
    ...overrides,
  };
}

describe('DefaultBeaconSender', () => {
  it('fills the macros a player knows and requests every URL', () => {
    const request = vi.fn();
    const sender = new DefaultBeaconSender({ request });

    sender.send(
      {
        type: 'progress',
        offset: 3,
        urls: [
          'https://b.example/1?t=[CONTENTPLAYHEAD]&a=[ADPLAYHEAD]&u=[ASSETURI]&k=[UNKNOWN]',
          'https://b.example/2',
        ],
      },
      context()
    );

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]![0]).toBe(
      'https://b.example/1?t=00:01:05.500&a=00:00:03.250&u=https%3A%2F%2Fcdn.example%2Fa%20b.m3u8&k=[UNKNOWN]'
    );
    expect(request.mock.calls[1]![0]).toBe('https://b.example/2');
  });

  it('gives each request a fresh cache buster and timestamp', () => {
    const request = vi.fn();
    const sender = new DefaultBeaconSender({ request });
    const event = {
      type: 'impression' as const,
      offset: null,
      urls: ['https://b.example/?c=[CACHEBUSTING]&ts=[TIMESTAMP]'],
    };

    sender.send(event, context());
    sender.send(event, context());

    const [first, second] = request.mock.calls.map((call) => new URL(call[0] as string));

    expect(first!.searchParams.get('c')).toMatch(/^\d{8}$/);
    expect(first!.searchParams.get('ts')).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(first!.searchParams.get('c')).not.toBe(second!.searchParams.get('c'));
  });

  it('skips records that fall due on a replay unless asked to send them', () => {
    const request = vi.fn();
    const event = { type: 'impression' as const, offset: null, urls: ['https://b.example/imp'] };

    new DefaultBeaconSender({ request }).send(event, context({ firstPlay: false }));
    expect(request).not.toHaveBeenCalled();

    new DefaultBeaconSender({ request, replays: true }).send(event, context({ firstPlay: false }));
    expect(request).toHaveBeenCalledTimes(1);
  });
});
