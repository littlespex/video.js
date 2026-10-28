import type { PlayerTarget } from '@videojs/core/dom';
import { describe, expect, it, vi } from 'vite-plus/test';

import type { AdAdapter, AdapterHost } from '../adapter';
import { AdsExtension } from '../extension';
import { FakeMedia } from './fake-media';

/** A capturing adapter, so a test can write into the session the extension created. */
function captureAdapter(): AdAdapter & { host: AdapterHost | null } {
  return {
    name: 'capture',
    host: null,
    attach(host) {
      this.host = host;
    },
    detach() {},
  };
}

/** A real `<video>` with a controllable clock and seekable range, which `getMediaElement` accepts. */
function videoElement(duration: number): HTMLVideoElement {
  const video = document.createElement('video');
  let currentTime = 0;

  Object.defineProperty(video, 'duration', { value: duration, configurable: true });
  Object.defineProperty(video, 'seekable', {
    configurable: true,
    value: { length: 1, start: () => 0, end: () => duration },
  });
  Object.defineProperty(video, 'buffered', {
    configurable: true,
    value: { length: 1, start: () => 0, end: () => duration / 2 },
  });
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => currentTime,
    set: (value: number) => {
      currentTime = value;
      video.dispatchEvent(new Event('seeking'));
    },
  });

  return video;
}

function target(media: HTMLMediaElement): PlayerTarget {
  return { media: media as unknown as PlayerTarget['media'], container: null };
}

describe('AdsExtension', () => {
  it('creates a session on the native element and attaches the given adapters', () => {
    const adapter = captureAdapter();
    const extension = new AdsExtension();

    extension.adapters = [adapter];

    const video = videoElement(100);

    extension.attach(target(video));

    expect(extension.session).not.toBeNull();
    expect(extension.session!.primaryElement).toBe(video);
    expect(adapter.host?.session).toBe(extension.session);
  });

  it('defaults to the SVTA adapter when none are given', () => {
    const extension = new AdsExtension();

    extension.attach(target(videoElement(100)));

    expect(extension.session!.adapters.map((adapter) => adapter.name)).toEqual(['svta']);
  });

  it('overrides the clock with content time and routes seeks through the session', () => {
    const adapter = captureAdapter();
    const extension = new AdsExtension();

    extension.adapters = [adapter];

    const video = videoElement(100);

    extension.attach(target(video));
    adapter.host!.addInterstitial({ id: 'pre', startTime: 0, duration: 10 });

    const override = extension.mediaOverride!;

    // Stream time 25 is content time 15 once the 10s pre-roll is removed.
    video.currentTime = 25;
    expect(override.currentTime).toBe(15);
    expect(override.duration).toBe(90);

    // Seeking to content time 30 lands at stream time 40.
    (override as { currentTime: number }).currentTime = 30;
    expect(video.currentTime).toBe(40);
  });

  it('maps buffered and seekable into content time through one override object', () => {
    const adapter = captureAdapter();
    const extension = new AdsExtension();

    extension.adapters = [adapter];

    const video = videoElement(100);

    extension.attach(target(video));
    adapter.host!.addInterstitial({ id: 'pre', startTime: 0, duration: 10 });

    const override = extension.mediaOverride!;

    expect(extension.mediaOverride).toBe(override);
    expect(override.buffered!.end(0)).toBe(40);
    expect(override.seekable!.end(0)).toBe(90);
  });

  it('reports the ad session through the media override', () => {
    const extension = new AdsExtension();
    const video = videoElement(100);

    extension.attach(target(video));

    expect((extension.mediaOverride as { ads: unknown }).ads).toBe(extension.session);
  });

  it('has no override before media attaches and destroys the session on detach', () => {
    const extension = new AdsExtension();

    expect(extension.mediaOverride).toBeNull();

    extension.attach(target(videoElement(100)));
    const session = extension.session!;
    const destroy = vi.spyOn(session, 'destroy');

    extension.detach();

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(extension.session).toBeNull();
    expect(extension.mediaOverride).toBeNull();
  });

  it('does nothing for media with no native element', () => {
    const extension = new AdsExtension();

    extension.attach(target(new FakeMedia().asElement()));

    expect(extension.session).toBeNull();
  });
});
