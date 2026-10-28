import type { DismissReason } from './enums';
import type { Interstitial, InterstitialInit, InterstitialPatch, Slot, SlotInit } from './interstitial';
import type { AdPlacement, PlacementInit, PlacementPatch } from './placement';
import type { TrackingEvent } from './records';
import type { AdSession } from './session';

/**
 * Reads a signaling source (SVTA date ranges, DASH events, an ad server response, an SDK) and populates the session
 * through the {@link AdapterHost}. Adapters never change playback state: the session's clock owns every `state`
 * transition, and the only adapter-side lifecycle verbs are resolution and placement activation.
 *
 * Multiple adapters may attach to one session: an SVTA adapter for stitched linear regions plus a pause-ad adapter for
 * placements is the expected pairing.
 *
 * @internal
 */
export interface AdAdapter {
  readonly name: string;
  attach(host: AdapterHost): void;
  detach(): void;
}

/**
 * How an adapter writes into a session.
 *
 * @internal
 */
export interface AdapterHost {
  readonly session: AdSession;

  // Schedule
  addInterstitial(init: InterstitialInit): Interstitial;
  updateInterstitial(id: string, patch: InterstitialPatch): void;
  removeInterstitial(id: string): void;
  /** Populate a region's slots. `duration` follows the slots when it was unknown. */
  resolve(id: string, slots: SlotInit[], podTracking?: TrackingEvent[]): void;
  markResolving(id: string): void;
  failResolution(id: string, error: Error): void;
  /** For stitched streams whose signaling only provides slot records: attaches slots to an existing region. */
  appendSlots(id: string, slots: SlotInit[]): void;

  // Placements
  addPlacement(init: PlacementInit): AdPlacement;
  updatePlacement(id: string, patch: PlacementPatch): void;
  removePlacement(id: string): void;
  activatePlacement(id: string): void;
  deactivatePlacement(id: string, reason: DismissReason): void;
}

/**
 * The contract the session uses to play `inserted` and `replaced` media. Implementations are integrator-provided; a
 * reference implementation uses a second `HTMLMediaElement`. Dispatches `timeupdate`, `ended`, `error` and `canplay` as
 * `CustomEvent`s.
 *
 * @internal
 */
export interface InterstitialPlayer extends EventTarget {
  /** Prepare the first slot's media. May be called before the region starts for preloading. */
  load(interstitial: Interstitial, slot: Slot): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  /** Advance to the given slot (used by skip and by seeks within the region). */
  seekToSlot(slot: Slot, offsetWithinSlot: number): void;
  /** Seconds within the current slot. */
  readonly currentTime: number;
  readonly element: HTMLMediaElement | null;
}
