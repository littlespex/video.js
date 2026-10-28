import { listen } from '@videojs/utils/dom';

import type { AdAdapter, AdapterHost, InterstitialPlayer } from './adapter';
import type { BeaconSender, TrackingContext } from './beacons';
import type { DismissReason, InterstitialEndReason, SlotEndReason, TrackingEventType } from './enums';
import type { AdSessionEventMap, AdSessionEventType } from './events';
import {
  type Interstitial,
  type InterstitialHooks,
  InterstitialImpl,
  type InterstitialPatch,
  interstitialData,
  type Slot,
  SlotImpl,
  type SlotInit,
  slotData,
} from './interstitial';
import { type AdPlacement, type PlacementImpl, PlacementsImpl } from './placement';
import type { TrackingEvent } from './records';
import { type InterstitialSchedule, ScheduleImpl } from './schedule';
import { createTimeMapping, type TimeMapping } from './time-mapping';

/**
 * The root object: one per primary stream. Created by the integrator, populated by adapters, read by UI and analytics.
 * The session owns the clock: it activates and deactivates regions as the playhead crosses their boundaries, the same
 * way a browser drives `VTTCue` enter and exit, and adapters never change playback state.
 *
 * @internal
 */
export interface AdSession extends EventTarget {
  /** The element playing primary content. For `stitched` regions it is also playing the ads. */
  readonly primaryElement: HTMLMediaElement;
  /** Plays `inserted` and `replaced` media. `null` in stitched-only integrations. */
  interstitialPlayer: InterstitialPlayer | null;
  readonly schedule: InterstitialSchedule;
  /** Always present; empty when no placement adapter is attached. */
  readonly placements: import('./placement').AdPlacements;
  readonly time: TimeMapping;
  /** Pluggable sender for `tracking` events. `null` means the integrator handles `tracking` events itself. */
  beacons: BeaconSender | null;
  readonly adapters: ReadonlyArray<AdAdapter>;

  attachAdapter(adapter: AdAdapter): void;
  /** Regions and placements the adapter created remain unless it removes them in `detach()`. */
  detachAdapter(adapter: AdAdapter): void;
  /**
   * Seek the primary element in stream time, applying the navigation rules: a seek across an unplayed `jump` region is
   * redirected to that region's start and completed after it plays. Returns the stream time actually sought.
   */
  requestSeek(streamTime: number): number;
  /** Detaches all adapters, stops timers, removes listeners. */
  destroy(): void;

  addEventListener<K extends AdSessionEventType>(
    type: K,
    listener: (event: CustomEvent<AdSessionEventMap[K]>) => void,
    options?: boolean | AddEventListenerOptions
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ): void;
  removeEventListener<K extends AdSessionEventType>(
    type: K,
    listener: (event: CustomEvent<AdSessionEventMap[K]>) => void,
    options?: boolean | EventListenerOptions
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ): void;
}

/** @internal */
export interface AdSessionInit {
  primaryElement: HTMLMediaElement;
  interstitialPlayer?: InterstitialPlayer | undefined;
  beacons?: BeaconSender | undefined;
  /**
   * Default `true`. When `false`, the session never blocks seeks; UI gets `seekblocked` only as a notification. Players
   * on platforms where the seek bar is owned by the OS use this mode and enforce in their own UI.
   */
  enforceRestrictions?: boolean | undefined;
  /**
   * Forces the time mapping. Default: detected from the primary element (`duration === Infinity` is live). Controls
   * whether content time removes stitched durations (`vod`) or equals stream time (`live`).
   */
  timeline?: 'vod' | 'live' | undefined;
}

/** A seek the session issued lands within this many seconds of its target. */
const SEEK_TOLERANCE = 0.5;

const QUARTILES: readonly number[] = [0.25, 0.5, 0.75];

const QUARTILE_TYPES: Partial<Record<TrackingEventType, number>> = {
  firstQuartile: 0.25,
  midpoint: 0.5,
  thirdQuartile: 0.75,
};

interface TrackingTarget {
  interstitial?: Interstitial | null;
  slot?: Slot | null;
  placement?: AdPlacement | null;
  firstPlay?: boolean;
}

