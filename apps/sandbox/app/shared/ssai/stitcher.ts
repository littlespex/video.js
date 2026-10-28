import { encodeEnvelope, type SvtaEnvelope } from '@videojs/ads';

/**
 * Builds a stitched VOD HLS source in the browser from two public Mux sources: content segments, an ad pod, more
 * content, another ad pod. Each break carries `EXT-X-PROGRAM-DATE-TIME` and an `EXT-X-DATERANGE` whose
 * `X-AD-CREATIVE-SIGNALING` attribute holds a base64 SVTA2053 envelope, which is exactly what the SVTA adapter reads.
 *
 * This is how an SSAI stitcher's output looks without a stitcher: one media playlist that splices ad segments between
 * content segments across discontinuities, with the ad metadata signaled in-band.
 */

const CONTENT_SRC = 'https://stream.mux.com/VcmKA6aqzIzlg3MayLJDnbF55kX00mds028Z65QxvBYaA.m3u8';
const AD_SRC = 'https://stream.mux.com/Sc89iWAyNkhJ3P1rQ02nrEdCFTnfT01CZ2KmaEcxXfB008.m3u8';

/** A beacon host the demo logs but never has to answer; `[CACHEBUSTING]` shows macro replacement in the log. */
const BEACONS = 'https://ads.example/beacon';

interface Segment {
  uri: string;
  duration: number;
}

export interface StitchedBreak {
  id: string;
  /** Content time (seconds) at which the break begins, for the caption under the player. */
  contentTime: number;
  startTime: number;
  duration: number;
  label: string;
}

export interface StitchedSource {
  /** Blob URL of the stitched master playlist, assigned to the media element's `src`. */
  src: string;
  breaks: StitchedBreak[];
  /** Total program duration without ad time, for the caption. */
  contentDuration: number;
}

/** Fetch a text resource as a string. */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load ${url}: ${response.status}`);

  return response.text();
}

/** Resolve a playlist URI against its manifest URL. */
function resolve(base: string, uri: string): string {
  return new URL(uri, base).toString();
}

/** The first variant playlist URL of a master playlist. */
function firstVariant(master: string, masterUrl: string): string {
  const lines = master.split('\n').map((line) => line.trim());

  for (let index = 0; index < lines.length; index++) {
    if (lines[index]!.startsWith('#EXT-X-STREAM-INF')) {
      const uri = lines[index + 1];
      if (uri && !uri.startsWith('#')) return resolve(masterUrl, uri);
    }
  }

  throw new Error('No variant found in master playlist');
}

/** The segments of a media playlist, with absolute URIs and their durations. */
function parseSegments(media: string, mediaUrl: string): Segment[] {
  const lines = media.split('\n').map((line) => line.trim());
  const segments: Segment[] = [];
  let duration = 0;

  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice('#EXTINF:'.length));
    } else if (line && !line.startsWith('#')) {
      segments.push({ uri: resolve(mediaUrl, line), duration });
      duration = 0;
    }
  }

  return segments;
}

/** Fetch a source's first-variant segments. */
async function loadSegments(masterUrl: string): Promise<Segment[]> {
  const master = await fetchText(masterUrl);
  const variantUrl = firstVariant(master, masterUrl);
  const media = await fetchText(variantUrl);

  return parseSegments(media, variantUrl);
}

function sum(segments: Segment[]): number {
  return segments.reduce((total, segment) => total + segment.duration, 0);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** A tracking record, written the SVTA way. */
function track(
  type: string,
  offset: number | null,
  suffix: string
): { type: string; offset: number | null; urls: string[] } {
  return { type, offset, urls: [`${BEACONS}/${suffix}?cb=[CACHEBUSTING]`] };
}

/** An inline slot envelope for the pre-roll: one creative with impression, quartiles, a skip control and a click. */
function preRollEnvelope(duration: number): SvtaEnvelope {
  return {
    version: 2,
    type: 'slot',
    payload: [
      {
        type: 'linear',
        start: 0,
        duration,
        identifiers: [{ scheme: 'urn:svta:advertising-wg:ad-id-signaling', value: 'VIDEOJS-PREROLL-001' }],
        tracking: [
          track('impression', null, 'preroll/impression'),
          track('firstQuartile', null, 'preroll/q1'),
          track('midpoint', null, 'preroll/q2'),
          track('thirdQuartile', null, 'preroll/q3'),
          track('complete', null, 'preroll/complete'),
        ],
        skipOffset: 5,
        clickThrough: 'https://videojs.org',
      },
    ],
  };
}

/** A pod envelope for the mid-roll whose two slots are fetched late through a blob `$remote`. */
function midRollEnvelope(startTime: number, duration: number): SvtaEnvelope {
  const half = round(duration / 2);
  const remote: SvtaEnvelope = {
    version: 2,
    type: 'slot',
    payload: [
      {
        type: 'linear',
        start: 0,
        duration: half,
        identifiers: [{ scheme: 'urn:svta:advertising-wg:ad-id-signaling', value: 'VIDEOJS-MIDROLL-001' }],
        tracking: [track('impression', null, 'midroll/1/impression'), track('complete', null, 'midroll/1/complete')],
        skipOffset: 5,
        clickThrough: 'https://videojs.org',
      },
      {
        type: 'linear',
        start: half,
        duration: round(duration - half),
        identifiers: [{ scheme: 'urn:svta:advertising-wg:ad-id-signaling', value: 'VIDEOJS-MIDROLL-002' }],
        tracking: [track('impression', null, 'midroll/2/impression'), track('complete', null, 'midroll/2/complete')],
        clickThrough: 'https://videojs.org',
      },
    ],
  };
  const remoteUrl = URL.createObjectURL(new Blob([JSON.stringify(remote)], { type: 'application/json' }));

  return {
    version: 2,
    type: 'pod',
    payload: [
      {
        start: startTime,
        duration,
        tracking: [track('podStart', null, 'midroll/podstart'), track('podEnd', null, 'midroll/podend')],
        $remote: { slots: remoteUrl },
      },
    ],
  };
}

/** The ISO date a break's `START-DATE` carries, from the epoch anchor and the break's media-time offset. */
function dateAt(anchor: number, offset: number): string {
  return new Date(anchor + offset * 1000).toISOString();
}

/** One `EXT-X-DATERANGE` tag carrying the base64 SVTA envelope. */
function dateRange(id: string, anchor: number, startTime: number, duration: number, envelope: SvtaEnvelope): string {
  return [
    `#EXT-X-DATERANGE:ID="${id}"`,
    `CLASS="urn:svta:advertising-wg:ad-id-signaling"`,
    `START-DATE="${dateAt(anchor, startTime)}"`,
    `DURATION=${duration}`,
    `X-AD-CREATIVE-SIGNALING="${encodeEnvelope(envelope)}"`,
  ].join(',');
}

