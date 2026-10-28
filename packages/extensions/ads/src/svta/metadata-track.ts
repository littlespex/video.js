import { SVTA_ATTRIBUTE } from './envelope';

/**
 * One `EXT-X-DATERANGE` reassembled from the cues a `metadata` text track carries for it. hls.js and Safari surface a
 * date range as one metadata cue per attribute, each sharing the range's `id`; this gathers them back into the
 * attribute map, timing and span the adapter reads.
 *
 * @experimental
 */
export interface DateRangeCueGroup {
  id: string;
  startTime: number;
  endTime: number;
  attributes: Record<string, unknown>;
}

/** A text cue as a metadata track exposes it, narrowed to the fields this adapter reads. */
interface MetadataCueLike {
  readonly id?: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly value?: unknown;
  readonly text?: string;
}

/**
 * Pull the attribute `key`/`data` pair out of a metadata cue. hls.js and Safari set `cue.value = { key, data }`; a cue
 * whose `value` is the whole attribute object (or whose JSON text is) is merged under the one attribute name this
 * adapter needs.
 */
function readAttributes(cue: MetadataCueLike): Record<string, unknown> {
  const value = cue.value;

  if (value && typeof value === 'object') {
    const pair = value as { key?: unknown; data?: unknown };
    if (typeof pair.key === 'string') return { [pair.key]: pair.data };

    return { ...(value as Record<string, unknown>) };
  }

  if (cue.text) {
    try {
      const parsed = JSON.parse(cue.text) as unknown;

      if (parsed && typeof parsed === 'object') {
        const pair = parsed as { key?: unknown; data?: unknown };
        if (typeof pair.key === 'string') return { [pair.key]: pair.data };

        return parsed as Record<string, unknown>;
      }
    } catch {
      // A non-JSON metadata cue carries no attributes this adapter can read.
    }
  }

  return {};
}

/** Group a metadata track's cues by date-range id, keeping the earliest start and latest finite end. */
export function groupDateRangeCues(cues: Iterable<MetadataCueLike>): DateRangeCueGroup[] {
  const groups = new Map<string, DateRangeCueGroup>();

  for (const cue of cues) {
    if (!cue.id) continue;

    const group = groups.get(cue.id) ?? {
      id: cue.id,
      startTime: cue.startTime,
      endTime: cue.endTime,
      attributes: {},
    };

    group.startTime = Math.min(group.startTime, cue.startTime);

    if (Number.isFinite(cue.endTime)) {
      group.endTime = Number.isFinite(group.endTime) ? Math.max(group.endTime, cue.endTime) : cue.endTime;
    }

    Object.assign(group.attributes, readAttributes(cue));
    groups.set(cue.id, group);
  }

  return [...groups.values()];
}

/** Whether a reassembled date range carries the SVTA Ad Creative Signaling attribute. */
export function hasSvtaSignal(group: DateRangeCueGroup): boolean {
  return SVTA_ATTRIBUTE in group.attributes;
}

/** A text track as this adapter consumes it: metadata cues plus a `cuechange` notification. */
export interface MetadataTrackLike extends EventTarget {
  readonly kind?: string;
  readonly cues: ArrayLike<MetadataCueLike> | null;
}

/** A host from which a metadata track can be found, such as the primary media element. */
export interface MetadataTrackHost {
  readonly textTracks?: {
    readonly length: number;
    readonly [index: number]: MetadataTrackLike;
    addEventListener?(type: 'addtrack' | 'change' | 'removetrack', listener: () => void): void;
    removeEventListener?(type: 'addtrack' | 'change' | 'removetrack', listener: () => void): void;
  } & Partial<EventTarget>;
}

/** The first `metadata` text track on a host, or `null`. */
export function findMetadataTrack(host: MetadataTrackHost): MetadataTrackLike | null {
  const tracks = host.textTracks;
  if (!tracks) return null;

  for (let index = 0; index < tracks.length; index++) {
    const track = tracks[index];
    if (track && track.kind === 'metadata') return track;
  }

  return null;
}
