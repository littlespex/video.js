import type { AudioPolicy, DismissReason, PlacementKind, PlacementState, PlacementTrigger } from './enums';
import type { AdSessionEventMap } from './events';
import type { Slot } from './interstitial';
import type { AdIdentifier, MediaReference, TrackingEvent, Verification } from './records';

/**
 * Asset metadata for a placement creative.
 *
 * @experimental
 */
export interface PlacementCreative {
  media: MediaReference[];
  width: number;
  height: number;
  aspectRatio: string;
  fileSize: number | null;
  bitrate: number | null;
  codec: string | null;
  supportsTransparency: boolean;
  title: string | null;
  clickThrough: string | null;
}

/**
 * Percentage insets (0-100) from the player edges.
 *
 * @experimental
 */
export interface Viewport {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * Where the ad and the content render while a placement is active.
 *
 * @experimental
 */
export interface PlacementLayout {
  /** Where the creative renders. `null` for menu, in-scene and companion placements rendered outside the player. */
  adViewport: Viewport | null;
  /** Where content renders while the placement is active. Non-null only for squeezeback. */
  contentViewport: Viewport | null;
  /** Content resize or fade duration in milliseconds. `0` when there is no animation. */
  transitionDuration: number;
}

/** @experimental */
export interface QRCodeInfo {
  scanUrl: string;
  isDynamic: boolean;
  /** Position within the creative, as percentages of creative dimensions. */
  position: { x: number; y: number; width: number; height: number } | null;
}

/** @experimental */
export interface AdInteractivity {
  framework: 'simid' | 'custom' | null;
  simidUrl: string | null;
  qrCode: QRCodeInfo | null;
  supportsRemoteControl: boolean;
}

/**
 * An ad experience that is not an interstitial: a pause ad, overlay, squeezeback, menu tile, screensaver, in-scene
 * composite or companion. `timeline` placements follow the session's clock; every other trigger is adapter-driven.
 *
 * @experimental
 */
export interface AdPlacement {
  readonly id: string;
  readonly kind: PlacementKind;
  readonly trigger: PlacementTrigger;
  readonly state: PlacementState;

  /** Stream time for `timeline` triggers. `null` otherwise. */
  startTime: number | null;
  /** Expected duration. `null` for indeterminate (pause, screensaver). */
  duration: number | null;
  readonly endTime: number | null;
  /** Seconds the creative must be visible before `impression` fires. */
  minimumExposure: number | null;

  creative: PlacementCreative;
  layout: PlacementLayout;
  audioPolicy: AudioPolicy;
  interactivity: AdInteractivity | null;
  /** Auto-refresh cadence for pause and screensaver. */
  refresh: { intervalMs: number } | null;
  /** For `companion`: the slot this companion accompanies. */
  linkedSlot: Slot | null;

  identifiers: AdIdentifier[];
  /** Offsets are relative to activation. */
  tracking: TrackingEvent[];
  verifications: Verification[];

  /** Set on completion. */
  readonly dismissReason: DismissReason | null;
  /** Seconds since activation. */
  readonly currentTime: number;
  metadata: Record<string, unknown>;

