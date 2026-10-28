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
 * How the adapter fetches a `$remote` payload. Defaults to a JSON `fetch`.
 *
 * @experimental
 */
export type RemoteFetch = (url: string) => Promise<unknown>;

/** @experimental */
export interface SvtaAdapterOptions {
  /**
   * How the signaled media reaches the viewer. SVTA is silent on insertion mode; the carriage decides it, and these
   * regions arrive on the primary playlist, so the default is `stitched`.
   */
  insertion?: InsertionMode | undefined;
  /**
   * Navigation restrictions applied to every region. Defaults to `['jump']`, so a viewer cannot seek past an unplayed
   * break.
   */
  restrictions?: Iterable<NavigationRestriction> | undefined;
  /** Fetches a `$remote` slot or tracking payload. Defaults to a JSON `fetch`. */
  fetch?: RemoteFetch | undefined;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`SVTA $remote fetch failed: ${response.status} ${url}`);

  return response.json();
}

/**
 * The reference adapter. Reads the SVTA2053 Ad Creative Signaling scheme from `EXT-X-DATERANGE` tags that the primary
 * element's `metadata` text track carries, and populates the session's schedule with stitched interstitials. Reading
 * cues rather than engine events is what lets one adapter serve native and hls.js playback without branching.
 *
 * @experimental
 */
export class SvtaAdapter implements AdAdapter {
  readonly name = 'svta';

  readonly #insertion: InsertionMode;
  readonly #restrictions: NavigationRestriction[];
  readonly #fetch: RemoteFetch;
  readonly #resolving = new Set<string>();

  #host: AdapterHost | null = null;
  #track: MetadataTrackLike | null = null;
  #onCueChange: (() => void) | null = null;
  #onAddTrack: (() => void) | null = null;

  constructor(options: SvtaAdapterOptions = {}) {
    this.#insertion = options.insertion ?? 'stitched';
    this.#restrictions = [...(options.restrictions ?? ['jump'])];
    this.#fetch = options.fetch ?? fetchJson;
  }

  attach(host: AdapterHost): void {
    this.#host = host;

    const element = host.session.primaryElement as unknown as MetadataTrackHost;
    const tracks = element.textTracks;

    this.#onAddTrack = () => this.#bindTrack();
    tracks?.addEventListener?.('addtrack', this.#onAddTrack);

    this.#bindTrack();
  }

  detach(): void {
    const element = this.#host?.session.primaryElement as unknown as MetadataTrackHost | undefined;

    if (this.#onAddTrack) element?.textTracks?.removeEventListener?.('addtrack', this.#onAddTrack);

    this.#unbindTrack();
    this.#onAddTrack = null;
    this.#host = null;
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

    if (track) {
      this.#onCueChange = () => this.#scan();
      track.addEventListener('cuechange', this.#onCueChange);
      this.#scan();
    }
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

    for (const group of groupDateRangeCues(cues)) {
      if (!hasSvtaSignal(group)) continue;

      const envelope = decodeEnvelope(group.attributes[SVTA_ATTRIBUTE]);
      if (!envelope) continue;

      if (host.session.schedule.getById(group.id)) {
        this.#refine(host, group);
        continue;
      }

      this.#addRegion(host, group, envelope);
    }
  }

  #addRegion(host: AdapterHost, group: DateRangeCueGroup, envelope: SvtaEnvelope): void {
    const pod = podOf(envelope);
    const startTime = pod?.start ?? group.startTime;
    const span = Number.isFinite(group.endTime) ? group.endTime - group.startTime : null;
    const duration = pod?.duration ?? span;

    host.addInterstitial({
      id: group.id,
      kind: 'ad',
      insertion: this.#insertion,
      cue: cueOf(startTime),
      startTime,
      plannedDuration: duration,
      duration,
      restrictions: this.#restrictions,
      timelineOccupancy: 'range',
      timelineStyle: 'highlight',
      tracking: (pod?.tracking ?? []).map(toTrackingEvent),
      metadata: { svta: { scheme: SVTA_ATTRIBUTE, envelopeType: envelope.type } },
    } satisfies InterstitialInit);

    const inlineSlots = slotsOf(envelope);

    if (inlineSlots.length > 0) {
      host.resolve(group.id, inlineSlots.map(toSlotInit));
      return;
    }

    if (pod?.$remote?.slots) {
      this.#resolveRemote(host, group.id, pod);
      return;
    }

    // A pod with neither inline nor remote slots resolves empty: the region exists for UI and restrictions.
    if (pod) host.resolve(group.id, []);
  }

  #resolveRemote(host: AdapterHost, id: string, pod: SvtaPod): void {
    if (this.#resolving.has(id)) return;

    this.#resolving.add(id);
    host.markResolving(id);

    void this.#fetch(pod.$remote!.slots!)
      .then((payload) => {
        const envelope = decodeEnvelope(payload);
        const slots: SlotInit[] = envelope ? slotsOf(envelope).map(toSlotInit) : [];

        host.resolve(id, slots);
      })
      .catch((error: unknown) => {
        host.failResolution(id, error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => this.#resolving.delete(id));
  }

  /** A stitched region's end drifts as later cues extend it; refine the duration while it is still scheduled. */
  #refine(host: AdapterHost, group: DateRangeCueGroup): void {
    const region = host.session.schedule.getById(group.id);
    if (!region || region.state !== 'scheduled' || !Number.isFinite(group.endTime)) return;

    const duration = group.endTime - group.startTime;

    if (region.duration !== duration) host.updateInterstitial(group.id, { duration, plannedDuration: duration });
  }
}

function cueOf(startTime: number | null): CuePosition {
  return startTime === null ? 'post' : startTime <= 0 ? 'pre' : 'mid';
}