/** Build the stitched source. Fetches the two masters and their first renditions, then splices one media playlist. */
export async function buildStitchedSource(): Promise<StitchedSource> {
  const [contentSegments, adSegments] = await Promise.all([loadSegments(CONTENT_SRC), loadSegments(AD_SRC)]);

  // A short, predictable layout: pre-roll, content, mid-roll, content.
  const preRoll = adSegments.slice(0, 3);
  const midRoll = adSegments.slice(3, 6);
  const contentA = contentSegments.slice(0, 6);
  const contentB = contentSegments.slice(6, 12);

  const preRollDuration = round(sum(preRoll));
  const midRollDuration = round(sum(midRoll));
  const contentADuration = round(sum(contentA));
  const contentBDuration = round(sum(contentB));

  const midRollStart = round(preRollDuration + contentADuration);
  const anchor = Date.now();
  const targetDuration = Math.ceil(
    Math.max(...[...preRoll, ...midRoll, ...contentA, ...contentB].map((segment) => segment.duration))
  );

  const lines: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-PROGRAM-DATE-TIME:${dateAt(anchor, 0)}`,
    dateRange('pre-roll', anchor, 0, preRollDuration, preRollEnvelope(preRollDuration)),
    dateRange('mid-roll', anchor, midRollStart, midRollDuration, midRollEnvelope(midRollStart, midRollDuration)),
  ];

  const emit = (segments: Segment[], discontinuity: boolean) => {
    if (discontinuity) lines.push('#EXT-X-DISCONTINUITY');

    for (const segment of segments) {
      lines.push(`#EXTINF:${segment.duration},`, segment.uri);
    }
  };

  emit(preRoll, false);
  emit(contentA, true);
  emit(midRoll, true);
  emit(contentB, true);

  lines.push('#EXT-X-ENDLIST', '');

  const mediaPlaylist = lines.join('\n');
  const mediaUrl = URL.createObjectURL(new Blob([mediaPlaylist], { type: 'application/vnd.apple.mpegurl' }));

  const bandwidth = 900000;
  const master = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},CODECS="avc1.64001f,mp4a.40.2"`,
    mediaUrl,
    '',
  ].join('\n');

  const src = URL.createObjectURL(new Blob([master], { type: 'application/vnd.apple.mpegurl' }));

  const contentDuration = round(contentADuration + contentBDuration);

  return {
    src,
    contentDuration,
    breaks: [
      { id: 'pre-roll', startTime: 0, duration: preRollDuration, contentTime: 0, label: 'Pre-roll (1 ad, inline)' },
      {
        id: 'mid-roll',
        startTime: midRollStart,
        duration: midRollDuration,
        contentTime: contentADuration,
        label: 'Mid-roll (2 ads, deferred $remote)',
      },
    ],
  };
}
