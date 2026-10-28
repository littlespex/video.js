import { listen } from '@videojs/utils/dom';
import { isNumber, isString } from '@videojs/utils/predicate';

import type { AdAdapter, AdapterHost } from '../adapter';
import type { CuePosition, InsertionMode, NavigationRestriction } from '../enums';
import type { InterstitialInit, SlotInit } from '../interstitial';
import {
  decodeEnvelope,
  podOf,
  type SvtaEnvelope,
  type SvtaPod,
  SVTA_ATTRIBUTE,
  slotsOf,
  toSlotInit,
  toTrackingEvent,
} from './envelope';
import {
  type DateRangeCueGroup,
  findMetadataTrack,
  groupDateRangeCues,
  hasSvtaSignal,
  type MetadataTrackHost,
  type MetadataTrackLike,
} from './metadata-track';

/**
 * How the adapter fetches a `$remote` payload. Defaults to a JSON `fetch`. The signal aborts when the adapter detaches.
 *
 * @internal
 */
export type RemoteFetch = (url: string, signal: AbortSignal) => Promise<unknown>;

/** @internal */
export interface SvtaAdapterOptions {
  /**
   * How the signaled media reaches the viewer. SVTA is silent on insertion mode; the carriage decides it, and these
   * regions arrive on the primary playlist, so the default is `stitched`.
   */
  insertion?: InsertionMode | undefined;
  /**
   * Navigation restrictions applied to a region whose date range carries no `X-RESTRICT`. Defaults to `['jump']`, so a
   * viewer cannot seek past an unplayed break.
   */
  restrictions?: Iterable<NavigationRestriction> | undefined;
  /** Fetches a `$remote` slot or tracking payload. Defaults to a JSON `fetch`. */
  fetch?: RemoteFetch | undefined;
}

async function fetchJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`SVTA $remote fetch failed: ${response.status} ${url}`);

  return response.json();
}

/** Primary element events after which hls.js may have appended date-range cues without a `cuechange`. */
const RESCAN_EVENTS = ['loadedmetadata', 'durationchange', 'progress'] as const;

/** Session events after which a deferred `$remote` region may have become the current or the next one. */
const FETCH_EVENTS = ['timeupdate', 'scheduleupdated', 'interstitialstart'] as const;

const RESTRICTION_TOKENS: Record<string, NavigationRestriction> = { SKIP: 'skip', JUMP: 'jump' };

/**
 * The reference adapter. Reads the SVTA2053 Ad Creative Signaling scheme from `EXT-X-DATERANGE` tags that the primary
 * element's `metadata` text track carries, and populates the session's schedule with stitched interstitials. Reading
 * cues rather than engine events is what lets one adapter serve native and hls.js playback without branching.
 *
 * A region's `$remote` slots load when the region is next up or starts, as the RFC and SVTA call for, so a stitcher can
 * decide creatives late. Date ranges that leave the track (a live window rolling past them, a source change) take their
 * regions with them.
 *
 * @internal
 */
export class SvtaAdapter implements AdAdapter {
  readonly name = 'svta';

  readonly #insertion: InsertionMode;
  readonly #restrictions: NavigationRestriction[];
  readonly #fetch: RemoteFetch;
  /** Ids of the regions this adapter added, so it removes only its own. */
  readonly #known = new Set<string>();
  /** Regions whose `$remote` slots wait for the region to come up. */
  readonly #pending = new Map<string, SvtaPod>();
  readonly #resolving = new Set<string>();
  /** Regions whose duration the pod declared, which a later cue span does not override. */
  readonly #podDurations = new Set<string>();
  readonly #warned = new Set<string>();

  #host: AdapterHost | null = null;
  #abort: AbortController | null = null;
  #track: MetadataTrackLike | null = null;
  #onCueChange: (() => void) | null = null;
  #onAddTrack: (() => void) | null = null;