function isCompletion(reason: InterstitialEndReason): boolean {
  return reason === 'completed' || reason === 'playoutLimit';
}

/**
 * Create an ad session on a primary media element.
 *
 * @internal
 */
export function createAdSession(init: AdSessionInit): AdSession {
  return new AdSessionImpl(init);
}

class AdSessionImpl extends EventTarget implements AdSession, InterstitialHooks {
  readonly primaryElement: HTMLMediaElement;
  interstitialPlayer: InterstitialPlayer | null;
  beacons: BeaconSender | null;
  readonly schedule: ScheduleImpl;
  readonly placements: PlacementsImpl;
  readonly time: TimeMapping;

  readonly #adapters: AdAdapter[] = [];
  readonly #enforce: boolean;
  readonly #forcedTimeline: 'vod' | 'live' | undefined;
  readonly #abort = new AbortController();
  readonly #host: AdapterHost;
  readonly #warned = new Set<string>();
  #order = 0;
  #stitchedCache: Interstitial[] | null = null;
  #lastStreamTime: number;
  /** The target of a seek this session issued, so the `seeking` it causes is not enforced a second time. */
  #expectedSeek: number | null = null;
  /** A viewer's seek target held back until the blocking region plays. */
  #deferredSeek: { interstitial: InterstitialImpl; to: number } | null = null;
  #snapback: { interstitial: Interstitial; to: number } | null = null;
  /** A region ended while the playhead stayed inside its span (playout limit), so it must not re-activate until left. */
  #endedInPlace: InterstitialImpl | null = null;
  /** Set between `seeking` and the first tick after it, which must not treat the jump as elapsed playback. */
  #seekPending = false;
  #destroyed = false;

  constructor(init: AdSessionInit) {
    super();
    this.primaryElement = init.primaryElement;
    this.interstitialPlayer = init.interstitialPlayer ?? null;
    this.beacons = init.beacons ?? null;
    this.#enforce = init.enforceRestrictions ?? true;
    this.#forcedTimeline = init.timeline;
    this.#lastStreamTime = init.primaryElement.currentTime;

    this.schedule = new ScheduleImpl(() => this.primaryElement.currentTime);
    this.placements = new PlacementsImpl({
      emit: (type, detail) => this.#emit(type, detail),
      fireTracking: (placement: PlacementImpl, event) => this.#fireTracking(event, { placement }),
    });
    this.time = createTimeMapping({
      primary: this.primaryElement,
      stitched: () => this.#stitched(),
      live: () => this.#isLive(),
    });
    this.#host = this.#createHost();

    this.#listen();
  }

  get adapters(): ReadonlyArray<AdAdapter> {
    return this.#adapters;
  }

