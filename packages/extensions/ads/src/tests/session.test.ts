import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import type { AdAdapter, AdapterHost } from '../adapter';
import type { AdSessionEventMap, AdSessionEventType } from '../events';
import type { InterstitialInit, SlotInit } from '../interstitial';
import type { TrackingEvent } from '../records';
import { type AdSession, type AdSessionInit, createAdSession } from '../session';
import { FakeMedia } from './fake-media';

/** An adapter that hands its host back, so tests write into the session directly. */
function createHostAdapter(): AdAdapter & { host: AdapterHost } {
  return {
    name: 'test',
    host: null as unknown as AdapterHost,
    attach(host) {
      this.host = host;
    },
    detach() {},
  };
}

function setup(init: Partial<AdSessionInit> = {}, duration = 120) {
  const media = new FakeMedia();

  media.duration = duration;
  media.seekableRanges = [[0, duration]];

  const session = createAdSession({ primaryElement: media.asElement(), ...init });
  const adapter = createHostAdapter();

  session.attachAdapter(adapter);

  return { media, session, host: adapter.host, adapter };
}

function record(type: TrackingEvent['type'], offset: number | null = null): TrackingEvent {
  return { type, offset, urls: [`https://beacons.example/${type}${offset === null ? '' : `-${offset}`}`] };
}

function region(
  id: string,
  startTime: number,
  duration: number,
  extra: Partial<InterstitialInit> = {}
): InterstitialInit {
  return { id, startTime, duration, ...extra };
}

function slots(count: number, each: number, extra: Partial<SlotInit> = {}): SlotInit[] {
  return Array.from({ length: count }, (_, index) => ({ start: index * each, duration: each, ...extra }));
}

/** Collect the names of every event the session dispatches, with the id of the object it concerns. */
function recordEvents(session: AdSession, types: readonly AdSessionEventType[]): string[] {
  const log: string[] = [];

  for (const type of types) {
    session.addEventListener(type, (event: CustomEvent<Record<string, unknown>>) => {
      const detail = event.detail;
      // A tracking event names its subject through the context, not the detail.
      const source = (type === 'tracking' ? (detail.context as Record<string, unknown>) : detail) ?? detail;
      const subject =
        (source.slot as { id: string } | undefined)?.id ??
        (source.interstitial as { id: string } | undefined)?.id ??
        (source.placement as { id: string } | undefined)?.id ??
        '';
      const suffix =
        type === 'tracking'
          ? `:${(detail.event as TrackingEvent).type}`
          : 'reason' in detail
            ? `:${String(detail.reason)}`
            : '';

      log.push(`${type}${subject ? `(${subject})` : ''}${suffix}`);
    });
  }

  return log;
}

