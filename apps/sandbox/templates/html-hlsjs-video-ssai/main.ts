import '@app/styles.css';
import '@videojs/html/media/hlsjs-video';
import '@videojs/html/ui/container';
import '@videojs/html/ui/controls';
import '@videojs/html/ui/controls-content';
import '@videojs/html/ui/controls-group';
import '@videojs/html/ui/time-slider';
import '@videojs/html/ui/slider-track';
import '@videojs/html/ui/slider-buffer';
import '@videojs/html/ui/slider-fill';
import '@videojs/html/ui/slider-thumb';
import '@videojs/html/ui/time-slider-markers';
import '@videojs/html/ui/play-button';
import '@videojs/html/ui/mute-button';
import '@videojs/html/ui/fullscreen-button';
import '@videojs/html/ui/time';
import '@videojs/html/ui/time-group';
import '@videojs/html/ui/time-separator';
import '@videojs/html/extensions/ads';
import { buildStitchedSource, type StitchedSource } from '@app/shared/ssai/stitcher';
import type { AdSession, AdSessionEventMap } from '@videojs/ads';
import { adsFeature, selectAds } from '@videojs/ads';
import { videoFeatures } from '@videojs/core/dom';
import { createPlayer, PlayerController, playerContext, type PropertyValues, UIElement } from '@videojs/html';
import type { MediaAdsExtension } from '@videojs/html/extensions/ads';

// A player whose store carries the ad feature alongside the standard video features, so controls can read `selectAds`
// and the time slider can render the ad markers.
const { PlayerElement } = createPlayer({ features: [...videoFeatures, adsFeature] });

customElements.define('ssai-player', class extends PlayerElement {});

/**
 * The ad chrome shown over the video while a break plays: an ad counter, a countdown, a skip control and a
 * click-through.
 */
class SsaiAdOverlay extends UIElement {
  readonly #ads = new PlayerController(this, playerContext, selectAds);

  protected override update(changed: PropertyValues): void {
    super.update(changed);

    const ads = this.#ads.value;
    const active = ads?.adBreakActive ?? false;

    this.toggleAttribute('data-active', active);

    if (!active || !ads) {
      this.textContent = '';
      return;
    }

    const remaining = ads.adBreakRemaining === null ? '' : `${Math.ceil(ads.adBreakRemaining)}s`;
    const counter = ads.adSlotCount ? `Ad ${ads.adSlotIndex} of ${ads.adSlotCount}` : 'Ad';

    this.replaceChildren();

    const label = document.createElement('span');

    label.className = 'ssai-ad-label';
    label.textContent = `${counter}${remaining ? ` · ${remaining}` : ''}`;
    this.append(label);

    if (ads.adClickThrough) {
      const visit = document.createElement('button');

      visit.type = 'button';
      visit.className = 'ssai-ad-visit';
      visit.textContent = 'Visit advertiser';
      visit.addEventListener('click', () => {
        ads.clickAd();
        window.open(ads.adClickThrough!, '_blank', 'noopener');
      });
      this.append(visit);
    }

    const skip = document.createElement('button');

    skip.type = 'button';
    skip.className = 'ssai-ad-skip';

    if (ads.adSkippable) {
      skip.textContent = 'Skip ad ▸';
      skip.disabled = false;
      skip.addEventListener('click', () => ads.skipAd());
    } else {
      skip.textContent =
        ads.adSkipAvailableIn === null ? 'Skipping disabled' : `Skip in ${Math.ceil(ads.adSkipAvailableIn)}s`;
      skip.disabled = true;
    }

    this.append(skip);
  }
}

customElements.define('ssai-ad-overlay', SsaiAdOverlay);

const root = document.querySelector('#root')!;