  attachAdapter(adapter: AdAdapter): void {
    if (this.#adapters.includes(adapter)) return;

    this.#adapters.push(adapter);
    adapter.attach(this.#host);
  }

  detachAdapter(adapter: AdAdapter): void {
    const index = this.#adapters.indexOf(adapter);
    if (index < 0) return;

    this.#adapters.splice(index, 1);
    adapter.detach();
  }

  requestSeek(streamTime: number): number {
    if (this.#destroyed) return streamTime;

    const target = this.#enforceSeek(this.primaryElement.currentTime, streamTime);

    this.#issueSeek(target);

    return target;
  }

  destroy(): void {
    if (this.#destroyed) return;

    this.#destroyed = true;

    for (const adapter of [...this.#adapters]) this.detachAdapter(adapter);

    this.#abort.abort();
    this.placements.destroy();
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | ((event: never) => void) | null,
    options?: boolean | AddEventListenerOptions
  ): void {
    super.addEventListener(type, listener as EventListenerOrEventListenerObject | null, options);
  }

  override removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | ((event: never) => void) | null,
    options?: boolean | EventListenerOptions
  ): void {
    super.removeEventListener(type, listener as EventListenerOrEventListenerObject | null, options);
  }

  // ----------------------------------------
  // Interstitial hooks
  // ----------------------------------------

  update(interstitial: InterstitialImpl, patch: InterstitialPatch): void {
    const data = interstitialData(interstitial);

    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;

      if (key === 'restrictions') data.restrictions = new Set(value as Iterable<never>);
      else (data as unknown as Record<string, unknown>)[key] = value;
    }

    if ('startTime' in patch) this.schedule.sort();

    this.#scheduleChanged({ changed: [interstitial] });
  }

  skipInterstitial(interstitial: InterstitialImpl): void {
    const index = this.schedule.items.indexOf(interstitial);
    const end = this.schedule.effectiveEnd(index);
    if (!Number.isFinite(end)) throw new Error(`Interstitial "${interstitial.id}" has no known end to skip to`);

    this.#endInterstitial(interstitial, 'skipped');
    this.#issueSeek(end);
    this.#flushSnapback();
  }

  skipSlot(slot: SlotImpl): void {
    const { interstitial } = slot;
    const data = interstitialData(interstitial);
    const index = this.schedule.items.indexOf(interstitial);
    const firstPlay = !data.played;

    this.#emit('slotskip', { slot });
    this.#fireRecords(slot.tracking, 'skip', null, { slot, firstPlay });
    this.#endSlot(slot, 'skipped');

    const target = interstitial.startTime! + slot.start + slot.duration;

    // Skipping the last slot ends the region as a skip rather than leaving the seek to end it as a jump.
    if (target >= this.schedule.effectiveEnd(index)) this.#endInterstitial(interstitial, 'skipped');

    this.#issueSeek(target);
    this.#flushSnapback();
  }

  clickSlot(slot: SlotImpl): void {
    this.#emit('slotclick', { slot });
    this.#fireRecords(slot.tracking, 'clickTracking', null, {
      slot,
      firstPlay: !interstitialData(slot.interstitial).played,
    });
  }

  // ----------------------------------------
  // Host
  // ----------------------------------------

  #createHost(): AdapterHost {
    const require = (id: string): InterstitialImpl => {
      const item = this.schedule.getById(id);
      if (!item) throw new Error(`Unknown interstitial "${id}"`);

      return item;
    };

    const createSlots = (item: InterstitialImpl, inits: SlotInit[], offset: number) =>
      inits.map((init, index) => new SlotImpl(item, offset + index, init, this));

    const resolved = (item: InterstitialImpl) => {
      const data = interstitialData(item);

      if (data.duration === null && data.slots.length > 0) {
        data.duration = Math.max(...data.slots.map((slot) => slot.start + slot.duration));
      }

      data.resolution = data.slots.length > 0 ? 'resolved' : 'empty';
      this.#emit('interstitialresolved', { interstitial: item });
      this.#scheduleChanged({ changed: [item] });
    };

    return {
      session: this,

      addInterstitial: (init) => {
        if (this.schedule.has(init.id)) throw new Error(`Interstitial "${init.id}" already exists`);

        const item = new InterstitialImpl(init, this.#order++, this);

        if (__DEV__ && item.insertion !== 'stitched' && !this.interstitialPlayer && !this.#warned.has('inserted')) {
          this.#warned.add('inserted');
          console.warn(
            `[@videojs/ads] "${item.insertion}" regions need an interstitialPlayer, which this session does not drive yet; the region is scheduled and tracked but primary playback is not paused for it.`
          );
        }

        this.schedule.add(item);
        this.#scheduleChanged({ added: [item] });

        return item;
      },
      updateInterstitial: (id, patch) => this.update(require(id), patch),
      removeInterstitial: (id) => {
        const item = this.schedule.getById(id);
        if (!item) return;

        if (this.schedule.current === item) this.#endInterstitial(item, 'seeked');

        this.schedule.remove(item);
        this.#scheduleChanged({ removed: [item] });
      },
      resolve: (id, slots, podTracking) => {
        const item = require(id);
        const data = interstitialData(item);

        data.slots = createSlots(item, slots, 0);

        if (podTracking) data.tracking = podTracking;

        resolved(item);
      },
      markResolving: (id) => {
        interstitialData(require(id)).resolution = 'resolving';
      },
      failResolution: (id, error) => {
        const item = require(id);
        const data = interstitialData(item);

        data.resolution = 'error';
        this.#emit('interstitialerror', { interstitial: item, error });
        this.#fireRecords(item.tracking, 'error', null, { interstitial: item, firstPlay: !data.played });
      },
      appendSlots: (id, slots) => {
        const item = require(id);
        const data = interstitialData(item);

        data.slots = [...data.slots, ...createSlots(item, slots, data.slots.length)];
        resolved(item);
      },

      addPlacement: (init) => this.placements.add(init),
      updatePlacement: (id, patch) => this.placements.update(id, patch),
      removePlacement: (id) => this.placements.remove(id),
      activatePlacement: (id) => this.placements.activate(id),
      deactivatePlacement: (id, reason: DismissReason) => this.placements.deactivate(id, reason),
    };
  }

  #scheduleChanged(detail: Partial<AdSessionEventMap['scheduleupdated']>): void {
    this.#stitchedCache = null;
    this.#emit('scheduleupdated', { added: [], removed: [], changed: [], ...detail });
    this.#tick();
  }

  // ----------------------------------------
  // Clock
  // ----------------------------------------

  #listen(): void {
    const { signal } = this.#abort;
    const primary = this.primaryElement;
    const tick = () => this.#tick();

    listen(primary, 'timeupdate', tick, { signal });
    listen(primary, 'seeked', tick, { signal });
    listen(primary, 'ended', tick, { signal });
    listen(primary, 'durationchange', tick, { signal });
    listen(primary, 'loadedmetadata', tick, { signal });
    listen(primary, 'seeking', () => this.#onSeeking(), { signal });
    listen(primary, 'pause', () => !primary.ended && this.#fireSlotRecord('pause'), { signal });
    listen(primary, 'play', () => this.#fireSlotRecord('resume'), { signal });

    let muted = primary.muted;

    listen(
      primary,
      'volumechange',
      () => {
        if (primary.muted === muted) return;

        muted = primary.muted;
        this.#fireSlotRecord(muted ? 'mute' : 'unmute');
      },
      { signal }
    );

    // A new source brings its own signaling; nothing of the old schedule, its `played` flags included, carries over.
    listen(
      primary,
      'emptied',
      () => {
        const { current } = this.schedule;

        if (current) this.#endInterstitial(current, 'seeked');

        const removed = this.schedule.clear();

        this.#deferredSeek = null;
        this.#snapback = null;
        this.#endedInPlace = null;
        this.#lastStreamTime = 0;

        if (removed.length > 0) this.#scheduleChanged({ removed });
      },
      { signal }
    );
  }

  #onSeeking(): void {
    const to = this.primaryElement.currentTime;

    this.#seekPending = true;

    if (this.#expectedSeek !== null && Math.abs(to - this.#expectedSeek) <= SEEK_TOLERANCE) {
      this.#expectedSeek = null;
      return;
    }

    // A seek the session did not issue (native controls, the engine) is held to the same rules, after the fact.
    this.#expectedSeek = null;
    const target = this.#enforceSeek(this.#lastStreamTime, to);

    if (target !== to) this.#issueSeek(target);
  }

  #tick(): void {
    if (this.#destroyed) return;

    const streamTime = this.primaryElement.currentTime;
    const seeked = this.#seekPending;

    this.#seekPending = false;

    const { current } = this.schedule;

    if (current) {
      const data = interstitialData(current);
      const end = this.schedule.effectiveEnd(this.schedule.items.indexOf(current));
      const elapsed = streamTime - current.startTime!;

      if (data.playoutLimit !== null && elapsed >= data.playoutLimit) {
        // The playhead is still inside the span, so suppress a re-activation until it leaves.
        this.#endInterstitial(current, 'playoutLimit');
        this.#endedInPlace = current;
      } else if (streamTime < current.startTime! || streamTime >= end) {
        this.#endInterstitial(current, streamTime >= end && !seeked ? 'completed' : 'seeked');
      }
    }

    const region = this.schedule.findAt(streamTime);

    // A region that ended under its playout limit stays suppressed until the playhead moves out of its span.
    if (this.#endedInPlace && region !== this.#endedInPlace) this.#endedInPlace = null;

    if (region && region !== this.schedule.current && region !== this.#endedInPlace) {
      this.#startInterstitial(region);
    }

    const active = this.schedule.current;

    if (active) this.#tickInterstitial(active, streamTime, seeked);

    this.placements.tick(streamTime);
    this.#lastStreamTime = streamTime;

    this.#emit('timeupdate', {
      streamTime,
      contentTime: this.time.contentTime,
      interstitial: active,
      slot: active?.currentSlot ?? null,
    });

    this.#flushSnapback();
  }

  #startInterstitial(interstitial: InterstitialImpl): void {
    const data = interstitialData(interstitial);
    const firstPlay = !data.played;

    data.state = 'active';
    data.currentTime = 0;
    data.currentSlot = null;
    data.fired.clear();

    for (const slot of data.slots) {
      const slotState = slotData(slot);

      slotState.state = 'pending';
      slotState.currentTime = 0;
      slotState.skippable = false;
      slotState.fired.clear();
      slotState.progressFired.clear();
    }

    this.schedule.setCurrent(interstitial);
    this.#emit('interstitialstart', { interstitial, firstPlay });
    this.#fireRecords(interstitial.tracking, 'podStart', data.fired, { interstitial, firstPlay });
  }

