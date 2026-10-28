import { AdsExtension } from '@videojs/ads';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { MediaAdsExtension } from '../ads';
import { TestExtensionProvider } from './test-utils';

customElements.define('test-ads-provider', TestExtensionProvider);
customElements.define('test-media-ads', MediaAdsExtension);

function setup() {
  const provider = new TestExtensionProvider();
  const el = new MediaAdsExtension();

  provider.append(el);
  document.body.append(provider);

  return { provider, el };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('MediaAdsExtension', () => {
  it('registers an AdsExtension with the surrounding player', () => {
    const { provider } = setup();

    expect(provider.extensions.get(AdsExtension)).toBeInstanceOf(AdsExtension);
  });

  it('creates a session on the media the player attaches', () => {
    const { provider } = setup();
    const video = document.createElement('video');

    Object.defineProperty(video, 'seekable', {
      value: { length: 0, start: () => 0, end: () => 0 },
      configurable: true,
    });
    provider.extensions.attach({ media: video, container: null });

    const extension = provider.extensions.get(AdsExtension)!;

    expect(extension.session).not.toBeNull();
    expect(extension.session!.primaryElement).toBe(video);
  });

  it('forwards the enforce-restrictions attribute to the extension', () => {
    const { provider, el } = setup();

    el.setAttribute('enforce-restrictions', '');
    el.setAttribute('timeline', 'vod');

    const extension = provider.extensions.get(AdsExtension)!;

    expect(extension.enforceRestrictions).toBe(true);
    expect(extension.timeline).toBe('vod');
    expect(el.enforceRestrictions).toBe(true);
  });

  it('forwards the adapters property to the extension', () => {
    const { provider, el } = setup();
    const adapter = { name: 'custom', attach() {}, detach() {} };

    el.adapters = [adapter];

    expect(provider.extensions.get(AdsExtension)!.adapters).toEqual([adapter]);
  });
});