  constructor(options: SvtaAdapterOptions = {}) {
    this.#insertion = options.insertion ?? 'stitched';
    this.#restrictions = [...(options.restrictions ?? ['jump'])];
    this.#fetch = options.fetch ?? fetchJson;
  }

  attach(host: AdapterHost): void {
    const abort = new AbortController();
    const { signal } = abort;
    const { session } = host;
    const element = session.primaryElement;
    const tracks = (element as unknown as MetadataTrackHost).textTracks;

    this.#host = host;
    this.#abort = abort;
    this.#onAddTrack = () => this.#bindTrack();
    tracks?.addEventListener?.('addtrack', this.#onAddTrack);

    for (const type of RESCAN_EVENTS) listen(element, type, () => this.#scan(), { signal });

    for (const type of FETCH_EVENTS) session.addEventListener(type, () => this.#fetchDue(), { signal });

    this.#bindTrack();
  }

  detach(): void {
    const element = this.#host?.session.primaryElement as unknown as MetadataTrackHost | undefined;

    if (this.#onAddTrack) element?.textTracks?.removeEventListener?.('addtrack', this.#onAddTrack);

    this.#unbindTrack();
    this.#abort?.abort();
    this.#abort = null;
    this.#onAddTrack = null;
    this.#host = null;
    this.#known.clear();
    this.#pending.clear();
    this.#resolving.clear();
    this.#podDurations.clear();
  }

  /** Re-scan the current cues. Exposed so an engine without `cuechange` can drive the adapter by hand. */
  scan(): void {
    this.#scan();
  }

  #bindTrack(): void {
    const host = this.#host;
    if (!host) return;

    const track = findMetadataTrack(host.session.primaryElement as unknown as MetadataTrackHost);

    if (track === this.#track) {
      this.#scan();
      return;
    }

    this.#unbindTrack();
    this.#track = track;

    if (!track) return;

    // A disabled track exposes no cues; hidden keeps them readable without rendering anything.
    if (track.mode === 'disabled') track.mode = 'hidden';

    this.#onCueChange = () => this.#scan();
    track.addEventListener('cuechange', this.#onCueChange);
    this.#scan();
  }

  #unbindTrack(): void {
    if (this.#track && this.#onCueChange) this.#track.removeEventListener('cuechange', this.#onCueChange);

    this.#track = null;
    this.#onCueChange = null;
  }

  #scan(): void {
    const host = this.#host;
    const track = this.#track;
    if (!host || !track?.cues) return;

    const cues = Array.from({ length: track.cues.length }, (_, index) => track.cues![index]!);
    const seen = new Set<string>();

    for (const group of groupDateRangeCues(cues)) {
      if (!hasSvtaSignal(group)) continue;

      const envelope = decodeEnvelope(group.attributes[SVTA_ATTRIBUTE]);

      if (!envelope) {
        this.#warnOnce(group.id, `date range "${group.id}" carries an X-AD-CREATIVE-SIGNALING value it cannot decode`);
        continue;
      }

      seen.add(group.id);

      if (host.session.schedule.getById(group.id)) {
        this.#refine(host, group);
        continue;
      }

      this.#addRegion(host, group, envelope);
    }

    // A date range that left the track takes its region along, unless that region is the one playing.
    for (const id of this.#known) {
      if (seen.has(id)) continue;

      const region = host.session.schedule.getById(id);
      if (region?.state === 'active') continue;

      if (region) host.removeInterstitial(id);

      this.#forget(id);
    }
  }

  #addRegion(host: AdapterHost, group: DateRangeCueGroup, envelope: SvtaEnvelope): void {
    const pod = podOf(envelope);
    const startTime = pod?.start ?? group.startTime;
    const span = Number.isFinite(group.endTime) ? group.endTime - group.startTime : null;
    const duration = pod?.duration ?? span;
    const playoutLimit = group.attributes['X-PLAYOUT-LIMIT'];

    this.#known.add(group.id);

    if (pod?.duration !== undefined) this.#podDurations.add(group.id);

    host.addInterstitial({
      id: group.id,
      kind: 'ad',
      insertion: this.#insertion,
      cue: cueOf(startTime),
      startTime,
      plannedDuration: duration,
      duration,
      playoutLimit: isNumber(playoutLimit)
        ? playoutLimit
        : isString(playoutLimit)
          ? Number(playoutLimit) || null
          : null,
      restrictions: parseRestrictions(group.attributes['X-RESTRICT']) ?? this.#restrictions,
      timelineOccupancy: 'range',
      timelineStyle: 'highlight',
      tracking: (pod?.tracking ?? []).map(toTrackingEvent),
      metadata: { svta: { attribute: SVTA_ATTRIBUTE, envelopeType: envelope.type } },
    } satisfies InterstitialInit);

    const inlineSlots = slotsOf(envelope);

    if (inlineSlots.length > 0) {
      host.resolve(group.id, inlineSlots.map(toSlotInit));
      return;
    }

    if (pod?.$remote?.slots) {
      this.#pending.set(group.id, pod);
      this.#fetchDue();
      return;
    }

    // A pod with neither inline nor remote slots resolves empty: the region exists for UI and restrictions.
    if (pod) host.resolve(group.id, []);
  }

  /** Start the `$remote` fetch for a pending region once it is the current or the next one. */
  #fetchDue(): void {
    const host = this.#host;
    if (!host || this.#pending.size === 0) return;

    const { schedule } = host.session;

    for (const region of [schedule.current, schedule.upcoming]) {
      const pod = region ? this.#pending.get(region.id) : undefined;

      if (region && pod) this.#resolveRemote(host, region.id, pod);
    }
  }

  #resolveRemote(host: AdapterHost, id: string, pod: SvtaPod): void {
    const signal = this.#abort?.signal;
    if (!signal || this.#resolving.has(id)) return;

    this.#pending.delete(id);
    this.#resolving.add(id);
    host.markResolving(id);

    // The region may be gone by the time the payload lands: a source change, or a live window that rolled past it.
    const stillScheduled = () => !signal.aborted && host.session.schedule.getById(id) !== null;

    void this.#fetch(pod.$remote!.slots!, signal)
      .then((payload) => {
        if (!stillScheduled()) return;

        const envelope = decodeEnvelope(payload);
        const slots: SlotInit[] = envelope ? slotsOf(envelope).map(toSlotInit) : [];

        host.resolve(id, slots);
      })
      .catch((error: unknown) => {
        if (!stillScheduled()) return;

        host.failResolution(id, error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => this.#resolving.delete(id));
  }

  /**
   * A stitched region's end drifts as later cues extend it; refine the duration while it is still scheduled. A duration
   * the pod declared stands.
   */
  #refine(host: AdapterHost, group: DateRangeCueGroup): void {
    if (this.#podDurations.has(group.id)) return;

    const region = host.session.schedule.getById(group.id);
    if (!region || region.state !== 'scheduled' || !Number.isFinite(group.endTime)) return;

    const duration = group.endTime - group.startTime;

    if (region.duration !== duration) host.updateInterstitial(group.id, { duration, plannedDuration: duration });
  }

  #forget(id: string): void {
    this.#known.delete(id);
    this.#pending.delete(id);
    this.#podDurations.delete(id);
  }

  #warnOnce(id: string, message: string): void {
    if (!__DEV__ || this.#warned.has(id)) return;

    this.#warned.add(id);
    console.warn(`[@videojs/ads] ${message}`);
  }
}

function cueOf(startTime: number | null): CuePosition {
  return startTime === null ? 'post' : startTime <= 0 ? 'pre' : 'mid';
}

/** The restrictions an HLS `X-RESTRICT` list names, or `null` when the attribute is absent. */
function parseRestrictions(value: unknown): NavigationRestriction[] | null {
  if (!isString(value)) return null;

  return value
    .split(',')
    .map((token) => RESTRICTION_TOKENS[token.trim().toUpperCase()])
    .filter((restriction): restriction is NavigationRestriction => restriction !== undefined);
}