root.innerHTML = `
  <style>
    .ssai-frame { position: relative; overflow: hidden; border-radius: 12px; background: #000; aspect-ratio: 16 / 9; }
    .ssai-frame hlsjs-video { width: 100%; height: 100%; }

    media-controls { position: absolute; inset: auto 0 0 0; }
    media-controls-content { display: flex; flex-direction: column; gap: 8px; padding: 10px 14px 14px; background: linear-gradient(transparent, rgba(0,0,0,0.75)); }
    media-controls-group { display: flex; align-items: center; gap: 10px; color: #fff; }

    media-time-slider { position: relative; display: block; height: 20px; cursor: pointer; }
    media-slider-track { position: absolute; inset: 7px 0; border-radius: 999px; background: rgba(255,255,255,0.25); }
    media-slider-buffer { position: absolute; inset: 0; width: var(--media-slider-buffer); border-radius: 999px; background: rgba(255,255,255,0.35); }
    media-slider-fill { position: absolute; inset: 0; width: var(--media-slider-fill); border-radius: 999px; background: #ef4444; }
    media-slider-thumb { position: absolute; top: 50%; left: var(--media-slider-fill); width: 13px; height: 13px; translate: -50% -50%; border-radius: 50%; background: #fff; }

    media-time-slider-markers { position: absolute; inset: 0; pointer-events: none; }
    .ssai-marker { position: absolute; top: 0; bottom: 0; left: var(--media-slider-marker-start); width: var(--media-slider-marker-width); min-width: 3px; background: #facc15; border-radius: 2px; opacity: 0.9; }
    .ssai-marker[data-played] { background: #a1a1aa; }

    .ssai-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 40px; height: 32px; padding: 0 10px; border-radius: 8px; border: 0; background: rgba(255,255,255,0.12); color: #fff; font: inherit; font-size: 13px; cursor: pointer; }
    .ssai-btn:hover { background: rgba(255,255,255,0.22); }
    media-time { font-variant-numeric: tabular-nums; font-size: 13px; }
    .ssai-spacer { flex: 1; }

    ssai-ad-overlay { position: absolute; left: 14px; bottom: 76px; display: none; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 10px; background: rgba(0,0,0,0.72); color: #fff; font-size: 13px; }
    ssai-ad-overlay[data-active] { display: flex; }
    .ssai-ad-label { font-weight: 600; letter-spacing: 0.02em; }
    .ssai-ad-visit { border: 0; background: transparent; color: #93c5fd; text-decoration: underline; cursor: pointer; font: inherit; }
    .ssai-ad-skip { border: 1px solid rgba(255,255,255,0.4); background: rgba(255,255,255,0.1); color: #fff; border-radius: 6px; padding: 4px 10px; font: inherit; cursor: pointer; }
    .ssai-ad-skip:disabled { opacity: 0.6; cursor: default; }

    .ssai-caption { font-size: 13px; color: #a1a1aa; }
    .ssai-caption b { color: #fafafa; font-weight: 600; }
    .ssai-log { height: 220px; overflow: auto; border: 1px solid #27272a; border-radius: 10px; background: #09090b; padding: 10px 12px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .ssai-log div { white-space: pre-wrap; }
    .ssai-log .ev-tracking { color: #86efac; }
    .ssai-log .ev-interstitial { color: #fcd34d; }
    .ssai-log .ev-slot { color: #93c5fd; }
    .ssai-log .ev-seek { color: #f9a8d4; }
    .ssai-status { font-size: 13px; color: #a1a1aa; }
  </style>

  <h1 class="text-lg font-semibold">Server-side ad insertion (SSAI) with <code>&lt;hlsjs-video&gt;</code></h1>
  <p class="ssai-caption">A stitched VOD stream: a pre-roll and a mid-roll ad pod are spliced into the content, each
    signaled in-band with <code>EXT-X-DATERANGE</code> carrying an SVTA2053 envelope. The ad time is hidden from the
    scrubber; the yellow markers show where the breaks sit in content time.</p>

  <div class="ssai-frame">
    <ssai-player>
      <media-container style="position:absolute; inset:0;">
        <hlsjs-video playsinline crossorigin></hlsjs-video>
        <media-ads></media-ads>

        <ssai-ad-overlay></ssai-ad-overlay>

        <media-controls>
          <media-controls-content>
            <media-time-slider>
              <media-slider-track>
                <media-slider-buffer></media-slider-buffer>
                <media-slider-fill></media-slider-fill>
                <media-time-slider-markers>
                  <template><span class="ssai-marker"></span></template>
                </media-time-slider-markers>
              </media-slider-track>
              <media-slider-thumb></media-slider-thumb>
            </media-time-slider>

            <media-controls-group>
              <media-play-button class="ssai-btn">
                <span class="show-when-paused">Play</span>
                <span class="show-when-playing">Pause</span>
              </media-play-button>
              <media-mute-button class="ssai-btn">
                <span class="show-when-muted">Unmute</span>
                <span class="show-when-unmuted">Mute</span>
              </media-mute-button>
              <media-time-group>
                <media-time type="current"></media-time>
                <media-time-separator>/</media-time-separator>
                <media-time type="duration"></media-time>
              </media-time-group>
              <span class="ssai-spacer"></span>
              <media-fullscreen-button class="ssai-btn">
                <span class="show-when-fullscreen">Exit</span>
                <span class="show-when-not-fullscreen">Fullscreen</span>
              </media-fullscreen-button>
            </media-controls-group>
          </media-controls-content>
        </media-controls>
      </media-container>
    </ssai-player>
  </div>

  <p class="ssai-status" id="status">Building the stitched stream…</p>
  <div>
    <div class="ssai-caption" style="margin-bottom:6px;"><b>Session events</b> (schedule, breaks, slots, tracking, seeks)</div>
    <div class="ssai-log" id="log"></div>
  </div>
`;