  #tickInterstitial(interstitial: InterstitialImpl, streamTime: number, seeked: boolean): void {
    const data = interstitialData(interstitial);
    const regionTime = Math.max(0, streamTime - interstitial.startTime!);

    data.currentTime = regionTime;

    const slot = data.slots.find((item) => item.start <= regionTime && regionTime < item.start + item.duration) ?? null;

    if (slot !== data.currentSlot) {
      const previous = data.currentSlot;

      if (previous)
        this.#endSlot(previous, !seeked && regionTime >= previous.start + previous.duration ? 'completed' : 'seeked');

      if (slot) this.#startSlot(slot, !data.played);
    }

    if (slot) this.#tickSlot(slot, regionTime - slot.start, seeked);
  }

  #endInterstitial(interstitial: InterstitialImpl, reason: InterstitialEndReason): void {
    const data = interstitialData(interstitial);
    if (data.state !== 'active') return;

    const firstPlay = !data.played;

    if (data.currentSlot) {
      const slotReason: SlotEndReason =
        reason === 'completed'
          ? 'completed'
          : reason === 'error'
            ? 'error'
            : reason === 'seeked'
              ? 'seeked'
              : 'skipped';

      this.#endSlot(data.currentSlot, slotReason);
    }

    if (isCompletion(reason) && data.duration !== null) data.currentTime = data.duration;

    data.state = isCompletion(reason) ? 'completed' : reason === 'error' ? 'error' : 'skipped';

    if (reason !== 'seeked' && reason !== 'error') data.played = true;

    this.schedule.setCurrent(null);
    this.#emit('interstitialend', { interstitial, reason, firstPlay });

    if (isCompletion(reason))
      this.#fireRecords(interstitial.tracking, 'podEnd', data.fired, { interstitial, firstPlay });

    if (interstitial.playOnce && data.played) {
      this.schedule.remove(interstitial);
      this.#stitchedCache = null;
      this.#emit('scheduleupdated', { added: [], removed: [interstitial], changed: [] });
    }

    // Only the region that blocked the seek releases the held target; another region ending in between leaves it be.
    if (this.#deferredSeek?.interstitial === interstitial) {
      if (data.played) this.#snapback = { interstitial, to: this.#deferredSeek.to };

      this.#deferredSeek = null;
    }
  }

  #startSlot(slot: SlotImpl, firstPlay: boolean): void {
    const data = slotData(slot);

    data.state = 'active';
    data.currentTime = 0;
    data.skippable = false;
    data.fired.clear();
    data.progressFired.clear();
    interstitialData(slot.interstitial).currentSlot = slot;

    this.#emit('slotstart', { slot, firstPlay });

    for (const type of ['loaded', 'start', 'impression'] as const) {
      this.#fireRecords(slot.tracking, type, data.fired, { slot, firstPlay });
    }
  }

  #tickSlot(slot: SlotImpl, slotTime: number, seeked: boolean): void {
    const data = slotData(slot);
    const previous = data.currentTime;
    const current = Math.min(Math.max(0, slotTime), slot.duration);

    data.currentTime = current;

    // Offsets are due when continuous playback crosses them, never when a seek lands past them.
    if (!seeked) this.#fireDueOffsets(slot, previous, current);

    const skippable = this.#isSkippable(slot, current);

    if (skippable !== data.skippable) {
      data.skippable = skippable;
      this.#emit('slotskipstatechange', { slot, skippable });
    }
  }

  /** Fire the records whose offset playback crossed between `previous` and `current` seconds into the slot. */
  #fireDueOffsets(slot: SlotImpl, previous: number, current: number): void {
    if (current <= previous) return;

    const data = slotData(slot);
    const firstPlay = !interstitialData(slot.interstitial).played;
    const dueAt = (offset: number) => previous < offset && offset <= current;

    for (const event of slot.tracking) {
      const quartile = QUARTILE_TYPES[event.type];
      const offset = event.offset ?? (quartile === undefined ? null : quartile * slot.duration);
      if (offset === null || data.fired.has(event) || !dueAt(offset)) continue;

      data.fired.add(event);
      this.#fireTracking(event, { slot, firstPlay });

      if (event.type === 'progress' || quartile !== undefined) {
        const fraction = slot.duration > 0 ? offset / slot.duration : 0;

        data.progressFired.add(fraction);
        this.#emit('slotprogress', { slot, offset, fraction });
      }
    }

    // Quartile marks for UI even when the signaling carries no record there.
    for (const fraction of QUARTILES) {
      const offset = fraction * slot.duration;
      if (data.progressFired.has(fraction) || !dueAt(offset)) continue;

      data.progressFired.add(fraction);
      this.#emit('slotprogress', { slot, offset, fraction });
    }
  }

  #endSlot(slot: SlotImpl, reason: SlotEndReason): void {
    const data = slotData(slot);
    if (data.state !== 'active') return;

    const interstitial = interstitialData(slot.interstitial);
    const firstPlay = !interstitial.played;

    if (reason === 'completed') {
      // The clock ends a slot before ticking it, so offsets in the last window before its end fall due here.
      this.#fireDueOffsets(slot, data.currentTime, slot.duration);
      data.currentTime = slot.duration;
    }

    data.state = reason === 'completed' ? 'completed' : reason === 'error' ? 'error' : 'skipped';

    if (data.skippable) {
      data.skippable = false;
      this.#emit('slotskipstatechange', { slot, skippable: false });
    }

    if (interstitial.currentSlot === slot) interstitial.currentSlot = null;

    this.#emit('slotend', { slot, reason, firstPlay });

    if (reason === 'completed') this.#fireRecords(slot.tracking, 'complete', data.fired, { slot, firstPlay });
  }

  #isSkippable(slot: Slot, currentTime: number): boolean {
    const control = slot.skipControl;
    if (!control || slot.interstitial.restrictions.has('skip')) return false;

    if (currentTime < control.offset) return false;

    return control.duration === null || currentTime < control.offset + control.duration;
  }

  // ----------------------------------------
  // Seeking
  // ----------------------------------------

  /** The stream time a seek from `from` to `to` may land on under the navigation rules. */
  #enforceSeek(from: number, to: number): number {
    const { current } = this.schedule;

    // `skip` keeps the viewer from ending an active break early: a forward seek inside it goes nowhere.
    if (current && !current.played && current.restrictions.has('skip') && to > from) {
      this.#emit('seekblocked', { interstitial: current, from, to });

      if (!this.#enforce) return to;

      if (this.#liesPast(current, to)) this.#deferredSeek = { interstitial: current, to };

      return from;
    }

    // A target exactly at a break's start is a seek into it, which lands there anyway.
    const blocking = this.schedule
      .unplayedBetween(from, to)
      .find((item) => item.restrictions.has('jump') && item.startTime !== null && item.startTime < to);

    if (blocking) {
      this.#emit('seekblocked', { interstitial: blocking, from, to });

      if (!this.#enforce) return to;

      // A target inside the break has nowhere further to go once the break plays; only a target past it is held.
      if (this.#liesPast(blocking, to)) this.#deferredSeek = { interstitial: blocking, to };

      return blocking.startTime!;
    }

    const landing = this.schedule.findAt(to);

    if (
      this.#enforce &&
      landing &&
      landing.insertion === 'stitched' &&
      landing.restrictions.has('jump') &&
      !landing.played &&
      landing.startTime !== null &&
      to > landing.startTime
    ) {
      return landing.startTime;
    }

    return to;
  }

  #issueSeek(streamTime: number): void {
    this.#expectedSeek = streamTime;
    this.primaryElement.currentTime = streamTime;
  }

  /** Whether `streamTime` lies beyond the span a region occupies on the primary timeline. */
  #liesPast(region: InterstitialImpl, streamTime: number): boolean {
    const end =
      region.insertion === 'stitched'
        ? this.schedule.effectiveEnd(this.schedule.items.indexOf(region))
        : region.startTime!;

    return streamTime >= end;
  }

  #flushSnapback(): void {
    const snapback = this.#snapback;
    if (!snapback) return;

    this.#snapback = null;

    const { current } = this.schedule;

    // A restricted break that starts where the last one ended takes over the hold instead of being jumped.
    if (
      this.#enforce &&
      current &&
      !current.played &&
      (current.restrictions.has('jump') || current.restrictions.has('skip'))
    ) {
      if (this.#liesPast(current, snapback.to)) this.#deferredSeek = { interstitial: current, to: snapback.to };

      return;
    }

    this.#emit('snapback', {
      interstitial: snapback.interstitial,
      from: this.primaryElement.currentTime,
      to: snapback.to,
    });
    this.requestSeek(snapback.to);
  }

  // ----------------------------------------
  // Tracking
  // ----------------------------------------

  #fireRecords(
    records: readonly TrackingEvent[],
    type: TrackingEventType,
    fired: Set<TrackingEvent> | null,
    target: TrackingTarget
  ): void {
    for (const event of records) {
      if (event.type !== type || fired?.has(event)) continue;

      fired?.add(event);
      this.#fireTracking(event, target);
    }
  }

  #fireSlotRecord(type: TrackingEventType): void {
    const slot = this.schedule.currentSlot;
    if (!slot) return;

    this.#fireRecords(slot.tracking, type, null, { slot, firstPlay: !interstitialData(slot.interstitial).played });
  }

  #fireTracking(event: TrackingEvent, target: TrackingTarget): void {
    const interstitial = target.slot?.interstitial ?? target.interstitial ?? null;
    const context: TrackingContext = {
      session: this,
      interstitial,
      slot: target.slot ?? null,
      placement: target.placement ?? null,
      streamTime: this.primaryElement.currentTime,
      contentTime: this.time.contentTime,
      firstPlay: target.firstPlay ?? (interstitial ? !interstitial.played : true),
    };
    const dispatched = new CustomEvent<AdSessionEventMap['tracking']>('tracking', {
      detail: { event, context },
      cancelable: true,
    });

    this.dispatchEvent(dispatched);

    if (!dispatched.defaultPrevented) this.beacons?.send(event, context);
  }

  // ----------------------------------------
  // Helpers
  // ----------------------------------------

  #emit<K extends AdSessionEventType>(type: K, detail: AdSessionEventMap[K]): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  #stitched(): Interstitial[] {
    return (this.#stitchedCache ??= this.schedule.items.filter(
      (item) => item.insertion === 'stitched' && item.startTime !== null
    ));
  }

  #isLive(): boolean {
    if (this.#forcedTimeline) return this.#forcedTimeline === 'live';

    return this.primaryElement.duration === Number.POSITIVE_INFINITY;
  }
}
