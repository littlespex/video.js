import { describe, expect, it, vi } from 'vite-plus/test';

import { createAdSession } from '../../session';
import { FakeMedia } from '../../tests/fake-media';
import { SvtaAdapter } from '../adapter';
import { encodeEnvelope, type SvtaEnvelope } from '../envelope';

/** One hls.js-shaped metadata cue: one date-range attribute, keyed by the range id. */
class FakeMetadataCue {
  constructor(
    readonly id: string,
    readonly startTime: number,
    readonly endTime: number,
    readonly value: { key: string; data: unknown }
  ) {}
}

/** A `metadata` text track that holds cues and fires `cuechange` when they change. */
class FakeMetadataTrack extends EventTarget {
  readonly kind = 'metadata';
  readonly #cues: FakeMetadataCue[] = [];
  mode = 'hidden';

  /** As in a browser, a disabled track exposes no cue list. */
  get cues(): ArrayLike<FakeMetadataCue> | null {
    return this.mode === 'disabled' ? null : this.#cues;
  }

  /** Add the one cue a date range with a single `X-AD-CREATIVE-SIGNALING` attribute surfaces. */
  addDateRange(id: string, startTime: number, endTime: number, envelope: SvtaEnvelope): void {
    this.appendDateRange(id, startTime, endTime, envelope);
    this.dispatchEvent(new Event('cuechange'));
  }

  /** Add a date range's cues the way a playlist refresh does: without a `cuechange`. */
  appendDateRange(
    id: string,
    startTime: number,
    endTime: number,
    envelope: SvtaEnvelope,
    attributes: Record<string, unknown> = {}
  ): void {
    this.#cues.push(
      new FakeMetadataCue(id, startTime, endTime, { key: 'X-AD-CREATIVE-SIGNALING', data: encodeEnvelope(envelope) })
    );

    for (const [key, data] of Object.entries(attributes)) {
      this.#cues.push(new FakeMetadataCue(id, startTime, endTime, { key, data }));
    }
  }

  /** Drop a date range's cues, as hls.js does when a live playlist no longer lists it. */
  removeDateRange(id: string): void {
    for (let index = this.#cues.length - 1; index >= 0; index--) {
      if (this.#cues[index]!.id === id) this.#cues.splice(index, 1);
    }

    this.dispatchEvent(new Event('cuechange'));
  }
}

/** A `$remote` payload the test releases by hand. */
function deferredFetch() {
  let release!: (payload: unknown) => void;
  const payload = new Promise<unknown>((resolve) => (release = resolve));
  const fetchRemote = vi.fn((_url: string, _signal: AbortSignal) => payload);

  return { fetchRemote, release };
}

const REMOTE_SLOTS: SvtaEnvelope = {
  type: 'slot',
  payload: [
    { type: 'linear', start: 0, duration: 10 },
    { type: 'linear', start: 10, duration: 10 },
  ],
};

function remotePod(start: number, url: string): SvtaEnvelope {
  return { version: 2, type: 'pod', payload: [{ start, $remote: { slots: url } }] };
}

/** A text-track list with the `addtrack` surface the adapter watches. */
class FakeTextTracks extends EventTarget {
  readonly #tracks: FakeMetadataTrack[] = [];

  get length(): number {
    return this.#tracks.length;
  }

  [index: number]: FakeMetadataTrack;

