# @videojs/ads

The Video.js ad session: one schedule of interstitial regions per primary stream, the slots inside them, the clock that
drives their state, tracking records fired as data, and the SVTA2053 adapter that reads break signaling from the
primary element's `metadata` text track. It is an extension: it adds ad awareness to whichever media the player is
playing, and today it covers stitched (SSAI) regions.

```bash
pnpm add @videojs/html @videojs/ads
```

## Usage

```ts
import '@videojs/html/video/player';
import '@videojs/html/media/hlsjs-video';
import '@videojs/html/extensions/ads';
```

```html
<video-player>
  <hlsjs-video src="https://example.com/stitched.m3u8"></hlsjs-video>
  <media-ads></media-ads>
</video-player>
```

`<media-ads>` creates an `AdSession` on the native element behind the media, attaches the SVTA2053 adapter, and presents
content time on `currentTime`, `duration` and `seekable`, so the stock time slider and time display hide stitched ad
time. Compose `adsFeature` into the player to read `selectAds` state (break and slot progress, skip availability,
`timelineMarkers`) from controls.

```ts
import { adsFeature, selectAds } from '@videojs/ads';
import { videoFeatures } from '@videojs/core/dom';
import { createPlayer } from '@videojs/html';

const { PlayerElement } = createPlayer({ features: [...videoFeatures, adsFeature] });
```

Analytics subscribes to the session itself (the `session` property of `<media-ads>`, or `media.ads` on the store's
media) for `tracking`, `slotprogress` and the other events in `AdSessionEventMap`. Set `beacons` to a
`DefaultBeaconSender` to have due records requested over HTTP; it skips records that fall due while a break plays again
unless constructed with `replays: true`.

## License

[Apache-2.0](../../../LICENSE)