  /** Viewer or app dismissal. Fires `placementdismissed`, then runs the deactivation transition. */
  dismiss(reason?: DismissReason): void;
  /** Reports a click-through. Fires `placementclick` and the `clickTracking` record. */
  click(): void;
}

/**
 * Every placement known to the session. Always present on the session; empty when no placement adapter is attached.
 *
 * @experimental
 */
export interface AdPlacements {
  readonly items: ReadonlyArray<AdPlacement>;
  /** Placements in `activating`, `active` or `deactivating`. Multiple placements may be active at once. */
  readonly active: ReadonlyArray<AdPlacement>;
  getByKind(kind: PlacementKind): ReadonlyArray<AdPlacement>;
  getById(id: string): AdPlacement | null;
}

/**
 * What an adapter supplies to create a placement.
 *
 * @experimental
 */
export interface PlacementInit {
  id: string;
  kind: PlacementKind;
  trigger: PlacementTrigger;
  startTime?: number | null | undefined;
  duration?: number | null | undefined;
  minimumExposure?: number | null | undefined;
  creative: PlacementCreative;
  /** @default a full-player viewport with no transition */
  layout?: PlacementLayout | undefined;
  /** @default 'none' */
  audioPolicy?: AudioPolicy | undefined;
  interactivity?: AdInteractivity | null | undefined;
  refresh?: { intervalMs: number } | null | undefined;
  linkedSlot?: Slot | null | undefined;
  identifiers?: AdIdentifier[] | undefined;
  tracking?: TrackingEvent[] | undefined;
  verifications?: Verification[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

/** @experimental */
export type PlacementPatch = Partial<Omit<PlacementInit, 'id' | 'kind' | 'trigger'>>;

const ACTIVE_STATES: ReadonlySet<PlacementState> = new Set(['activating', 'active', 'deactivating']);

/**
 * What the session does for the placement layer: dispatch events and fire tracking records.
 *
 * @internal
 */
export interface PlacementHooks {
  emit<K extends keyof AdSessionEventMap>(type: K, detail: AdSessionEventMap[K]): void;
  fireTracking(placement: PlacementImpl, event: TrackingEvent): void;
}

/** @internal */
export class PlacementImpl implements AdPlacement {
  readonly id: string;
  readonly kind: PlacementKind;
  readonly trigger: PlacementTrigger;

  startTime: number | null;
  duration: number | null;
  minimumExposure: number | null;
  creative: PlacementCreative;
  layout: PlacementLayout;
  audioPolicy: AudioPolicy;
  interactivity: AdInteractivity | null;
  refresh: { intervalMs: number } | null;
  linkedSlot: Slot | null;
  identifiers: AdIdentifier[];
  tracking: TrackingEvent[];
  verifications: Verification[];
  metadata: Record<string, unknown>;

  /** @internal */
  _state: PlacementState = 'scheduled';
  /** @internal */
  _dismissReason: DismissReason | null = null;
  /** @internal */
  _activatedAt: number | null = null;
  /** @internal */
  _clock = 0;
  /** @internal */
  _fired = new Set<TrackingEvent>();
  /** @internal */
  _timers = new Set<ReturnType<typeof setTimeout>>();

  readonly #placements: PlacementsImpl;

  constructor(init: PlacementInit, placements: PlacementsImpl) {
    this.id = init.id;
    this.kind = init.kind;
    this.trigger = init.trigger;
    this.startTime = init.startTime ?? null;
    this.duration = init.duration ?? null;
    this.minimumExposure = init.minimumExposure ?? null;
    this.creative = init.creative;
    this.layout = init.layout ?? {
      adViewport: { top: 0, right: 0, bottom: 0, left: 0 },
      contentViewport: null,
      transitionDuration: 0,
    };
    this.audioPolicy = init.audioPolicy ?? 'none';
    this.interactivity = init.interactivity ?? null;
    this.refresh = init.refresh ?? null;
    this.linkedSlot = init.linkedSlot ?? null;
    this.identifiers = init.identifiers ?? [];
    this.tracking = init.tracking ?? [];
    this.verifications = init.verifications ?? [];
    this.metadata = init.metadata ?? {};
    this.#placements = placements;
  }

  get state(): PlacementState {
    return this._state;
  }

  get endTime(): number | null {
    return this.startTime !== null && this.duration !== null ? this.startTime + this.duration : null;
  }

  get dismissReason(): DismissReason | null {
    return this._dismissReason;
  }

  get currentTime(): number {
    return this._clock;
  }

  dismiss(reason: DismissReason = 'viewerDismissed'): void {
    this.#placements.deactivate(this.id, reason);
  }

  click(): void {
    this.#placements.click(this);
  }
}

/** @internal */
export class PlacementsImpl implements AdPlacements {
  readonly #items: PlacementImpl[] = [];
  readonly #byId = new Map<string, PlacementImpl>();
  readonly #hooks: PlacementHooks;

  constructor(hooks: PlacementHooks) {
    this.#hooks = hooks;
  }

  get items(): ReadonlyArray<PlacementImpl> {
    return this.#items;
  }

  get active(): ReadonlyArray<PlacementImpl> {
    return this.#items.filter((item) => ACTIVE_STATES.has(item._state));
  }

  getByKind(kind: PlacementKind): ReadonlyArray<PlacementImpl> {
    return this.#items.filter((item) => item.kind === kind);
  }

  getById(id: string): PlacementImpl | null {
    return this.#byId.get(id) ?? null;
  }

  // ----------------------------------------
  // Host operations
  // ----------------------------------------

  add(init: PlacementInit): PlacementImpl {
    if (this.#byId.has(init.id)) throw new Error(`Placement "${init.id}" already exists`);

    const placement = new PlacementImpl(init, this);

    this.#items.push(placement);
    this.#byId.set(placement.id, placement);
    this.#hooks.emit('placementscheduled', { placement });

    return placement;
  }

  update(id: string, patch: PlacementPatch): void {
    const placement = this.#require(id);

    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (placement as unknown as Record<string, unknown>)[key] = value;
    }
  }

  remove(id: string): void {
    const placement = this.#byId.get(id);
    if (!placement) return;

    this.#clearTimers(placement);
    this.#items.splice(this.#items.indexOf(placement), 1);
    this.#byId.delete(id);
  }

  /** Moves a placement through `activating` (for `layout.transitionDuration` milliseconds) into `active`. */
  activate(id: string): void {
    const placement = this.#require(id);
    if (placement._state !== 'scheduled') return;

    placement._state = 'activating';
    placement._activatedAt = Date.now();
    placement._clock = 0;
    placement._fired.clear();
    this.#hooks.emit('placementactivating', { placement });

    this.#after(placement, placement.layout.transitionDuration, () => {
      placement._state = 'active';
      this.#hooks.emit('placementactive', { placement });
      this.#fire(placement, 'start');

      // `impression` waits for the minimum exposure the format requires.
      this.#after(placement, (placement.minimumExposure ?? 0) * 1000, () => {
        if (placement._state !== 'active') return;

        this.#hooks.emit('placementimpression', { placement });
        this.#fire(placement, 'impression');
      });
    });
  }

  /** Moves a placement through `deactivating` into `completed`, recording why. */
  deactivate(id: string, reason: DismissReason): void {
    const placement = this.#require(id);
    if (placement._state !== 'activating' && placement._state !== 'active') return;

    this.#clearTimers(placement);
    placement._state = 'deactivating';
    placement._dismissReason = reason;
    this.#hooks.emit('placementdeactivating', { placement });

    this.#after(placement, placement.layout.transitionDuration, () => {
      placement._state = 'completed';
      // `placementdismissed` lands at the end of the transition, so a consumer sees the placement leave `active`.
      this.#hooks.emit('placementdismissed', { placement, reason });

      if (reason === 'completed') this.#fire(placement, 'complete');
    });
  }

  click(placement: PlacementImpl): void {
    this.#hooks.emit('placementclick', { placement });
    this.#fire(placement, 'clickTracking');
  }

  /** Drives `timeline` placements from the stream clock and keeps every active placement's clock current. */
  tick(streamTime: number): void {
    const now = Date.now();

    for (const placement of this.#items) {
      if (placement.trigger === 'timeline' && placement.startTime !== null) {
        const endTime = placement.endTime ?? Number.POSITIVE_INFINITY;
        const inside = placement.startTime <= streamTime && streamTime < endTime;

        if (inside && placement._state === 'scheduled') this.activate(placement.id);
        else if (!inside && (placement._state === 'active' || placement._state === 'activating')) {
          this.deactivate(placement.id, streamTime >= endTime ? 'completed' : 'navigatedAway');
        }
      }

      if (ACTIVE_STATES.has(placement._state)) {
        placement._clock =
          placement.trigger === 'timeline' && placement.startTime !== null
            ? Math.max(0, streamTime - placement.startTime)
            : (now - (placement._activatedAt ?? now)) / 1000;

        this.#fireDueOffsets(placement);
      }
    }
  }

  destroy(): void {
    for (const placement of this.#items) this.#clearTimers(placement);

    this.#items.length = 0;
    this.#byId.clear();
  }

  #require(id: string): PlacementImpl {
    const placement = this.#byId.get(id);
    if (!placement) throw new Error(`Unknown placement "${id}"`);

    return placement;
  }

  #after(placement: PlacementImpl, delay: number, callback: () => void): void {
    if (delay <= 0) {
      callback();
      return;
    }

    const timer = setTimeout(() => {
      placement._timers.delete(timer);
      callback();
    }, delay);

    placement._timers.add(timer);
  }

  #clearTimers(placement: PlacementImpl): void {
    for (const timer of placement._timers) clearTimeout(timer);

    placement._timers.clear();
  }

  #fire(placement: PlacementImpl, type: TrackingEvent['type']): void {
    for (const event of placement.tracking) {
      if (event.type === type && event.offset === null && !placement._fired.has(event)) {
        placement._fired.add(event);
        this.#hooks.fireTracking(placement, event);
      }
    }
  }

  #fireDueOffsets(placement: PlacementImpl): void {
    for (const event of placement.tracking) {
      if (event.offset !== null && placement._clock >= event.offset && !placement._fired.has(event)) {
        placement._fired.add(event);
        this.#hooks.fireTracking(placement, event);
      }
    }
  }
}