  add(track: FakeMetadataTrack): void {
    this.#tracks.push(track);
    (this as unknown as Record<number, FakeMetadataTrack>)[this.#tracks.length - 1] = track;
    this.dispatchEvent(new Event('addtrack'));
  }
}

function setup(duration = 120) {
  const media = new FakeMedia();

  media.duration = duration;

  const textTracks = new FakeTextTracks();

  Object.defineProperty(media, 'textTracks', { value: textTracks, configurable: true });

  const session = createAdSession({ primaryElement: media.asElement() });

  return { media, session, textTracks };
}

const SLOT_ENVELOPE: SvtaEnvelope = {
  version: 2,
  type: 'slot',
  payload: [
    {
      type: 'linear',
      start: 0,
      duration: 15,
      identifiers: [{ scheme: 'urn:smpte:ul:060E2B34', value: 'ABC123' }],
      tracking: [{ type: 'impression', urls: ['https://beacons.example/imp'] }],
      skipOffset: 5,
      clickThrough: 'https://advertiser.example',
    },
  ],
};

describe('SvtaAdapter', () => {
  it('builds a stitched region from a slot envelope on an existing metadata track', () => {
    const { session, textTracks } = setup();
    const track = new FakeMetadataTrack();

    track.addDateRange('pre-roll', 0, 15, SLOT_ENVELOPE);
    textTracks.add(track);

    session.attachAdapter(new SvtaAdapter());

    const region = session.schedule.getById('pre-roll');

    expect(region).not.toBeNull();
    expect(region!.insertion).toBe('stitched');
    expect(region!.cue).toBe('pre');
    expect(region!.startTime).toBe(0);
    expect(region!.duration).toBe(15);
    expect([...region!.restrictions]).toEqual(['jump']);
    expect(region!.resolution).toBe('resolved');
    expect(region!.slots).toHaveLength(1);
    expect(region!.slots[0]!.skipControl).toEqual({ offset: 5, duration: null, labelId: null });
    expect(region!.slots[0]!.clickThrough).toBe('https://advertiser.example');
    expect(region!.slots[0]!.identifiers[0]!.value).toBe('ABC123');
  });

  it('reads a metadata track added after the adapter attaches', () => {
    const { session, textTracks } = setup();

    session.attachAdapter(new SvtaAdapter());

    const track = new FakeMetadataTrack();

    track.addDateRange('mid-roll', 30, 45, SLOT_ENVELOPE);
    textTracks.add(track);

    expect(session.schedule.getById('mid-roll')?.duration).toBe(15);
  });

  it('picks up new cues as the playlist reveals them', () => {
    const { session, textTracks } = setup();
    const track = new FakeMetadataTrack();

    textTracks.add(track);
    session.attachAdapter(new SvtaAdapter());

    expect(session.schedule.items).toHaveLength(0);

    track.addDateRange('mid-roll', 60, 75, SLOT_ENVELOPE);

    expect(session.schedule.getById('mid-roll')).not.toBeNull();
  });

  it('maps a pod envelope and defers its remote slots', async () => {
    const { session, textTracks } = setup();
    const track = new FakeMetadataTrack();

    textTracks.add(track);

    const fetchRemote = vi.fn(async () => ({
      type: 'slot',
      payload: [
        { type: 'linear', start: 0, duration: 10 },
        { type: 'linear', start: 10, duration: 10 },
      ],
    }));

    session.attachAdapter(new SvtaAdapter({ fetch: fetchRemote }));

    track.addDateRange('pod', 40, 60, {
      version: 2,
      type: 'pod',
      payload: [
        {
          start: 40,
          tracking: [{ type: 'podStart', urls: ['https://beacons.example/pod'] }],
          $remote: { slots: 'https://ads.example/slots' },
        },
      ],
    });

    const region = session.schedule.getById('pod')!;

    expect(region.resolution).toBe('resolving');
    expect(region.tracking).toHaveLength(1);
    expect(fetchRemote).toHaveBeenCalledWith('https://ads.example/slots', expect.any(AbortSignal));

    await vi.waitFor(() => expect(region.resolution).toBe('resolved'));
    expect(region.slots).toHaveLength(2);
    expect(region.duration).toBe(20);
  });

  it('fetches remote slots only once their region is the current or the next one', () => {
    const { media, session, textTracks } = setup();
    const track = new FakeMetadataTrack();
    const { fetchRemote } = deferredFetch();

    textTracks.add(track);
    session.attachAdapter(new SvtaAdapter({ fetch: fetchRemote }));

    track.addDateRange('first', 40, 60, remotePod(40, 'https://ads.example/first'));
    track.addDateRange('second', 80, 100, remotePod(80, 'https://ads.example/second'));

    expect(fetchRemote).toHaveBeenCalledTimes(1);
    expect(fetchRemote.mock.calls[0]![0]).toBe('https://ads.example/first');
    expect(session.schedule.getById('second')!.resolution).toBe('unresolved');

    // Once the playhead is past the first break the second is next up.
    media.jump(61);

    expect(fetchRemote).toHaveBeenCalledTimes(2);
    expect(fetchRemote.mock.calls[1]![0]).toBe('https://ads.example/second');
    expect(session.schedule.getById('second')!.resolution).toBe('resolving');
  });

  it('drops a remote payload for a region that left the schedule before it landed', async () => {
    const { session, textTracks } = setup();
    const track = new FakeMetadataTrack();
    const { fetchRemote, release } = deferredFetch();
    const errors: string[] = [];

    textTracks.add(track);
    session.attachAdapter(new SvtaAdapter({ fetch: fetchRemote }));
    session.addEventListener('interstitialerror', (event) => errors.push(event.detail.interstitial.id));

    track.addDateRange('pod', 40, 60, remotePod(40, 'https://ads.example/slots'));
    track.removeDateRange('pod');
    release(REMOTE_SLOTS);

    await Promise.resolve();
    await Promise.resolve();

    expect(session.schedule.getById('pod')).toBeNull();
    expect(errors).toEqual([]);
  });

  it('aborts an in-flight remote fetch when detached', () => {
    const { session, textTracks } = setup();
    const track = new FakeMetadataTrack();
    const { fetchRemote } = deferredFetch();
    const adapter = new SvtaAdapter({ fetch: fetchRemote });

    textTracks.add(track);
    session.attachAdapter(adapter);
    track.addDateRange('pod', 40, 60, remotePod(40, 'https://ads.example/slots'));

    const signal = fetchRemote.mock.calls[0]![1];

    expect(signal.aborted).toBe(false);
    session.detachAdapter(adapter);
    expect(signal.aborted).toBe(true);
  });

  it('removes a region whose date range leaves the track, unless it is playing', () => {
    const { media, session, textTracks } = setup();
    const track = new FakeMetadataTrack();

    textTracks.add(track);
    session.attachAdapter(new SvtaAdapter());

    track.addDateRange('first', 30, 45, SLOT_ENVELOPE);
    track.addDateRange('second', 60, 75, SLOT_ENVELOPE);
    media.advance(31);

    track.removeDateRange('first');
    track.removeDateRange('second');

    expect(session.schedule.getById('first')!.state).toBe('active');
    expect(session.schedule.getById('second')).toBeNull();
  });

  it('rescans when the primary reports progress, since hls.js appends cues without a cuechange', () => {
    const { media, session, textTracks } = setup();
    const track = new FakeMetadataTrack();

    textTracks.add(track);
    session.attachAdapter(new SvtaAdapter());

    track.appendDateRange('mid-roll', 60, 75, SLOT_ENVELOPE);
    expect(session.schedule.getById('mid-roll')).toBeNull();

    media.dispatchEvent(new Event('progress'));
    expect(session.schedule.getById('mid-roll')).not.toBeNull();
  });

  it('sets a disabled metadata track to hidden so its cues can be read', () => {
    const { session, textTracks } = setup();
    const track = new FakeMetadataTrack();

    track.mode = 'disabled';
    track.appendDateRange('mid-roll', 60, 75, SLOT_ENVELOPE);
    textTracks.add(track);
    session.attachAdapter(new SvtaAdapter());

    expect(track.mode).toBe('hidden');
    expect(session.schedule.getById('mid-roll')).not.toBeNull();
  });

  it('reads X-RESTRICT and X-PLAYOUT-LIMIT from the date range', () => {
    const { session, textTracks } = setup();
    const track = new FakeMetadataTrack();

    textTracks.add(track);
    session.attachAdapter(new SvtaAdapter());

    track.appendDateRange('mid-roll', 60, 75, SLOT_ENVELOPE, { 'X-RESTRICT': 'SKIP,JUMP', 'X-PLAYOUT-LIMIT': '12' });
    track.dispatchEvent(new Event('cuechange'));

    const region = session.schedule.getById('mid-roll')!;

    expect([...region.restrictions].sort()).toEqual(['jump', 'skip']);
    expect(region.playoutLimit).toBe(12);
  });

  it('keeps a pod-declared duration when the cue span differs', () => {
    const { session, textTracks } = setup();
    const track = new FakeMetadataTrack();

    textTracks.add(track);
    session.attachAdapter(new SvtaAdapter());

    track.addDateRange('mid-roll', 30, 42, { version: 2, type: 'pod', payload: [{ start: 30, duration: 20 }] });
    expect(session.schedule.getById('mid-roll')!.duration).toBe(20);

    (track.cues as FakeMetadataCue[])[0] = new FakeMetadataCue('mid-roll', 30, 45, {
      key: 'X-AD-CREATIVE-SIGNALING',
      data: encodeEnvelope({ version: 2, type: 'pod', payload: [{ start: 30, duration: 20 }] }),
    });
    track.dispatchEvent(new Event('cuechange'));

    expect(session.schedule.getById('mid-roll')!.duration).toBe(20);
  });

  it('marks a region errored when its remote slots fail to load', async () => {
    const { session, textTracks } = setup();
    const track = new FakeMetadataTrack();

    textTracks.add(track);
    session.attachAdapter(new SvtaAdapter({ fetch: () => Promise.reject(new Error('503')) }));

    track.addDateRange('pod', 40, 60, {
      version: 2,
      type: 'pod',
      payload: [{ start: 40, $remote: { slots: 'https://ads.example/slots' } }],
    });

    const region = session.schedule.getById('pod')!;

    await vi.waitFor(() => expect(region.resolution).toBe('error'));
  });

  it('ignores a date range that carries no SVTA attribute', () => {
    const { session, textTracks } = setup();
    const track = new FakeMetadataTrack();

    // An hls.js chapter or ID3 cue with a different attribute key.
    (track.cues as FakeMetadataCue[]).push(new FakeMetadataCue('chapter-1', 0, 30, { key: 'X-TITLE', data: 'Intro' }));
    textTracks.add(track);

    session.attachAdapter(new SvtaAdapter());

    expect(session.schedule.items).toHaveLength(0);
  });

  it('does not recreate a region it already added', () => {
    const { session, textTracks } = setup();
    const track = new FakeMetadataTrack();

    textTracks.add(track);
    session.attachAdapter(new SvtaAdapter());

    track.addDateRange('mid-roll', 30, 45, SLOT_ENVELOPE);
    const first = session.schedule.getById('mid-roll');

    const adapter = new SvtaAdapter();

    session.attachAdapter(adapter);
    adapter.scan();

    expect(session.schedule.items).toHaveLength(1);
    expect(session.schedule.getById('mid-roll')).toBe(first);
  });

  it('stops reading once detached', () => {
    const { session, textTracks } = setup();
    const track = new FakeMetadataTrack();
    const adapter = new SvtaAdapter();

    textTracks.add(track);
    session.attachAdapter(adapter);
    session.detachAdapter(adapter);

    track.addDateRange('mid-roll', 30, 45, SLOT_ENVELOPE);

    expect(session.schedule.items).toHaveLength(0);
  });

  it('refines a scheduled region when later cues extend its end', () => {
    const { session, textTracks } = setup();
    const track = new FakeMetadataTrack();

    textTracks.add(track);
    session.attachAdapter(new SvtaAdapter());

    track.addDateRange('mid-roll', 30, 42, { version: 2, type: 'pod', payload: [{ start: 30 }] });
    expect(session.schedule.getById('mid-roll')!.duration).toBe(12);

    // A later playlist refresh carries the same range with a known end.
    (track.cues as FakeMetadataCue[])[0] = new FakeMetadataCue('mid-roll', 30, 45, {
      key: 'X-AD-CREATIVE-SIGNALING',
      data: encodeEnvelope({ version: 2, type: 'pod', payload: [{ start: 30 }] }),
    });
    track.dispatchEvent(new Event('cuechange'));

    expect(session.schedule.getById('mid-roll')!.duration).toBe(15);
  });
});