const statusEl = document.querySelector('#status')!;
const logEl = document.querySelector('#log')!;

function log(category: string, message: string): void {
  const line = document.createElement('div');

  line.className = `ev-${category}`;
  line.textContent = `${new Date().toLocaleTimeString('en', { hour12: false })}  ${message}`;
  logEl.append(line);
  logEl.scrollTop = logEl.scrollHeight;
}

/** Subscribe the event log to the session's lifecycle, break, slot, tracking and navigation events. */
function wireLog(session: AdSession): void {
  const on = <K extends keyof AdSessionEventMap>(type: K, handler: (detail: AdSessionEventMap[K]) => void) =>
    session.addEventListener(type, (event) => handler(event.detail));

  on('scheduleupdated', (detail) => {
    for (const item of detail.added)
      log('interstitial', `schedule + ${item.id} @ ${item.startTime}s (${item.insertion})`);
  });
  on('interstitialresolved', (detail) =>
    log('interstitial', `resolved ${detail.interstitial.id} → ${detail.interstitial.slots.length} slot(s)`)
  );
  on('interstitialstart', (detail) =>
    log('interstitial', `break start ${detail.interstitial.id}${detail.firstPlay ? '' : ' (replay)'}`)
  );
  on('interstitialend', (detail) => log('interstitial', `break end ${detail.interstitial.id} (${detail.reason})`));
  on('slotstart', (detail) =>
    log('slot', `ad start ${detail.slot.id} — ${detail.slot.identifiers[0]?.value ?? 'unknown'}`)
  );
  on('slotskipstatechange', (detail) =>
    log('slot', `skip ${detail.skippable ? 'available' : 'unavailable'} for ${detail.slot.id}`)
  );
  on('slotskip', (detail) => log('slot', `viewer skipped ${detail.slot.id}`));
  on('slotend', (detail) => log('slot', `ad end ${detail.slot.id} (${detail.reason})`));
  on('tracking', (detail) => log('tracking', `beacon ${detail.event.type} → ${detail.event.urls[0]}`));
  on('seekblocked', (detail) => log('seek', `seek blocked by ${detail.interstitial.id}; redirected to its start`));
  on('snapback', (detail) => log('seek', `snapback to ${Math.round(detail.to)}s after ${detail.interstitial.id}`));
}

/** Wait for the extension to create its session once the player attaches media, then wire the log. */
function onSession(mediaAds: MediaAdsExtension, ready: (session: AdSession) => void): void {
  const poll = () => {
    const session = mediaAds.session;

    if (session) ready(session);
    else requestAnimationFrame(poll);
  };

  poll();
}

async function start(): Promise<void> {
  let source: StitchedSource;

  try {
    source = await buildStitchedSource();
  } catch (error) {
    statusEl.textContent = `Could not build the stitched stream: ${(error as Error).message}`;
    return;
  }

  const video = document.querySelector('hlsjs-video')!;
  const mediaAds = document.querySelector('media-ads') as MediaAdsExtension;

  onSession(mediaAds, (session) => {
    wireLog(session);
    log('interstitial', 'session ready');
  });

  video.src = source.src;

  const breaks = source.breaks.map((item) => `${item.label} at ${Math.round(item.contentTime)}s content`).join(' · ');

  statusEl.innerHTML = `Program is <b>${Math.round(source.contentDuration)}s</b> of content. Breaks: ${breaks}. Try seeking past the mid-roll: an unplayed <code>jump</code> break snaps you into it.`;
}

void start();