describe('createAdSession', () => {
  describe('schedule', () => {
    it('orders regions by start time, with unknown starts last in arrival order', () => {
      const { host, session } = setup();

      host.addInterstitial(region('mid', 30, 10));
      host.addInterstitial({ id: 'post', startTime: null, cue: 'post' });
      host.addInterstitial(region('pre', 0, 10, { cue: 'pre' }));
      host.addInterstitial({ id: 'post-2', startTime: null, cue: 'post' });

      expect(session.schedule.items.map((item) => item.id)).toEqual(['pre', 'mid', 'post', 'post-2']);
      expect(session.schedule.getById('mid')?.endTime).toBe(40);
      expect(session.schedule.nextAfter(5)?.id).toBe('mid');
      expect(session.schedule.previousBefore(35)?.id).toBe('mid');
      expect(session.schedule.unplayedBetween(0, 30).map((item) => item.id)).toEqual(['mid']);
    });

    it('announces additions, changes and removals', () => {
      const { host, session } = setup();
      const updates: AdSessionEventMap['scheduleupdated'][] = [];

      session.addEventListener('scheduleupdated', (event) => updates.push(event.detail));

      const item = host.addInterstitial(region('a', 30, 10));

      host.updateInterstitial('a', { startTime: 50 });
      host.removeInterstitial('a');

      expect(updates.map((update) => [update.added.length, update.changed.length, update.removed.length])).toEqual([
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ]);
      expect(updates[1]!.changed[0]).toBe(item);
      expect(item.startTime).toBe(50);
    });

    it('refuses a duplicate id and an unknown id', () => {
      const { host } = setup();

      host.addInterstitial(region('a', 30, 10));

      expect(() => host.addInterstitial(region('a', 40, 10))).toThrow(/already exists/);
      expect(() => host.resolve('missing', [])).toThrow(/Unknown interstitial/);
    });

    it('resolves slots, deriving the duration when the region had none', () => {
      const { host, session } = setup();
      const item = host.addInterstitial({ id: 'a', startTime: 30 });

      expect(item.resolution).toBe('unresolved');

      host.markResolving('a');
      expect(item.resolution).toBe('resolving');

      host.resolve('a', slots(2, 15), [record('podStart')]);

      expect(item.resolution).toBe('resolved');
      expect(item.duration).toBe(30);
      expect(item.slots.map((slot) => [slot.id, slot.index])).toEqual([
        ['a:0', 0],
        ['a:1', 1],
      ]);
      expect(item.tracking).toHaveLength(1);
      expect(session.schedule.getById('a')).toBe(item);
    });

    it('marks an empty resolution and reports a failed one', () => {
      const { host, session } = setup();
      const log = recordEvents(session, ['interstitialerror', 'tracking']);

      host.addInterstitial(region('empty', 30, 10));
      host.resolve('empty', []);
      host.addInterstitial(region('failed', 60, 10, { tracking: [record('error')] }));
      host.failResolution('failed', new Error('nope'));

      expect(session.schedule.getById('empty')?.resolution).toBe('empty');
      expect(session.schedule.getById('failed')?.resolution).toBe('error');
      expect(log).toEqual(['interstitialerror(failed)', 'tracking(failed):error']);
    });
  });

  describe('clock', () => {
    it('activates a region when the playhead enters it and completes it at its end', () => {
      const { host, media, session } = setup();
      const log = recordEvents(session, ['interstitialstart', 'interstitialend', 'tracking']);
      const item = host.addInterstitial(region('a', 10, 10, { tracking: [record('podStart'), record('podEnd')] }));

      media.advance(9);
      expect(item.state).toBe('scheduled');
      expect(session.schedule.current).toBeNull();

      media.advance(12);
      expect(item.state).toBe('active');
      expect(session.schedule.current).toBe(item);
      expect(item.currentTime).toBe(2);
      expect(item.remainingTime).toBe(8);

      media.advance(20);
      expect(item.state).toBe('completed');
      expect(item.played).toBe(true);
      expect(session.schedule.current).toBeNull();
      expect(log).toEqual([
        'interstitialstart(a)',
        'tracking(a):podStart',
        'interstitialend(a):completed',
        'tracking(a):podEnd',
      ]);
    });

    it('reports firstPlay false when a region plays again', () => {
      const { host, media, session } = setup();
      const starts: boolean[] = [];

      session.addEventListener('interstitialstart', (event) => starts.push(event.detail.firstPlay));
      host.addInterstitial(region('a', 10, 10));

      media.advance(20);
      media.seek(5);
      media.advance(20);

      expect(starts).toEqual([true, false]);
    });

    it('walks the slots of an active region and fires their records in order', () => {
      const { host, media, session } = setup();
      const log = recordEvents(session, ['slotstart', 'slotend', 'tracking', 'slotprogress']);

      host.addInterstitial(region('a', 10, 20));
      host.resolve(
        'a',
        slots(2, 10, {
          tracking: [
            record('loaded'),
            record('start'),
            record('impression'),
            record('complete'),
            record('progress', 2),
          ],
        })
      );

      media.advance(30);

      expect(log).toEqual([
        'slotstart(a:0)',
        'tracking(a:0):loaded',
        'tracking(a:0):start',
        'tracking(a:0):impression',
        'tracking(a:0):progress',
        'slotprogress(a:0)',
        'slotprogress(a:0)',
        'slotprogress(a:0)',
        'slotprogress(a:0)',
        'slotend(a:0):completed',
        'tracking(a:0):complete',
        'slotstart(a:1)',
        'tracking(a:1):loaded',
        'tracking(a:1):start',
        'tracking(a:1):impression',
        'tracking(a:1):progress',
        'slotprogress(a:1)',
        'slotprogress(a:1)',
        'slotprogress(a:1)',
        'slotprogress(a:1)',
        'slotend(a:1):completed',
        'tracking(a:1):complete',
      ]);
    });

    it('reports quartiles through slotprogress with their fraction', () => {
      const { host, media, session } = setup();
      const progress: [number, number][] = [];

      session.addEventListener('slotprogress', (event) => progress.push([event.detail.offset, event.detail.fraction]));
      host.addInterstitial(region('a', 0, 8));
      host.resolve('a', slots(1, 8, { tracking: [record('midpoint')] }));

      media.advance(8);

      expect(progress).toEqual([
        [2, 0.25],
        [4, 0.5],
        [6, 0.75],
      ]);
    });

    it('does not fire offset records across a seek into a slot', () => {
      const { host, media, session } = setup();
      const log = recordEvents(session, ['tracking', 'slotprogress']);

      host.addInterstitial(region('a', 10, 10));
      host.resolve('a', slots(1, 10, { tracking: [record('progress', 2), record('start')] }));

      media.seek(15);

      expect(log).toEqual(['tracking(a:0):start']);

      media.advance(20);
      expect(log.filter((entry) => entry.startsWith('tracking'))).toEqual(['tracking(a:0):start']);
    });

    it('ends a region left by a seek as seeked, without marking it played', () => {
      const { host, media, session } = setup();
      const log = recordEvents(session, ['interstitialend', 'slotend']);
      const item = host.addInterstitial(region('a', 10, 10));

      host.resolve('a', slots(1, 10));
      media.advance(12);
      media.seek(40);

      expect(item.state).toBe('skipped');
      expect(item.played).toBe(false);
      expect(item.slots[0]!.state).toBe('skipped');
      expect(log).toEqual(['slotend(a:0):seeked', 'interstitialend(a):seeked']);
    });

    it('ends a region at its playout limit', () => {
      const { host, media } = setup();
      const item = host.addInterstitial(region('a', 10, 20, { playoutLimit: 5 }));

      media.advance(16);

      expect(item.state).toBe('completed');
      expect(item.played).toBe(true);
    });

    it('drops a playOnce region from the schedule once it completes', () => {
      const { host, media, session } = setup();

      host.addInterstitial(region('a', 10, 10, { playOnce: true }));
      media.advance(25);

      expect(session.schedule.items).toHaveLength(0);
    });

    it('keeps an unresolved region active until the next known region starts', () => {
      const { host, media, session } = setup();

      host.addInterstitial({ id: 'a', startTime: 10 });
      host.addInterstitial(region('b', 30, 5));

      media.advance(20);
      expect(session.schedule.current?.id).toBe('a');

      media.advance(31);
      expect(session.schedule.current?.id).toBe('b');
      expect(session.schedule.getById('a')?.state).toBe('completed');
    });

    it('fires pause, resume, mute and unmute records while a slot is active', () => {
      const { host, media, session } = setup();
      const log = recordEvents(session, ['tracking']);

      host.addInterstitial(region('a', 0, 10));
      host.resolve(
        'a',
        slots(1, 10, { tracking: [record('pause'), record('resume'), record('mute'), record('unmute')] })
      );

      // The slot is active only once the clock enters it, so these records fire after the region starts.
      media.advance(2);
      media.pause();
      media.play();
      media.setMuted(true);
      media.setMuted(false);

      expect(log).toEqual([
        'tracking(a:0):pause',
        'tracking(a:0):resume',
        'tracking(a:0):mute',
        'tracking(a:0):unmute',
      ]);
    });

    it('publishes both clocks on every tick', () => {
      const { host, media, session } = setup();
      const ticks: AdSessionEventMap['timeupdate'][] = [];

      session.addEventListener('timeupdate', (event) => ticks.push(event.detail));
      host.addInterstitial(region('a', 10, 10));
      host.resolve('a', slots(1, 10));

      media.jump(15);
      media.jump(25);

      expect(ticks.at(-2)).toMatchObject({ streamTime: 15, contentTime: 10, slot: { id: 'a:0' } });
      expect(ticks.at(-1)).toMatchObject({ streamTime: 25, contentTime: 15, interstitial: null, slot: null });
    });
  });

  describe('skipping', () => {
    it('exposes skippability from the skip control and ends the slot on skip', () => {
      const { host, media, session } = setup();
      const log = recordEvents(session, ['slotskipstatechange', 'slotskip', 'slotend', 'slotstart', 'tracking']);

      host.addInterstitial(region('a', 10, 20));
      host.resolve(
        'a',
        slots(2, 10, { skipControl: { offset: 5, duration: null, labelId: null }, tracking: [record('skip')] })
      );

      const [first, second] = session.schedule.getById('a')!.slots;

      media.advance(14);
      expect(first!.skippable).toBe(false);
      expect(() => first!.skip()).toThrow(/not skippable/);

      media.advance(15.5);
      expect(first!.skippable).toBe(true);

      first!.skip();
      media.settle();

      expect(media.currentTime).toBe(20);
      expect(first!.state).toBe('skipped');
      expect(second!.state).toBe('active');
      expect(log).toEqual([
        'slotstart(a:0)',
        'slotskipstatechange(a:0)',
        'slotskip(a:0)',
        'tracking(a:0):skip',
        'slotskipstatechange(a:0)',
        'slotend(a:0):skipped',
        'slotstart(a:1)',
      ]);
    });

    it('skipping the last slot ends the region as skipped and played', () => {
      const { host, media, session } = setup();
      const item = host.addInterstitial(region('a', 10, 10));

      host.resolve('a', slots(1, 10, { skipControl: { offset: 0, duration: null, labelId: null } }));
      media.advance(12);
      session.schedule.currentSlot!.skip();
      media.settle();

      expect(item.state).toBe('skipped');
      expect(item.played).toBe(true);
      expect(media.currentTime).toBe(20);
    });

    it('skips a whole stitched region by seeking to its end', () => {
      const { host, media } = setup();
      const item = host.addInterstitial(region('a', 10, 10));

      media.advance(12);
      item.skip();

      expect(media.currentTime).toBe(20);
      expect(item.state).toBe('skipped');
      expect(item.played).toBe(true);
    });

    it('honors the skip restriction and the active requirement', () => {
      const { host, media } = setup();
      const restricted = host.addInterstitial(region('a', 10, 10, { restrictions: ['skip'] }));
      const later = host.addInterstitial(region('b', 50, 10));

      host.resolve('a', slots(1, 10, { skipControl: { offset: 0, duration: null, labelId: null } }));
      media.advance(12);

      expect(() => restricted.skip()).toThrow(/restricts skipping/);
      expect(restricted.slots[0]!.skippable).toBe(false);
      expect(() => later.skip()).toThrow(/not active/);
    });

    it('reports clicks without navigating', () => {
      const { host, media, session } = setup();
      const log = recordEvents(session, ['slotclick', 'tracking']);

      host.addInterstitial(region('a', 0, 10));
      host.resolve(
        'a',
        slots(1, 10, { clickThrough: 'https://advertiser.example', tracking: [record('clickTracking')] })
      );
      media.advance(1);
      session.schedule.currentSlot!.click();
      session.schedule.currentSlot!.click();

      expect(log).toEqual([
        'slotclick(a:0)',
        'tracking(a:0):clickTracking',
        'slotclick(a:0)',
        'tracking(a:0):clickTracking',
      ]);
    });
  });

  describe('seeking', () => {
    it('redirects a seek across an unplayed jump region to its start, then snaps back', () => {
      const { host, media, session } = setup();
      const log = recordEvents(session, ['seekblocked', 'snapback', 'interstitialstart', 'interstitialend']);

      host.addInterstitial(region('a', 10, 10, { restrictions: ['jump'] }));

      expect(session.requestSeek(50)).toBe(10);
      expect(media.currentTime).toBe(10);
      media.settle();

      media.advance(20);
      media.settle();

      expect(media.currentTime).toBe(50);
      expect(log).toEqual(['seekblocked(a)', 'interstitialstart(a)', 'interstitialend(a):completed', 'snapback(a)']);
    });

    it('lets a seek over a played jump region through', () => {
      const { host, media, session } = setup();

      host.addInterstitial(region('a', 10, 10, { restrictions: ['jump'] }));
      media.advance(20);

      media.seek(0);
      expect(session.requestSeek(50)).toBe(50);
    });

    it('snaps a seek into the middle of an unplayed jump region to its start', () => {
      const { host, session } = setup();

      host.addInterstitial(region('a', 10, 10, { restrictions: ['jump'] }));

      expect(session.requestSeek(15)).toBe(10);
    });

    it('only advises when restrictions are not enforced', () => {
      const { host, media, session } = setup({ enforceRestrictions: false });
      const log = recordEvents(session, ['seekblocked', 'snapback']);

      host.addInterstitial(region('a', 10, 10, { restrictions: ['jump'] }));

      expect(session.requestSeek(50)).toBe(50);
      expect(media.currentTime).toBe(50);
      expect(log).toEqual(['seekblocked(a)']);
    });

    it('enforces a seek the session did not issue', () => {
      const { host, media, session } = setup();
      const log = recordEvents(session, ['seekblocked']);

      host.addInterstitial(region('a', 10, 10, { restrictions: ['jump'] }));
      media.advance(2);
      media.seek(50);

      expect(media.currentTime).toBe(10);
      expect(log).toEqual(['seekblocked(a)']);
    });

    it('ignores regions without the jump restriction', () => {
      const { host, session } = setup();

      host.addInterstitial(region('a', 10, 10));

      expect(session.requestSeek(50)).toBe(50);
    });
  });

  describe('time', () => {
    it('removes stitched durations from content time on VOD', () => {
      const { host, session } = setup({}, 100);

      host.addInterstitial(region('pre', 0, 10));
      host.addInterstitial(region('mid', 40, 20));

      const { time } = session;

      expect(time.contentTimeForStreamTime(5)).toBe(0);
      expect(time.contentTimeForStreamTime(10)).toBe(0);
      expect(time.contentTimeForStreamTime(25)).toBe(15);
      expect(time.contentTimeForStreamTime(50)).toBe(30);
      expect(time.contentTimeForStreamTime(70)).toBe(40);
      expect(time.contentDuration).toBe(70);

      expect(time.streamTimeForContentTime(0)).toBe(0);
      expect(time.streamTimeForContentTime(15)).toBe(25);
      expect(time.streamTimeForContentTime(30)).toBe(40);
      expect(time.streamTimeForContentTime(31)).toBe(61);
      expect(time.streamTimeForContentTime(70)).toBe(100);

      expect(time.contentSeekable.length).toBe(1);
      expect(time.contentSeekable.end(0)).toBe(70);
    });

    it('leaves inserted regions out of the content clock', () => {
      const { host, session } = setup({}, 100);

      host.addInterstitial(region('mid', 40, 20, { insertion: 'inserted' }));

      expect(session.time.contentTimeForStreamTime(70)).toBe(70);
      expect(session.time.contentDuration).toBe(100);
    });

    it('uses stream time as content time on live', () => {
      const { host, session } = setup({}, Number.POSITIVE_INFINITY);

      host.addInterstitial(region('mid', 40, 20));

      expect(session.time.contentTimeForStreamTime(70)).toBe(70);
      expect(session.time.contentDuration).toBeNull();
    });

    it('can be forced to a timeline mode', () => {
      const { host, session } = setup({ timeline: 'live' }, 100);

      host.addInterstitial(region('mid', 40, 20));

      expect(session.time.contentTimeForStreamTime(70)).toBe(70);
    });

    it('reports the integrated timeline as the primary one for stitched regions', () => {
      const { media, session } = setup({}, 100);

      media.jump(30);

      expect(session.time.integrated).toEqual({ currentTime: 30, duration: 100, seekableStart: 0, seekableEnd: 100 });
    });
  });

  describe('tracking', () => {
    it('hands due records to the beacon sender with their context', () => {
      const send = vi.fn();
      const { host, media, session } = setup({ beacons: { send } });
      const start = record('start');

      host.addInterstitial(region('a', 10, 10));
      host.resolve('a', slots(1, 10, { tracking: [start] }));
      media.advance(11);

      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]).toBe(start);

      const context = send.mock.calls[0]![1];

      expect(context.session).toBe(session);
      expect(context.slot?.id).toBe('a:0');
      expect(context.interstitial?.id).toBe('a');
      expect(context.placement).toBeNull();
      expect(context.firstPlay).toBe(true);
    });

    it('skips the sender when a listener cancels the tracking event', () => {
      const send = vi.fn();
      const { host, media, session } = setup({ beacons: { send } });

      session.addEventListener('tracking', (event) => event.preventDefault());
      host.addInterstitial(region('a', 10, 10));
      host.resolve('a', slots(1, 10, { tracking: [record('start')] }));
      media.advance(11);

      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('placements', () => {
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

    it('drives a timeline placement from the clock', () => {
      const { host, media, session } = setup();
      const log = recordEvents(session, [
        'placementscheduled',
        'placementactivating',
        'placementactive',
        'placementimpression',
        'placementdismissed',
        'tracking',
      ]);

      host.addPlacement({
        id: 'overlay',
        kind: 'overlay',
        trigger: 'timeline',
        startTime: 10,
        duration: 10,
        creative,
        tracking: [record('start'), record('impression'), record('complete')],
      });

      media.advance(12);
      expect(session.placements.active.map((placement) => placement.id)).toEqual(['overlay']);
      expect(session.placements.getById('overlay')?.currentTime).toBe(2);

      media.advance(21);
      expect(session.placements.active).toHaveLength(0);
      expect(session.placements.getById('overlay')?.dismissReason).toBe('completed');
      expect(log).toEqual([
        'placementscheduled(overlay)',
        'placementactivating(overlay)',
        'placementactive(overlay)',
        'tracking(overlay):start',
        'placementimpression(overlay)',
        'tracking(overlay):impression',
        'placementdismissed(overlay):completed',
        'tracking(overlay):complete',
      ]);
    });

    it('lets an adapter activate and the viewer dismiss a pause placement', () => {
      const { host, session } = setup();
      const log = recordEvents(session, ['placementactive', 'placementdismissed', 'placementclick']);

      host.addPlacement({ id: 'pause', kind: 'pause', trigger: 'userAction', creative });
      host.activatePlacement('pause');

      const placement = session.placements.getByKind('pause')[0]!;

      expect(placement.state).toBe('active');

      placement.click();
      placement.dismiss('viewerDismissed');

      expect(placement.state).toBe('completed');
      expect(placement.dismissReason).toBe('viewerDismissed');
      expect(log).toEqual([
        'placementactive(pause)',
        'placementclick(pause)',
        'placementdismissed(pause):viewerDismissed',
      ]);
    });

    it('holds the transitional states for the layout transition', () => {
      vi.useFakeTimers();

      try {
        const { host, session } = setup();

        host.addPlacement({
          id: 'squeeze',
          kind: 'squeezeback',
          trigger: 'programmatic',
          creative,
          layout: { adViewport: null, contentViewport: null, transitionDuration: 500 },
        });
        host.activatePlacement('squeeze');

        const placement = session.placements.getById('squeeze')!;

        expect(placement.state).toBe('activating');
        vi.advanceTimersByTime(500);
        expect(placement.state).toBe('active');

        host.deactivatePlacement('squeeze', 'completed');
        expect(placement.state).toBe('deactivating');
        vi.advanceTimersByTime(500);
        expect(placement.state).toBe('completed');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('lifecycle', () => {
    it('attaches and detaches adapters with the host', () => {
      const media = new FakeMedia();
      const session = createAdSession({ primaryElement: media.asElement() });
      const adapter = createHostAdapter();
      const detach = vi.spyOn(adapter, 'detach');

      session.attachAdapter(adapter);
      session.attachAdapter(adapter);

      expect(session.adapters).toEqual([adapter]);
      expect(adapter.host.session).toBe(session);

      session.detachAdapter(adapter);
      expect(session.adapters).toEqual([]);
      expect(detach).toHaveBeenCalledTimes(1);
    });

    it('stops following the clock once destroyed', () => {
      const { host, media, session, adapter } = setup();
      const detach = vi.spyOn(adapter, 'detach');
      const item = host.addInterstitial(region('a', 10, 10));

      session.destroy();
      media.advance(15);

      expect(item.state).toBe('scheduled');
      expect(session.adapters).toEqual([]);
      expect(detach).toHaveBeenCalledTimes(1);
    });

    it('closes the active region when the source is emptied', () => {
      const { host, media, session } = setup();
      const item = host.addInterstitial(region('a', 10, 10));

      media.advance(12);
      media.dispatchEvent(new Event('emptied'));

      expect(item.state).toBe('skipped');
      expect(session.schedule.current).toBeNull();
    });
  });

  describe('insertion modes', () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('schedules inserted regions but warns that it cannot drive them without an interstitial player', () => {
      const { host } = setup();

      host.addInterstitial(region('a', 10, 10, { insertion: 'inserted' }));
      host.addInterstitial(region('b', 40, 10, { insertion: 'replaced' }));

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/interstitialPlayer/);
    });
  });
});
