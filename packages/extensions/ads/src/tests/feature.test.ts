import type { PlayerTarget } from '@videojs/core/dom';
import { createStore } from '@videojs/store';
import { describe, expect, it } from 'vite-plus/test';

import type { AdapterHost } from '../adapter';
import { adsFeature } from '../feature';
import { createAdSession } from '../session';
import { FakeMedia } from './fake-media';

/** A media that exposes an ad session, as the extension's facade presents it to the store. */
function mediaWithAds(duration = 120) {
  const media = new FakeMedia();

  media.duration = duration;
  media.seekableRanges = [[0, duration]];

  const session = createAdSession({ primaryElement: media.asElement() });
  let host!: AdapterHost;

  session.attachAdapter({
    name: 'test',
    attach: (received) => {
      host = received;
    },
    detach: () => {},
  });

  Object.defineProperty(media, 'ads', { value: session, configurable: true });

  return { media, session, host };
}

function attach(duration?: number) {
  const { media, session, host } = mediaWithAds(duration);
  const store = createStore<PlayerTarget>()(adsFeature);

  store.attach({ media: media.asElement() as unknown as PlayerTarget['media'], container: null });

  return { media, session, host, store };
}

describe('adsFeature', () => {
  it('starts empty and stays inert for media without a session', () => {
    const media = new FakeMedia();
    const store = createStore<PlayerTarget>()(adsFeature);

    store.attach({ media: media.asElement() as unknown as PlayerTarget['media'], container: null });

    expect(store.state.adBreakActive).toBe(false);
    expect(store.state.timelineMarkers).toEqual([]);
    expect(() => store.state.skipAd()).not.toThrow();
  });

  it('contributes a timeline marker per ad break in content time', () => {
    const { host, store } = attach(100);

    host.addInterstitial({ id: 'pre', startTime: 0, duration: 10 });
    host.addInterstitial({ id: 'mid', startTime: 40, duration: 20 });

    // On VOD a stitched break collapses to a point in content time, so the marker has no width.
    expect(store.state.timelineMarkers).toEqual([
      { id: 'pre', time: 0, duration: 0, kind: 'ad', label: null, played: false, style: 'highlight' },
      { id: 'mid', time: 30, duration: 0, kind: 'ad', label: null, played: false, style: 'highlight' },
    ]);
  });

  it('projects break and slot progress while a break plays', () => {
    const { media, host, store } = attach();

    host.addInterstitial({ id: 'a', startTime: 10, duration: 20 });
    host.resolve('a', [
      { start: 0, duration: 10, title: 'First ad', skipControl: { offset: 5, duration: null, labelId: 'skip' } },
      { start: 10, duration: 10 },
    ]);

    media.advance(13);

    expect(store.state.adBreakActive).toBe(true);
    expect(store.state.adBreakKind).toBe('ad');
    expect(store.state.adSlotIndex).toBe(1);
    expect(store.state.adSlotCount).toBe(2);
    expect(store.state.adSlotTitle).toBe('First ad');
    expect(store.state.adSkippable).toBe(false);
    expect(store.state.adSkipLabelId).toBe('skip');
    expect(store.state.adSkipAvailableIn).toBe(2);
    expect(store.state.adContentPaused).toBe(false);
    expect(store.state.adRestrictions).toEqual([]);

    media.advance(16);
    expect(store.state.adSkippable).toBe(true);
    expect(store.state.adSkipAvailableIn).toBeNull();

    media.advance(35);
    expect(store.state.adBreakActive).toBe(false);
    expect(store.state.timelineMarkers[0]!.played).toBe(true);
  });

  it('keeps the marker array reference stable across a bare clock tick', () => {
    const { media, host, store } = attach();

    host.addInterstitial({ id: 'a', startTime: 40, duration: 10 });

    const markers = store.state.timelineMarkers;

    media.jump(5);
    media.jump(6);

    expect(store.state.timelineMarkers).toBe(markers);
  });

  it('routes the skip action to the current slot', () => {
    const { media, host, store } = attach();

    host.addInterstitial({ id: 'a', startTime: 10, duration: 10 });
    host.resolve('a', [{ start: 0, duration: 10, skipControl: { offset: 0, duration: null, labelId: null } }]);

    media.advance(12);
    expect(store.state.adSkippable).toBe(true);

    store.state.skipAd();
    media.settle();

    expect(media.currentTime).toBe(20);
  });

  it('exposes active placements and dismisses them through the action', () => {
    const { host, store } = attach();
    const creative = {
      media: [],
      width: 600,
      height: 600,
      aspectRatio: '1:1',
      fileSize: null,
      bitrate: null,
      codec: null,
      supportsTransparency: false,
      title: null,
      clickThrough: null,
    };

    host.addPlacement({ id: 'pause', kind: 'pause', trigger: 'userAction', creative });
    host.activatePlacement('pause');

    expect(store.state.adPlacements).toEqual([
      {
        id: 'pause',
        kind: 'pause',
        state: 'active',
        layout: { adViewport: { top: 0, right: 0, bottom: 0, left: 0 }, contentViewport: null, transitionDuration: 0 },
        remaining: null,
      },
    ]);

    store.state.dismissAdPlacement('pause');

    expect(store.state.adPlacements).toEqual([]);
  });
});
