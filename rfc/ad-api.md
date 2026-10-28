---
status: draft
---

**Video Ad API: Design Proposal (v8)**

_An Interstitial Schedule and Placement Layer for Linear and Non-Linear Ad Formats_

# **Table of Contents**

1. Introduction
2. Design Principles
3. Terminology
4. Architecture Overview
5. Enumerations
6. Core Interfaces (Layer 1: Interstitial Schedule)
7. Placement Interfaces (Layer 2: Ad Placements)
8. Events
9. Lifecycle and Ownership
10. Time Model
11. Adapter Contract
12. Usage Patterns
13. Video.js 10 Integration
14. Migration from v6
15. Open Questions
16. Next Steps

# **1. Introduction**

## **1.1 Why v7**

v6 was implemented for a single use case: linear ads delivered by SSAI. The implementation covered every UI and analytics requirement, but it also had to construct an `AdTrackList` with one `LINEAR` track, branch on `servingMode`, emit `ACTIVATING` and `DEACTIVATING` transitions that had nothing to represent, and populate or stub viewport, dismiss reason, audio policy and interactivity fields that belong to non-linear formats. The same mismatch was foreseeable for SGAI, which needs asset-list resolution, resume offsets and playout limits that v6 had no slot for, and for CSAI, where the per-format track added nothing.

The reassessment found that the TextTrack analogy was the cause. TextTracks exist because a media resource has multiple parallel, selectable timed-text streams with a visibility mode. Ad formats are not parallel selectable streams. A playback session has one schedule of timeline regions, and non-linear opportunities are triggered by viewer or device state rather than selected. The per-format track was a taxonomy imposed before the requirements asked for one.

Three external references confirmed the direction. HLS Interstitials, hls.js, Shaka Player, THEOplayer, Bitmovin, IMA DAI, MediaTailor and Roku RAF all expose a schedule of breaks with ads inside, plus current-break and current-ad state. The MPEG-DASH 6th edition Alternative MPD events standardize SGAI on DASH with the same region model as HLS Interstitials. And SVTA2053 defines a Pod, Slot, TrackingEvent and Verification data model whose carriage is defined independently of the stitching mechanism, which is the shape the API's ad metadata should take if adapters are to be thin.

## **1.2 Goals**

- Provide one API surface for linear ads that works unchanged across CSAI, SSAI, SGAI and pod serving, where the delivery mechanism is a property of each region.
- Provide an optional second layer for the IAB CTV non-linear formats (Pause, Menu, Squeezeback, Overlay, In-Scene, Screensaver) and for companions, without forcing linear-only implementations to carry it.
- Expose what UI and analytics need: schedule and markers, current region and slot with position in pod and remaining time, start, end, progress, skip, click and error events, navigation restrictions, and conversion between stream time and content time.
- Carry ad metadata in the SVTA2053 shape so that an SVTA adapter requires no field mapping and other adapters map into a documented target.
- Keep the player in control of the clock. Adapters supply and resolve data; the player decides when regions enter and exit.
- Be incrementally adoptable: a linear-only player implements Section 6 and ignores Section 7.

## **1.3 Scope**

This document covers the programmatic API surface: TypeScript interfaces, properties, methods, events, enumerations and the adapter contract. It does not cover VAST or VMAP parsing, ad-server communication, beacon transport, or rendering implementation. Those live in adapters, in a pluggable beacon sender, and in the integrator's player.

## **1.4 Non-goals**

- Standardizing how a stitcher signals breaks. The API consumes signals; it does not define them.
- Defining an interstitial player for CSAI and SGAI media. The API defines the contract that such a player must satisfy (Section 11.4) and leaves the implementation to the integrator.
- Covering multiview offers or other non-ad timed signals beyond ensuring that they do not break linear implementations (Section 15).

# **2. Design Principles**

## **2.1 Two layers, not one hierarchy**

Layer 1 is the `InterstitialSchedule`: timeline regions that replace, interrupt or are stitched into primary content. It is mandatory for any linear implementation. Layer 2 is `AdPlacements`: ad experiences that are triggered by viewer or device state, or that share the screen with content while it keeps playing. It is optional. The two layers share the same metadata records and the same event vocabulary so that analytics is uniform, but they do not share a container, because a pause ad has no timeline region and a mid-roll has no viewport.

## **2.2 Delivery is a property of a region**

Each `Interstitial` declares how its media reaches the viewer: `stitched` (the media is already in the primary stream), `inserted` (primary content pauses, a separate asset plays, primary resumes where it left off) or `replaced` (a separate asset plays in place of a span of primary content, typical for live). Everything that differs between SSAI, CSAI and SGAI follows from this one field: whether content pause and resume events fire, whether a second player is needed, how stream time maps to content time, and what `resumeOffset` means. There is no session-level serving mode.

## **2.3 The clock drives timeline regions**

For every region with a known `startTime`, the player activates and deactivates it as the playhead crosses its boundaries, the same way a browser drives `VTTCue` enter and exit. Adapters never call activate or deactivate on a region. Loading of slot data and media is tracked separately in `resolution`, because SGAI asset lists and SVTA remote fields are resolved late, often after the region has already started.

## **2.4 Tracking is data**

A `Slot` carries an array of `TrackingEvent` records, each with a type, an optional offset relative to its container, and URLs. The player fires a `tracking` event when the clock or a viewer action makes a record due. Quartiles are `progress` records at 25, 50 and 75 percent, which is how SVTA2053 expresses them, rather than a fixed set of named events. A pluggable beacon sender performs VAST macro replacement and the HTTP requests.

## **2.5 Align with SVTA2053**

The ad metadata records in this document (`Slot`, `AdIdentifier`, `MediaReference`, `TrackingEvent`, `Verification`) use the SVTA2053 names, field names and types. Runtime fields (`state`, `currentTime`, `index`) are layered on top. The specification is referenced by its scheme URI and payload version, not by its document number, because the numbering is still moving.

## **2.6 Incremental adoption**

A player that only needs stitched linear ads implements `AdSession`, `InterstitialSchedule`, `Interstitial`, `Slot`, the shared records, and the events in Section 8.2 through 8.4. Nothing in Section 7 is required, and no field in Section 6 exists only to serve Section 7.

# **3. Terminology**

| Term           | Definition                                                                                                                               | v6 equivalent                       | Why the name                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Session        | The object that owns the schedule, the placements, the time mapping and the attached adapters for one playback of one primary stream.    | AdTrackList (loosely)               | A session is bounded by one stream; tracks were not.                                                            |
| Interstitial   | A region on the primary timeline during which something other than primary content is presented: an ad pod, a bumper, a recap, a slate.  | AdCue on the LINEAR track           | The region is not necessarily an ad. HLS and SVTA both anticipate non-ad assets in the same construct.          |
| Slot           | One creative played within an interstitial. For an ad pod, one ad.                                                                       | Ad (linear)                         | SVTA2053 term. "Ad" is reserved for the commercial sense and appears in the placement layer and in identifiers. |
| Placement      | An ad experience that is not an interstitial: a pause ad, overlay, squeezeback, menu tile, screensaver, in-scene composite or companion. | AdCue plus Ad on a non-linear track | IAB's own term for where a format appears.                                                                      |
| Insertion mode | How an interstitial's media reaches the viewer: stitched, inserted or replaced.                                                          | AdTrack.servingMode                 | Describes the region, not the session.                                                                          |
| Stream time    | `primaryElement.currentTime`. Includes stitched interstitials.                                                                           | Not distinguished                   | The clock the player actually has.                                                                              |
| Content time   | Stream time with stitched interstitial durations removed. What the viewer thinks of as position in the program.                          | Not distinguished                   | Needed for UI scrubbers, resume points and analytics.                                                           |
| Adapter        | A component that reads a signaling source (SVTA date ranges, DASH events, an ad server response, an SDK) and populates the session.      | Adapter                             | Unchanged.                                                                                                      |

# **4. Architecture Overview**

```
+---------------------------------------------------------------------+
|  AdSession                                                          |
|                                                                     |
|   primaryElement: HTMLMediaElement      time: TimeMapping           |
|   interstitialPlayer: InterstitialPlayer | null                     |
|                                                                     |
|   +------------------------------+  +-----------------------------+ |
|   | InterstitialSchedule (L1)    |  | AdPlacements (L2, optional) | |
|   |                              |  |                             | |
|   |  Interstitial[] ordered by   |  |  AdPlacement[]              | |
|   |  startTime                   |  |   kind: pause|overlay|...   | |
|   |   +- insertion               |  |   trigger: timeline|user|.. | |
|   |   +- restrictions, snap      |  |   layout, creative          | |
|   |   +- resolution, played      |  |   linkedSlot (companions)   | |
|   |   +- tracking[] (pod level)  |  |                             | |
|   |   +- Slot[] ordered          |  +-----------------------------+ |
|   |        +- identifiers[]      |                                  |
|   |        +- media[]            |                                  |
|   |        +- tracking[]         |                                  |
|   |        +- verifications[]    |                                  |
|   |        +- skipControl        |                                  |
|   +------------------------------+                                  |
|                                                                     |
|   events (flat, on the session): scheduleupdated, interstitialstart,|
|   slotstart, slotprogress, tracking, placementactive, timeupdate... |
+---------------------------------------------------------------------+
            ^                      ^                      ^
            |                      |                      |
   SVTA2053 adapter      HLS Interstitials /     IMA DAI / MediaTailor /
   (DATERANGE, EMSG,     DASH Alt MPD adapter    VAST+VMAP adapters
    ASSET-LIST)
```

The session is the only object that a player needs to hold. The schedule is a flat ordered list; "current" state is derived from the clock. Adapters write into the session through the `AdapterHost` interface (Section 11.1) and never into player state. The optional `InterstitialPlayer` (Section 11.4) is how the session plays `inserted` and `replaced` media; a `stitched`-only integration leaves it null.

# **5. Enumerations**

String enums are used throughout so that values survive JSON serialization and match the wire formats they derive from.

## **5.1 InsertionMode**

| Value      | Description                                                                                                                                                   | Content pause/resume | Second player | Content time                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------- | ---------------------------------------------- |
| `stitched` | Media is already in the primary stream (SSAI). The region marks where it is.                                                                                  | No                   | No            | Stream time minus stitched durations before it |
| `inserted` | Primary pauses at `startTime`, separate media plays, primary resumes at `startTime + resumeOffset` (default 0). CSAI and SGAI on VOD.                         | Yes                  | Yes           | Identity                                       |
| `replaced` | Separate media plays in place of the primary span `[startTime, startTime + resumeOffset)`; default `resumeOffset` is the interstitial duration. SGAI on live. | Yes                  | Yes           | Identity                                       |

```typescript
type InsertionMode = "stitched" | "inserted" | "replaced";
```

## **5.2 CuePosition**

| Value  | Description                                                                             |
| ------ | --------------------------------------------------------------------------------------- |
| `pre`  | Play before primary content starts. `startTime` is 0.                                   |
| `mid`  | Play at `startTime`.                                                                    |
| `post` | Play after primary content ends. `startTime` is the content duration, or null for live. |

```typescript
type CuePosition = "pre" | "mid" | "post";
```

Play-once semantics (HLS `CUE="ONCE"`) are a separate boolean, `playOnce`, because they combine with any position.

## **5.3 TimelineOccupancy and TimelineStyle**

UI hints for a progress bar, carried from HLS `X-TIMELINE-OCCUPIES` and `X-TIMELINE-STYLE`.

| Enum              | Value       | Description                                                       |
| ----------------- | ----------- | ----------------------------------------------------------------- |
| TimelineOccupancy | `point`     | Draw a marker at `startTime`. Default for `inserted`.             |
| TimelineOccupancy | `range`     | Draw a span of `duration`. Default for `stitched` and `replaced`. |
| TimelineStyle     | `highlight` | Visually distinct from content (default).                         |
| TimelineStyle     | `primary`   | Drawn the same as content.                                        |

```typescript
type TimelineOccupancy = "point" | "range";
type TimelineStyle = "highlight" | "primary";
```

## **5.4 ResolutionState**

Describes whether an interstitial's slot data and media are known. Independent of playback state, because resolution is often deferred until the region is about to start (HLS asset lists, SVTA `$remote` fields).

| Value        | Description                                                                                                                                                     |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unresolved` | Region is known; slots are not.                                                                                                                                 |
| `resolving`  | A fetch is in flight.                                                                                                                                           |
| `resolved`   | Slots are populated.                                                                                                                                            |
| `empty`      | Resolution succeeded and returned no slots. For `inserted` and `replaced`, the player skips the region. For `stitched`, the region plays with no slot metadata. |
| `error`      | Resolution failed. Same playback behavior as `empty`.                                                                                                           |

```typescript
type ResolutionState =
  | "unresolved"
  | "resolving"
  | "resolved"
  | "empty"
  | "error";
```

## **5.5 InterstitialState**

| Value       | Description                                             |
| ----------- | ------------------------------------------------------- |
| `scheduled` | Not yet reached.                                        |
| `active`    | Playhead is inside the region.                          |
| `completed` | Reached its end or `playoutLimit`.                      |
| `skipped`   | Ended early by `skip()` or by a permitted seek past it. |
| `error`     | Could not be presented.                                 |

```typescript
type InterstitialState =
  | "scheduled"
  | "active"
  | "completed"
  | "skipped"
  | "error";
```

There are no transitional states. A region is active from the moment the clock enters it, whether or not its slots are resolved.

## **5.6 SlotState**

Unchanged from v6 `AdState`, lower-cased.

```typescript
type SlotState = "pending" | "active" | "completed" | "skipped" | "error";
```

## **5.7 NavigationRestriction**

| Value  | Description                                                                                         | Source                                                       |
| ------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `skip` | The viewer may not end the interstitial early. `Interstitial.skip()` and `Slot.skip()` throw.       | HLS `X-RESTRICT=SKIP`                                        |
| `jump` | The viewer may not seek from before `startTime` to after it without the interstitial playing first. | HLS `X-RESTRICT=JUMP`                                        |
| `rate` | Playback rate must be 1.0 for the interstitial to advance. Trick play is blocked.                   | AVFoundation `requiresPlaybackAtPreferredRateForAdvancement` |

```typescript
type NavigationRestriction = "skip" | "jump" | "rate";
```

## **5.8 TrackingEventType**

The SVTA2053 `EventType` enumeration, verbatim. Types that also exist in VAST are equivalent to their VAST counterparts.

```typescript
type TrackingEventType =
  | "clickTracking"
  | "complete"
  | "error"
  | "firstQuartile"
  | "impression"
  | "loaded"
  | "midpoint"
  | "mute"
  | "pause"
  | "playerCollapse"
  | "playerExpand"
  | "podEnd"
  | "podStart"
  | "progress"
  | "resume"
  | "skip"
  | "start"
  | "thirdQuartile"
  | "unmute";
```

`progress` requires an `offset`. `firstQuartile`, `midpoint` and `thirdQuartile` are accepted for VAST compatibility and are treated as `progress` at 25, 50 and 75 percent of the slot duration when no offset is given.

## **5.9 PlacementKind**

| Value         | IAB format     | Trigger (typical)            | Timeline region            |
| ------------- | -------------- | ---------------------------- | -------------------------- |
| `pause`       | Pause Ad       | `userAction`                 | No                         |
| `screensaver` | Screensaver Ad | `deviceState`                | No                         |
| `menu`        | Menu Ad        | `userAction`                 | No; no media element       |
| `overlay`     | Overlay        | `timeline` or `programmatic` | Yes, shares screen         |
| `squeezeback` | Squeezeback    | `timeline` or `programmatic` | Yes, resizes content       |
| `inScene`     | In-Scene       | `composited`                 | Yes, measurement only      |
| `companion`   | VAST Companion | `timeline`, bound to a slot  | Inherits the slot's region |

```typescript
type PlacementKind =
  | "pause"
  | "screensaver"
  | "menu"
  | "overlay"
  | "squeezeback"
  | "inScene"
  | "companion";
```

## **5.10 PlacementTrigger**

Carried from v6 `AdTriggerType`, lower camel case.

```typescript
type PlacementTrigger =
  | "timeline"
  | "userAction"
  | "deviceState"
  | "programmatic"
  | "composited";
```

## **5.11 PlacementState**

The transitional states survive here because squeezeback content resizing and overlay fades are real intervals that UI code needs to know about.

```typescript
type PlacementState =
  | "scheduled"
  | "activating"
  | "active"
  | "deactivating"
  | "completed"
  | "error";
```

## **5.12 DismissReason**

Unchanged from v6, lower camel case. Applies to placements only.

```typescript
type DismissReason =
  | "completed"
  | "viewerDismissed"
  | "contentResumed"
  | "navigatedAway"
  | "deviceTimeout"
  | "appExited"
  | "skipped"
  | "replaced";
```

## **5.13 AudioPolicy**

```typescript
type AudioPolicy = "required" | "optional" | "none";
```

## **5.14 InterstitialEndReason**

Why an interstitial left the `active` state. Reported on `interstitialend`.

```typescript
type InterstitialEndReason =
  | "completed"
  | "skipped"
  | "seeked"
  | "playoutLimit"
  | "error";
```

# **6. Core Interfaces (Layer 1: Interstitial Schedule)**

## **6.1 AdSession**

The root object. One per primary stream. Created by the integrator, populated by adapters, read by UI and analytics.

| Property / Method      | Type                            | Description                                                                                         |
| ---------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------- |
| primaryElement         | HTMLMediaElement (readonly)     | The element playing primary content. For `stitched` regions it is also playing the ads.             |
| interstitialPlayer     | InterstitialPlayer \| null      | Plays `inserted` and `replaced` media. Null in stitched-only integrations. See Section 11.4.        |
| schedule               | InterstitialSchedule (readonly) | Layer 1.                                                                                            |
| placements             | AdPlacements (readonly)         | Layer 2. Always present; empty when no placement adapter is attached.                               |
| time                   | TimeMapping (readonly)          | Stream time, content time and conversions. See Section 10.                                          |
| beacons                | BeaconSender \| null            | Pluggable sender for `tracking` events. Null means the integrator handles `tracking` events itself. |
| adapters               | ReadonlyArray\<AdAdapter\>      | Attached adapters.                                                                                  |
| attachAdapter(adapter) | void                            | Attaches and calls `adapter.attach(host)`.                                                          |
| detachAdapter(adapter) | void                            | Detaches. Regions and placements the adapter created remain unless it removes them in `detach()`.   |
| destroy()              | void                            | Detaches all adapters, stops timers, removes listeners.                                             |

```typescript
interface AdSession extends EventTarget {
  readonly primaryElement: HTMLMediaElement;
  interstitialPlayer: InterstitialPlayer | null;
  readonly schedule: InterstitialSchedule;
  readonly placements: AdPlacements;
  readonly time: TimeMapping;
  beacons: BeaconSender | null;
  readonly adapters: ReadonlyArray<AdAdapter>;

  attachAdapter(adapter: AdAdapter): void;
  detachAdapter(adapter: AdAdapter): void;
  destroy(): void;

  addEventListener<K extends keyof AdSessionEventMap>(
    type: K,
    listener: (event: CustomEvent<AdSessionEventMap[K]>) => void,
  ): void;
  removeEventListener<K extends keyof AdSessionEventMap>(
    type: K,
    listener: (event: CustomEvent<AdSessionEventMap[K]>) => void,
  ): void;
}

interface AdSessionInit {
  primaryElement: HTMLMediaElement;
  interstitialPlayer?: InterstitialPlayer;
  beacons?: BeaconSender;
  /** Default: true. When false, the player never blocks seeks; UI gets 'seekblocked' only as a notification. */
  enforceRestrictions?: boolean;
  /** Default: detected from the primary element. Controls whether content time removes stitched durations (vod) or equals stream time (live). See Section 10.1. */
  timeline?: "vod" | "live";
}

declare function createAdSession(init: AdSessionInit): AdSession;
```

## **6.2 InterstitialSchedule**

A flat, ordered, read-only view of every region known to the session. Regions with a known `startTime` are sorted by it. Regions whose start is not yet known (live, `post` on live) are appended in arrival order.

| Property / Method          | Type                          | Description                                                                                        |
| -------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------- |
| items                      | ReadonlyArray\<Interstitial\> | All regions, including completed ones. Completed regions stay for history and for `played` checks. |
| current                    | Interstitial \| null          | The region the playhead is inside, or null.                                                        |
| currentSlot                | Slot \| null                  | `current?.currentSlot`.                                                                            |
| upcoming                   | Interstitial \| null          | The next scheduled region after the playhead.                                                      |
| getById(id)                | Interstitial \| null          | Lookup by region id.                                                                               |
| nextAfter(streamTime)      | Interstitial \| null          | First region with `startTime > streamTime`.                                                        |
| previousBefore(streamTime) | Interstitial \| null          | Last region with `startTime <= streamTime`. Used by snapback.                                      |
| unplayedBetween(from, to)  | Interstitial[]                | Regions with `played === false` whose start lies in `(from, to]`. Used by jump enforcement.        |

```typescript
interface InterstitialSchedule {
  readonly items: ReadonlyArray<Interstitial>;
  readonly current: Interstitial | null;
  readonly currentSlot: Slot | null;
  readonly upcoming: Interstitial | null;

  getById(id: string): Interstitial | null;
  nextAfter(streamTime: number): Interstitial | null;
  previousBefore(streamTime: number): Interstitial | null;
  unplayedBetween(fromStreamTime: number, toStreamTime: number): Interstitial[];
}
```

## **6.3 Interstitial**

A timeline region. Carries the SVTA `Pod` fields (`startTime`, `duration`, `slots`, `tracking`) plus the HLS Interstitials navigation and UI fields plus runtime state.

| Property          | Type                                 | Description                                                                                                                                                                                                  |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| id                | string (readonly)                    | Unique within the session. For manifest-signaled regions this is the signaling id (DASH `Event@id`, HLS `DATERANGE ID`), which is unique per manifest and is not an ad identifier.                           |
| kind              | 'ad' \| 'content' (readonly)         | Whether the region is commercial. Bumpers, recaps and slates are `content`. UI may style them differently; analytics may ignore them.                                                                        |
| insertion         | InsertionMode (readonly)             | How the media is delivered. See 5.1.                                                                                                                                                                         |
| cue               | CuePosition (readonly)               | pre, mid or post.                                                                                                                                                                                            |
| playOnce          | boolean (readonly)                   | If true, the region is removed from the schedule after it completes.                                                                                                                                         |
| startTime         | number \| null                       | Stream time at which the region begins. Null only for a `post` region on live.                                                                                                                               |
| plannedDuration   | number \| null                       | Duration announced before the region resolves (HLS `PLANNED-DURATION`, SCTE-35 break duration).                                                                                                              |
| duration          | number \| null                       | Actual duration once known. Equals the sum of slot durations when resolved.                                                                                                                                  |
| endTime           | number \| null (readonly)            | `startTime + duration` when both are known.                                                                                                                                                                  |
| resumeOffset      | number \| null                       | Where primary resumes relative to `startTime` after an `inserted` or `replaced` region. Null means the default for the insertion mode (0 for `inserted`, `duration` for `replaced`). Ignored for `stitched`. |
| playoutLimit      | number \| null                       | Maximum seconds the region may present. When reached, the region ends with reason `playoutLimit`.                                                                                                            |
| restrictions      | ReadonlySet\<NavigationRestriction\> | See 5.7.                                                                                                                                                                                                     |
| snap              | { out: boolean; in: boolean }        | Align departure and return to primary segment boundaries. Live only.                                                                                                                                         |
| timelineOccupancy | TimelineOccupancy                    | UI hint. See 5.3.                                                                                                                                                                                            |
| timelineStyle     | TimelineStyle                        | UI hint.                                                                                                                                                                                                     |
| state             | InterstitialState (readonly)         | Playback state. Player-owned.                                                                                                                                                                                |
| resolution        | ResolutionState (readonly)           | Data state. Adapter-owned via the host.                                                                                                                                                                      |
| played            | boolean (readonly)                   | True once the region has completed at least once. Not reset on replay.                                                                                                                                       |
| slots             | ReadonlyArray\<Slot\>                | Ordered slots. Empty until resolved.                                                                                                                                                                         |
| currentSlot       | Slot \| null (readonly)              | Slot the playhead is inside.                                                                                                                                                                                 |
| currentTime       | number (readonly)                    | Seconds elapsed inside the region. 0 when not active.                                                                                                                                                        |
| remainingTime     | number \| null (readonly)            | `duration - currentTime`, or null when duration is unknown.                                                                                                                                                  |
| tracking          | TrackingEvent[]                      | Pod-level tracking (`podStart`, `podEnd`).                                                                                                                                                                   |
| metadata          | Record\<string, unknown\>            | Adapter pass-through (SCTE-35 payload, vendor break id).                                                                                                                                                     |

| Method | Returns | Description                                                                                                                                                   |
| ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| skip() | void    | Ends the region now and resumes primary. Throws if `restrictions` has `skip` or `state !== 'active'`. For `stitched`, seeks the primary element to `endTime`. |

```typescript
interface Interstitial {
  readonly id: string;
  readonly kind: "ad" | "content";
  readonly insertion: InsertionMode;
  readonly cue: CuePosition;
  readonly playOnce: boolean;

  startTime: number | null;
  plannedDuration: number | null;
  duration: number | null;
  readonly endTime: number | null;
  resumeOffset: number | null;
  playoutLimit: number | null;
  restrictions: ReadonlySet<NavigationRestriction>;
  snap: { out: boolean; in: boolean };
  timelineOccupancy: TimelineOccupancy;
  timelineStyle: TimelineStyle;

  readonly state: InterstitialState;
  readonly resolution: ResolutionState;
  readonly played: boolean;

  readonly slots: ReadonlyArray<Slot>;
  readonly currentSlot: Slot | null;
  readonly currentTime: number;
  readonly remainingTime: number | null;

  tracking: TrackingEvent[];
  metadata: Record<string, unknown>;

  skip(): void;
}
```

## **6.4 Slot**

One creative within an interstitial. The SVTA2053 `Slot` object plus runtime fields.

| Property      | Type                      | Description                                                                                                            | SVTA source                               |
| ------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| id            | string (readonly)         | Unique within the session. Generated by the host if the source has none.                                               | none                                      |
| interstitial  | Interstitial (readonly)   | Owning region.                                                                                                         | none                                      |
| index         | number (readonly)         | 0-based position in `interstitial.slots`. Pod position for UI is `index + 1` of `interstitial.slots.length`.           | none                                      |
| type          | 'linear'                  | Slot type. Only `linear` is defined by SVTA2053 today; the type is a string union so additions do not break consumers. | `Slot.type`                               |
| start         | number                    | Seconds from the interstitial start.                                                                                   | `Slot.start`                              |
| duration      | number                    | Seconds.                                                                                                               | `Slot.duration`                           |
| identifiers   | AdIdentifier[]            | One or more scheme/value pairs. Required for `kind: 'ad'`.                                                             | `Slot.identifiers`                        |
| media         | MediaReference[]          | Creative media. Empty for `stitched` (media is in the stream). Required for `inserted` and `replaced`.                 | `Slot.media`                              |
| tracking      | TrackingEvent[]           | Slot-level tracking.                                                                                                   | `Slot.tracking`                           |
| verifications | Verification[]            | OMID or vendor verification resources.                                                                                 | `Slot.verifications`                      |
| skipControl   | SkipControl \| null       | When and how the skip button appears. Null means not skippable.                                                        | `Slot.skipOffset`, HLS `X-SKIP-CONTROL-*` |
| clickThrough  | string \| null            | Destination URI.                                                                                                       | `Slot.clickThrough`                       |
| title         | string \| null            | Display title, if any.                                                                                                 | none                                      |
| state         | SlotState (readonly)      | Player-owned.                                                                                                          | none                                      |
| currentTime   | number (readonly)         | Seconds elapsed in this slot.                                                                                          | none                                      |
| remainingTime | number (readonly)         | `duration - currentTime`.                                                                                              | none                                      |
| skippable     | boolean (readonly)        | True when `skipControl` is set, `currentTime >= skipControl.offset`, and the interstitial does not restrict `skip`.    | none                                      |
| metadata      | Record\<string, unknown\> | Adapter pass-through (VAST wrapper ids, ad system).                                                                    | none                                      |

| Method  | Returns | Description                                                                                                                                   |
| ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| skip()  | void    | Ends this slot and advances to the next. Throws if `!skippable`. Fires `slotskip` and the `skip` tracking record.                             |
| click() | void    | Reports a click-through activation. Fires `slotclick` and the `clickTracking` record. Does not navigate; the integrator opens `clickThrough`. |

```typescript
interface Slot {
  readonly id: string;
  readonly interstitial: Interstitial;
  readonly index: number;

  type: "linear";
  start: number;
  duration: number;
  identifiers: AdIdentifier[];
  media: MediaReference[];
  tracking: TrackingEvent[];
  verifications: Verification[];
  skipControl: SkipControl | null;
  clickThrough: string | null;
  title: string | null;

  readonly state: SlotState;
  readonly currentTime: number;
  readonly remainingTime: number;
  readonly skippable: boolean;

  metadata: Record<string, unknown>;

  skip(): void;
  click(): void;
}
```

## **6.5 Shared Records**

These records are used by both layers. The first four are the SVTA2053 objects with their field names unchanged.

```typescript
/** SVTA2053 AdIdentifier. scheme is a URI naming the authority (e.g. Ad-ID). */
interface AdIdentifier {
  scheme: string;
  value: string;
}

/** SVTA2053 MediaReference. type is an IANA media type. */
interface MediaReference {
  id: string;
  type: string;
  uri: string;
}

/**
 * SVTA2053 TrackingEvent. offset is seconds relative to the containing
 * Slot or Interstitial start. When null, timing is implied by type.
 */
interface TrackingEvent {
  type: TrackingEventType;
  offset: number | null;
  urls: string[];
}

/** SVTA2053 Verification. Opaque to the player; handed to the OMID or vendor SDK. */
interface Verification {
  vendor: string;
  resource: string | null;
  parameters: string | null;
}

/**
 * Skip control. offset: seconds into the slot before the control may show.
 * duration: how long the control stays available; null means until the slot ends.
 * labelId: localization key for the button text (HLS X-SKIP-CONTROL-LABEL-ID).
 */
interface SkipControl {
  offset: number;
  duration: number | null;
  labelId: string | null;
}
```

The SVTA model is explicit that media MUST NOT be referenced inside the signaling payload. For `stitched` regions the player never reads `Slot.media`; for `inserted` and `replaced`, the adapter populates it from the manifest, the asset list or the VAST response.

## **6.6 BeaconSender**

```typescript
interface BeaconSender {
  /** Called once per due TrackingEvent. Implementations perform VAST Section 6 macro replacement and issue requests. */
  send(event: TrackingEvent, context: TrackingContext): void;
}

interface TrackingContext {
  readonly session: AdSession;
  readonly interstitial: Interstitial | null;
  readonly slot: Slot | null;
  readonly placement: AdPlacement | null;
  readonly streamTime: number;
  readonly contentTime: number;
  readonly firstPlay: boolean;
}
```

# **7. Placement Interfaces (Layer 2: Ad Placements)**

Layer 2 covers ad experiences that have no timeline region, or that share the screen with content while content keeps playing. Everything presentation-specific that v6 attached to every cue and ad lives here.

## **7.1 AdPlacements**

| Property / Method | Type                         | Description                                                                                        |
| ----------------- | ---------------------------- | -------------------------------------------------------------------------------------------------- |
| items             | ReadonlyArray\<AdPlacement\> | All placements, including completed.                                                               |
| active            | ReadonlyArray\<AdPlacement\> | Placements in `activating`, `active` or `deactivating`. Multiple placements may be active at once. |
| getByKind(kind)   | ReadonlyArray\<AdPlacement\> | Filter.                                                                                            |
| getById(id)       | AdPlacement \| null          | Lookup.                                                                                            |

```typescript
interface AdPlacements {
  readonly items: ReadonlyArray<AdPlacement>;
  readonly active: ReadonlyArray<AdPlacement>;
  getByKind(kind: PlacementKind): ReadonlyArray<AdPlacement>;
  getById(id: string): AdPlacement | null;
}
```

## **7.2 AdPlacement**

| Property        | Type                           | Description                                                                                                                                |
| --------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| id              | string (readonly)              | Unique within the session.                                                                                                                 |
| kind            | PlacementKind (readonly)       | See 5.9.                                                                                                                                   |
| trigger         | PlacementTrigger (readonly)    | See 5.10. Decides who drives the lifecycle (Section 9.5).                                                                                  |
| state           | PlacementState (readonly)      | See 5.11.                                                                                                                                  |
| startTime       | number \| null                 | Stream time for `timeline` triggers. Null otherwise.                                                                                       |
| duration        | number \| null                 | Expected duration. Null for indeterminate (pause, screensaver).                                                                            |
| endTime         | number \| null (readonly)      | Derived.                                                                                                                                   |
| minimumExposure | number \| null                 | Seconds the creative must be visible before `impression` fires (IAB: 3 s for in-scene, 10 s minimum duration for overlay and squeezeback). |
| creative        | PlacementCreative              | Asset metadata. See 7.3.                                                                                                                   |
| layout          | PlacementLayout                | Where the ad and the content render. See 7.4.                                                                                              |
| audioPolicy     | AudioPolicy                    | Whether the creative expects audio.                                                                                                        |
| interactivity   | AdInteractivity \| null        | SIMID, QR, remote control. See 7.5.                                                                                                        |
| refresh         | { intervalMs: number } \| null | Auto-refresh cadence for pause and screensaver.                                                                                            |
| linkedSlot      | Slot \| null                   | For `companion`: the slot this companion accompanies.                                                                                      |
| identifiers     | AdIdentifier[]                 | As for slots.                                                                                                                              |
| tracking        | TrackingEvent[]                | As for slots. Offsets are relative to activation.                                                                                          |
| verifications   | Verification[]                 | As for slots.                                                                                                                              |
| dismissReason   | DismissReason \| null          | Set on completion.                                                                                                                         |
| currentTime     | number (readonly)              | Seconds since activation.                                                                                                                  |
| metadata        | Record\<string, unknown\>      | Adapter pass-through.                                                                                                                      |

| Method          | Returns | Description                                                                                               |
| --------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| dismiss(reason) | void    | Viewer or app dismissal. Valid for `pause`, `overlay`, `screensaver`, `menu`. Fires `placementdismissed`. |
| click()         | void    | Reports a click-through.                                                                                  |

```typescript
interface AdPlacement {
  readonly id: string;
  readonly kind: PlacementKind;
  readonly trigger: PlacementTrigger;
  readonly state: PlacementState;

  startTime: number | null;
  duration: number | null;
  readonly endTime: number | null;
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

  readonly dismissReason: DismissReason | null;
  readonly currentTime: number;
  metadata: Record<string, unknown>;

  dismiss(reason?: DismissReason): void;
  click(): void;
}
```

## **7.3 PlacementCreative**

The v6 `AdCreative` record, with identifiers moved to `AdPlacement.identifiers` and click-through kept here because it is per creative.

```typescript
interface PlacementCreative {
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
```

## **7.4 PlacementLayout and Viewport**

`Viewport` is the v6 `AdViewport` record unchanged: percentage insets from the player edges. `PlacementLayout` combines the ad viewport, the content viewport (non-null only when content is resized) and the transition duration, which replaces v6 `SqueezebackMetadata`.

```typescript
/** All values are percentages (0-100) of the player dimensions. */
interface Viewport {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

interface PlacementLayout {
  /** Where the creative renders. Null for menu, in-scene and companion placements rendered outside the player. */
  adViewport: Viewport | null;
  /** Where content renders while the placement is active. Non-null only for squeezeback. */
  contentViewport: Viewport | null;
  /** Content resize or fade duration in milliseconds. 0 when there is no animation. IAB recommends 1000-2000 ms for squeezeback. */
  transitionDuration: number;
}
```

The v6 viewport examples carry over unchanged: a lower-third overlay is `adViewport {70, 0, 0, 0}`; an L-shape squeezeback is `adViewport {60, 0, 0, 0}` with `contentViewport {0, 40, 40, 0}`; a 600 by 600 pause ad is `adViewport {25, 25, 25, 25}`.

## **7.5 AdInteractivity and QRCodeInfo**

Unchanged from v6.

```typescript
interface AdInteractivity {
  framework: "simid" | "custom" | null;
  simidUrl: string | null;
  qrCode: QRCodeInfo | null;
  supportsRemoteControl: boolean;
}

interface QRCodeInfo {
  scanUrl: string;
  isDynamic: boolean;
  /** Position within the creative, as percentages of creative dimensions. */
  position: { x: number; y: number; width: number; height: number } | null;
}
```

## **7.6 Companions**

A companion is a placement with `kind: 'companion'` and a non-null `linkedSlot`. Its lifecycle follows the slot: the host activates it on `slotstart` for the linked slot and deactivates it on `slotend`, unless the adapter marks it `metadata.persistAfterSlot` to keep it visible until the next slot or the interstitial ends. This replaces `Ad.companionAds` in v6 and keeps the `Slot` record free of presentation fields.

# **8. Events**

## **8.1 Delivery model**

All events are dispatched on the `AdSession` as `CustomEvent` instances whose `detail` carries the target object and context. There is no bubbling hierarchy and no per-object `EventTarget`; a listener that wants one region's events filters on `detail.interstitial.id`. This resolves the v6 open question in favor of one subscription point, which is what analytics integrations want and what UI code can filter cheaply.

```typescript
interface AdSessionEventMap {
  // Schedule
  scheduleupdated: {
    added: Interstitial[];
    removed: Interstitial[];
    changed: Interstitial[];
  };

  // Interstitials
  interstitialresolved: { interstitial: Interstitial };
  interstitialstart: { interstitial: Interstitial; firstPlay: boolean };
  interstitialend: {
    interstitial: Interstitial;
    reason: InterstitialEndReason;
    firstPlay: boolean;
  };
  interstitialerror: { interstitial: Interstitial; error: Error };

  // Slots
  slotstart: { slot: Slot; firstPlay: boolean };
  slotprogress: { slot: Slot; offset: number; fraction: number };
  slotskipstatechange: { slot: Slot; skippable: boolean };
  slotskip: { slot: Slot };
  slotclick: { slot: Slot };
  slotend: {
    slot: Slot;
    reason: "completed" | "skipped" | "seeked" | "error";
    firstPlay: boolean;
  };
  sloterror: { slot: Slot; error: Error };

  // Tracking (both layers)
  tracking: { event: TrackingEvent; context: TrackingContext };

  // Navigation
  seekblocked: { interstitial: Interstitial; from: number; to: number };
  snapback: { interstitial: Interstitial; from: number; to: number };
  contentpause: { interstitial: Interstitial };
  contentresume: { interstitial: Interstitial; resumeAt: number };

  // Placements
  placementscheduled: { placement: AdPlacement };
  placementactivating: { placement: AdPlacement };
  placementactive: { placement: AdPlacement };
  placementimpression: { placement: AdPlacement };
  placementdeactivating: { placement: AdPlacement };
  placementdismissed: { placement: AdPlacement; reason: DismissReason };
  placementclick: { placement: AdPlacement };
  placementrefresh: { placement: AdPlacement };
  placementerror: { placement: AdPlacement; error: Error };

  // Clock
  timeupdate: {
    streamTime: number;
    contentTime: number;
    interstitial: Interstitial | null;
    slot: Slot | null;
  };
}
```

## **8.2 firstPlay**

`interstitialstart`, `interstitialend`, `slotstart` and `slotend` carry `firstPlay`, which is false when the region has `played === true` at the moment it starts. UI treats both the same; analytics typically suppresses beacons on replay. This mirrors the IMA DAI split between `AD_BREAK_STARTED` (first time only) and `AD_PERIOD_STARTED` (every time) without two event names.

## **8.3 Content pause and resume**

`contentpause` and `contentresume` fire only for `inserted` and `replaced` regions. A `stitched`-only implementation never receives them and need not handle them. This is the whole of the SSAI behavioral contract that v6 expressed through `servingMode`.

## **8.4 progress and tracking**

`slotprogress` fires at every `progress` tracking record's offset and additionally at 25, 50 and 75 percent when the slot has no records at those points, so UI can show quartile markers regardless of signaling. `tracking` fires for every due `TrackingEvent` on an interstitial, slot or placement, regardless of type. If `session.beacons` is set, the session calls `beacons.send()` after dispatching `tracking`; integrators that want to suppress a beacon call `event.preventDefault()` in their `tracking` listener.

Due-ness rules:

| Record type                                                                                    | Fires when                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `podStart`, `podEnd`                                                                           | Interstitial starts and ends, in that order relative to slot records.                                                         |
| `loaded`                                                                                       | Slot media is buffered enough to play (`inserted`, `replaced`) or the slot start is within one segment duration (`stitched`). |
| `start`, `impression`                                                                          | Slot becomes active. `impression` additionally waits for `minimumExposure` on placements.                                     |
| `progress`, quartiles                                                                          | Clock reaches the offset at playback rate 1.0. Not fired when seeking into the middle of a slot.                              |
| `complete`                                                                                     | Slot ends with reason `completed`.                                                                                            |
| `skip`, `clickTracking`, `pause`, `resume`, `mute`, `unmute`, `playerExpand`, `playerCollapse` | The corresponding `Slot` method or primary element event occurs while the slot is active.                                     |
| `error`                                                                                        | `sloterror` or `interstitialerror`.                                                                                           |

## **8.5 timeupdate**

Fires on every primary element `timeupdate` and on every interstitial player `timeupdate` while an `inserted` or `replaced` region is active, with both clocks resolved. UI should drive countdowns and progress bars from this event rather than from the elements directly, so that stitched and inserted regions look identical.

# **9. Lifecycle and Ownership**

## **9.1 Timeline regions are clock-driven**

The player owns every transition of `Interstitial.state` and `Slot.state`. On each clock tick (primary `timeupdate`, or interstitial player `timeupdate` during `inserted` and `replaced` regions) the session runs:

1. Let `t` be the current stream time.
2. If `schedule.current` is set and `t` is outside `[current.startTime, current.endTime)`, or `current.currentTime >= current.playoutLimit`, end the current region with the matching reason and fire `interstitialend`. For `inserted` and `replaced`, fire `contentresume` and seek primary to `startTime + resumeOffset`.
3. Find the region `r` with `r.startTime <= t < r.endTime`. If none, stop.
4. If `r !== schedule.current`, set `r.state = 'active'`, fire `interstitialstart` with `firstPlay = !r.played`. For `inserted` and `replaced`, fire `contentpause`, pause primary, and hand `r` to the interstitial player.
5. Within `r`, find the slot `s` with `s.start <= r.currentTime < s.start + s.duration`. If `s` differs from `r.currentSlot`, end the previous slot (`completed` if it reached its end, otherwise `seeked`) and start `s`.
6. Fire due tracking records (Section 8.4), `slotprogress`, `slotskipstatechange` and `timeupdate`.

Adapters never call anything that changes `state`. The only adapter-side lifecycle verbs are on resolution (9.2) and placements (9.5).

## **9.2 Resolution is adapter-driven and independent of playback**

An adapter creates a region as soon as it knows the region exists, with `resolution: 'unresolved'` and `slots: []`. It later calls `host.resolve(id, slots)` or `host.failResolution(id, error)`. A region may become active before it resolves; the session then fires `interstitialstart` with an empty slot list and `slotstart` as slots arrive. This matches the SVTA remote-field rule that resolution SHOULD be deferred until the pod or slot is about to become active, and the hls.js behavior where `INTERSTITIAL_STARTED` can precede the asset list.

For `inserted` and `replaced` regions the session must know at least one slot's media before it can start the interstitial player. If the region reaches `startTime` while `unresolved` or `resolving`, the session waits up to `resolutionTimeout` (default 2 s, integrator-configurable) with primary paused, then treats the region as `empty` and resumes.

## **9.3 Seeking**

When the integrator requests a seek from `from` to `to` on the primary element and `enforceRestrictions` is true:

- If any region in `schedule.unplayedBetween(from, to)` has the `jump` restriction, the session cancels the seek, fires `seekblocked`, and instead seeks to that region's `startTime` (the earliest such region when several). After the region completes, the session completes the original seek. This is snapback, and it fires `snapback` when the deferred seek is executed.
- If `to` lands inside a `stitched` region with `jump`, the session seeks to the region's `startTime` instead.
- Seeking out of an active region ends it with reason `seeked`. The `played` flag is set only if the region reached its end.

With `enforceRestrictions` false the session only fires `seekblocked` as advice and lets the seek proceed. Players on platforms where the seek bar is owned by the OS use this mode and enforce in their own UI.

## **9.4 Live**

On live streams regions typically arrive with `plannedDuration` and resolve while active. The schedule is append-only; the session evicts completed regions that fall behind the seekable window start. `post` regions have `startTime: null` until the stream ends. IMA DAI returns no cue points for live, and SCTE-35 `splice_insert` without a duration yields `plannedDuration: null`; both are legal. `snap.out` and `snap.in` are honored only when the primary element exposes segment boundaries (through the player, not through this API).

## **9.5 Placements are trigger-driven**

`timeline` placements follow 9.1 with their own `startTime` and `endTime` and may be active concurrently with an interstitial or with each other. All other triggers are adapter-driven: the adapter calls `host.activatePlacement(id)` when the pause, inactivity timeout, menu navigation or programmatic signal occurs, and `host.deactivatePlacement(id, reason)` when it ends. The session moves `state` through `activating` (for `layout.transitionDuration` milliseconds), `active`, `deactivating` (same duration), `completed`. `placementimpression` fires once `minimumExposure` has elapsed in `active`.

# **10. Time Model**

## **10.1 Two clocks**

|                                   | Stream time                                  | Content time                                                                                          |
| --------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Definition                        | `primaryElement.currentTime`                 | Stream time minus the summed durations of completed or active `stitched` regions that start before it |
| Includes stitched ads             | Yes                                          | No                                                                                                    |
| Includes inserted or replaced ads | No (primary is paused or replaced)           | No                                                                                                    |
| Used for                          | Region boundaries, tracking offsets, seeking | Scrubber position, resume points, content analytics, "time remaining in program"                      |

The session derives content time from the schedule; no adapter supplies a mapping. For a session with only `inserted` and `replaced` regions the two clocks are equal.

Stitched durations are removed on VOD only. On live streams content time equals stream time: the viewer scrubs the DVR window as the stream presents it, ad regions legitimately occupy range on the progress bar, and there is no program duration to preserve. `contentDuration` is null on live. A session learns that a stream is live from the primary element (`duration === Infinity` or a non-empty seekable range with a moving end); integrators can force the mode with `AdSessionInit.timeline: 'vod' | 'live'`. This is also where `timelineOccupancy: 'range'` is meaningful; on VOD every stitched region collapses to a point in content time.

```typescript
interface TimeMapping {
  readonly streamTime: number;
  readonly contentTime: number;
  readonly contentDuration: number | null;
  contentTimeForStreamTime(streamTime: number): number;
  streamTimeForContentTime(contentTime: number): number;
  /** Combined timeline for UI during inserted or replaced regions: primary plus the active interstitial. */
  readonly integrated: {
    readonly currentTime: number;
    readonly duration: number | null;
    readonly seekableStart: number;
    readonly seekableEnd: number;
  };
}
```

## **10.2 Integrated timeline**

During an `inserted` or `replaced` region the primary clock is paused and the interstitial player's clock advances. `time.integrated` presents one continuous timeline for the UI, with the region inserted at its `startTime`, so the progress bar does not freeze. For `stitched` regions `integrated` equals the primary timeline. This is the hls.js `primary` versus `integrated` split and the AVFoundation `integratedTimeline`, exposed in one place.

# **11. Adapter Contract**

## **11.1 AdAdapter and AdapterHost**

```typescript
interface AdAdapter {
  readonly name: string;
  attach(host: AdapterHost): void;
  detach(): void;
}

interface AdapterHost {
  readonly session: AdSession;

  // Schedule
  addInterstitial(init: InterstitialInit): Interstitial;
  updateInterstitial(id: string, patch: Partial<InterstitialInit>): void;
  removeInterstitial(id: string): void;
  resolve(id: string, slots: SlotInit[], podTracking?: TrackingEvent[]): void;
  markResolving(id: string): void;
  failResolution(id: string, error: Error): void;
  /** For stitched streams whose signaling only provides slot records: attaches slots to an existing region. */
  appendSlots(id: string, slots: SlotInit[]): void;

  // Placements
  addPlacement(init: PlacementInit): AdPlacement;
  updatePlacement(id: string, patch: Partial<PlacementInit>): void;
  removePlacement(id: string): void;
  activatePlacement(id: string): void;
  deactivatePlacement(id: string, reason: DismissReason): void;
}

type InterstitialInit = Omit<
  Interstitial,
  | "state"
  | "resolution"
  | "played"
  | "slots"
  | "currentSlot"
  | "currentTime"
  | "remainingTime"
  | "endTime"
  | "skip"
>;

type SlotInit = Omit<
  Slot,
  | "id"
  | "interstitial"
  | "index"
  | "state"
  | "currentTime"
  | "remainingTime"
  | "skippable"
  | "skip"
  | "click"
> & { id?: string };

type PlacementInit = Omit<
  AdPlacement,
  "state" | "endTime" | "dismissReason" | "currentTime" | "dismiss" | "click"
>;
```

Multiple adapters may attach to one session: an SVTA adapter for stitched linear regions plus a pause-ad adapter for placements is the expected pairing.

## **11.2 SVTA2053 adapter**

The reference adapter. It reads the Ad Creative Signaling scheme from DASH `EventStream`, HLS `EXT-X-DATERANGE`, and HLS Interstitial `ASSET-LIST` responses.

Its input contract is the primary element's `metadata` TextTrack, not engine-specific events. Safari surfaces DATERANGE, ID3 and emsg as `DataCue` objects on that track; hls.js surfaces them as `VTTCue` objects with JSON text, by design matching Safari; engines that do not yet project timed metadata into a track (see Section 13.4) need a projection added before this adapter works with them. For DASH, the adapter subscribes to the player's `EventStream` events for the SVTA scheme URI and the SCTE-35 schemes and synthesizes equivalent cues; that shim is adapter code, not engine code. Reading cues rather than engine events is what lets one adapter serve native, hls.js and SPF playback without branching.

| SVTA construct                                                                                                               | API target                                       | Notes                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheme URI                                                                                                                   | Adapter filter                                   | Accept both `urn:svta:advertising-wg:ad-creative-signaling` (normative text) and `urn:svta:advertising-wg:ad-id-signaling` (every published example). Treat as one scheme.                      |
| Envelope `version: 1`                                                                                                        | `Slot.identifiers` only                          | One event per creative; `Interstitial` with one slot per event, or one region spanning adjacent events when they are contiguous.                                                                |
| Envelope `version: 2`, `type: 'pod'`                                                                                         | `Interstitial` plus `tracking`                   | `Pod.start` maps to `startTime` when present; otherwise the event or date-range start is used.                                                                                                  |
| Envelope `type: 'slot'`                                                                                                      | `SlotInit`                                       | Direct copy of `type`, `start`, `duration`, `identifiers`, `media`, `tracking`, `verifications`, `clickThrough`; `skipOffset` becomes `skipControl: { offset, duration: null, labelId: null }`. |
| Envelope `type: 'trackingEvent'`, `'verification'`                                                                           | Merged into the referencing container            | Only through `$remote`.                                                                                                                                                                         |
| Unknown envelope `type` (for example `offer`)                                                                                | Ignored                                          | Log and skip. Must not fail the region.                                                                                                                                                         |
| `features.remoteFields: true` with unsupported feature                                                                       | Ignore payload                                   | Per the spec's rule for unsupported feature flags.                                                                                                                                              |
| `$remote.slots`, `$remote.tracking`, `$remote.verifications`                                                                 | `markResolving`, then `resolve` or `appendSlots` | Fetch when the region is next in `schedule.upcoming` or on `interstitialstart`, whichever is first. Validate envelope type against the key before merging.                                      |
| DASH `Event@id`, HLS `DATERANGE ID`                                                                                          | `Interstitial.id`                                | Manifest-unique, not an ad id. Never copied into `identifiers`.                                                                                                                                 |
| DASH `@presentationTime` with `@presentationTimeOffset` and `@timescale`, HLS `START-DATE` against `EXT-X-PROGRAM-DATE-TIME` | `startTime` in stream time                       | The adapter converts to the primary element's clock.                                                                                                                                            |
| `Slot.start`, `TrackingEvent.offset`                                                                                         | Unchanged                                        | Already relative to the container.                                                                                                                                                              |
| `ASSET-LIST` top-level `X-AD-CREATIVE-SIGNALING` (`pod`, no `slots`) plus per-asset `slot` envelopes                         | One `resolve()` call                             | Slots are ordered by `ASSETS` order; `Pod.start` offsets non-ad assets before the pod.                                                                                                          |
| Date-range or event with no SVTA payload but a known break class (SCTE-35)                                                   | `Interstitial` with `resolution: 'unresolved'`   | Region exists for UI and restrictions even without ad metadata.                                                                                                                                 |

For `insertion`, the SVTA adapter sets `stitched` when the region's media is in the primary playlist or period, and `inserted` or `replaced` when it arrives through HLS Interstitials (`replaced` when `X-RESUME-OFFSET` is positive). SVTA itself is silent on insertion mode, which is correct; the carriage tells you.

## **11.3 Other adapters**

**HLS Interstitials and DASH Alternative MPD.** Map `X-ASSET-URI` or `X-ASSET-LIST` to `resolve()`, `X-RESUME-OFFSET` to `resumeOffset`, `X-PLAYOUT-LIMIT` to `playoutLimit`, `X-RESTRICT` to `restrictions`, `X-SNAP` to `snap`, `CUE` to `cue` and `playOnce`, `X-TIMELINE-OCCUPIES` and `X-TIMELINE-STYLE` to the UI hints, `X-SKIP-CONTROL-*` to `skipControl`. DASH Alt MPD `insert` maps to `inserted` and `replace` to `replaced`. These adapters require `session.interstitialPlayer`.

**IMA DAI, MediaTailor, Yospace.** Stitched. `CuePoint` or `avail` becomes an `Interstitial` with `insertion: 'stitched'`; `Ad` or `avails[].ads[]` becomes slots; `trackingEvents[].startTimeInSeconds` becomes `TrackingEvent.offset` relative to the slot. The SDK's own beacon firing should be disabled or the session's `beacons` left null, never both active.

**VAST and VMAP (client-side).** `inserted`. VMAP `AdBreak` becomes an `Interstitial` with `cue` from `timeOffset`; VAST `InLine` creatives become slots with `media` from `MediaFile`, `identifiers` from `UniversalAdId`, `tracking` from `TrackingEvents` with `progress` offsets, and `verifications` from `AdVerifications`. Companions become `companion` placements with `linkedSlot`.

## **11.4 InterstitialPlayer**

The contract the session uses to play `inserted` and `replaced` media. Implementations are integrator-provided; a reference implementation uses a second `HTMLMediaElement` with hls.js or dash.js, which is the same two-player structure that AVFoundation and hls.js use.

```typescript
interface InterstitialPlayer extends EventTarget {
  /** Prepare the first slot's media. May be called before the region starts for preloading. */
  load(interstitial: Interstitial, slot: Slot): Promise<void>;
  play(): Promise<void>;
  pause(): void;
  /** Advance to the given slot (used by skip and by seeks within the region). */
  seekToSlot(slot: Slot, offsetWithinSlot: number): void;
  readonly currentTime: number; // seconds within the current slot
  readonly element: HTMLMediaElement | null;
  // Dispatches 'timeupdate', 'ended', 'error', 'canplay' as CustomEvents.
}
```

# **12. Usage Patterns**

## **12.1 SSAI linear (stitched)**

This is the case that motivated v7. The adapter is thin and the player code is UI only.

**Adapter: SVTA date ranges from an HLS player's metadata track**

```typescript
class SvtaHlsAdapter implements AdAdapter {
  readonly name = "svta-hls";
  private host!: AdapterHost;

  attach(host: AdapterHost): void {
    this.host = host;
    const track = findMetadataTextTrack(host.session.primaryElement);
    track.addEventListener("cuechange", () => {
      for (const cue of Array.from(track.cues ?? [])) {
        const dr = parseDateRange(cue); // { id, cls, startTime, duration, attrs }
        if (!isSvtaScheme(dr.cls) || this.host.session.schedule.getById(dr.id))
          continue;

        const envelope = decodeEnvelope(dr.attrs["X-AD-CREATIVE-SIGNALING"]);
        const region = this.host.addInterstitial({
          id: dr.id,
          kind: "ad",
          insertion: "stitched",
          cue: "mid",
          playOnce: false,
          startTime: dr.startTime,
          plannedDuration: dr.duration,
          duration: dr.duration,
          resumeOffset: null,
          playoutLimit: null,
          restrictions: new Set(["jump"]),
          snap: { out: false, in: false },
          timelineOccupancy: "range",
          timelineStyle: "highlight",
          tracking:
            envelope.type === "pod" ? (envelope.payload[0].tracking ?? []) : [],
          metadata: {},
        });

        if (envelope.type === "slot") {
          this.host.resolve(region.id, envelope.payload.map(toSlotInit));
        } else if (
          envelope.type === "pod" &&
          envelope.payload[0].$remote?.slots
        ) {
          this.host.markResolving(region.id);
          void fetchEnvelope(envelope.payload[0].$remote.slots)
            .then((e) =>
              this.host.resolve(region.id, e.payload.map(toSlotInit)),
            )
            .catch((err) => this.host.failResolution(region.id, err));
        }
        // Unknown envelope types fall through and are ignored.
      }
    });
  }

  detach(): void {
    /* remove listener */
  }
}
```

**Player: markers, ad counter, countdown, skip**

```typescript
const session = createAdSession({
  primaryElement: videoEl,
  beacons: new DefaultBeaconSender(),
});
session.attachAdapter(new SvtaHlsAdapter());

session.addEventListener("scheduleupdated", () => {
  progressBar.setMarkers(
    session.schedule.items
      .filter((r) => r.kind === "ad" && r.startTime != null)
      .map((r) => ({
        contentTime: session.time.contentTimeForStreamTime(r.startTime!),
        style: r.timelineStyle,
        occupies: r.timelineOccupancy,
        duration: r.duration,
      })),
  );
});

session.addEventListener("interstitialstart", () => adChrome.show());
session.addEventListener("interstitialend", () => adChrome.hide());

session.addEventListener("timeupdate", (e) => {
  const { slot, interstitial } = e.detail;
  if (slot && interstitial) {
    adChrome.setCounter(slot.index + 1, interstitial.slots.length);
    adChrome.setRemaining(interstitial.remainingTime);
  }
  scrubber.setPosition(e.detail.contentTime, session.time.contentDuration);
});

session.addEventListener("slotskipstatechange", (e) => {
  adChrome.setSkipButton(
    e.detail.skippable,
    e.detail.slot.skipControl?.labelId,
  );
});
adChrome.onSkip(() => session.schedule.currentSlot?.skip());
```

Nothing here references a track, a serving mode, a viewport or a transitional state. The analytics integration is one `tracking` listener or the default sender.

## **12.2 SGAI linear (inserted or replaced)**

Same player code as 12.1, plus an interstitial player:

```typescript
const session = createAdSession({
  primaryElement: videoEl,
  interstitialPlayer: new HlsInterstitialPlayer(secondVideoEl),
  beacons: new DefaultBeaconSender(),
});
session.attachAdapter(new HlsInterstitialsAdapter()); // X-ASSET-LIST, X-RESUME-OFFSET, X-RESTRICT ...
session.addEventListener("contentpause", () => primaryChrome.hide());
session.addEventListener("contentresume", () => primaryChrome.show());
```

The adapter sets `insertion` from `X-RESUME-OFFSET`, resolves slots from the asset list (with SVTA slot envelopes when present), and the session handles the two-player handoff. UI reads `session.time.integrated` so the progress bar continues through the break.

## **12.3 CSAI linear (inserted)**

Identical to 12.2 with a `VmapVastAdapter` in place of the HLS Interstitials adapter and `insertion: 'inserted'` on every region. The adapter requests VAST at `interstitialstart` minus a preload offset and calls `resolve()`; the session waits up to `resolutionTimeout` with primary paused.

## **12.4 Pause placement (reference non-linear format)**

**Adapter**

```typescript
class PauseAdAdapter implements AdAdapter {
  readonly name = "pause";
  private host!: AdapterHost;
  private active: string | null = null;

  attach(host: AdapterHost): void {
    this.host = host;
    const el = host.session.primaryElement;

    el.addEventListener("pause", () => {
      if (host.session.schedule.current) return; // never over a linear break
      window.setTimeout(() => {
        if (!el.paused || this.active) return;
        void adServer.requestPauseAd().then((r) => {
          const p = this.host.addPlacement({
            id: `pause-${Date.now()}`,
            kind: "pause",
            trigger: "userAction",
            startTime: null,
            duration: null,
            minimumExposure: null,
            creative: r.creative, // PlacementCreative
            layout: {
              adViewport: r.fullscreen
                ? { top: 0, right: 0, bottom: 0, left: 0 }
                : { top: 25, right: 25, bottom: 25, left: 25 },
              contentViewport: null,
              transitionDuration: 300,
            },
            audioPolicy: "none",
            interactivity: r.qrCode
              ? {
                  framework: null,
                  simidUrl: null,
                  qrCode: r.qrCode,
                  supportsRemoteControl: true,
                }
              : null,
            refresh: r.refreshMs ? { intervalMs: r.refreshMs } : null,
            linkedSlot: null,
            identifiers: r.identifiers,
            tracking: r.tracking,
            verifications: r.verifications,
            metadata: {},
          });
          this.active = p.id;
          this.host.activatePlacement(p.id);
        });
      }, 2000); // IAB: appear a few seconds after pause, publisher-configurable
    });

    el.addEventListener("play", () => {
      if (this.active) {
        this.host.deactivatePlacement(this.active, "contentResumed");
        this.active = null;
      }
    });
  }

  detach(): void {
    /* remove listeners */
  }
}
```

**Player**

```typescript
session.addEventListener("placementactive", (e) => {
  if (e.detail.placement.kind === "pause") pauseLayer.show(e.detail.placement);
});
session.addEventListener("placementdeactivating", (e) => {
  if (e.detail.placement.kind === "pause")
    pauseLayer.fadeOut(e.detail.placement.layout.transitionDuration);
});
remote.on("back", () => {
  const p = session.placements.getByKind("pause")[0];
  if (p && p.state === "active") p.dismiss("viewerDismissed");
});
```

## **12.5 Overlay placement (reference timed non-linear format)**

An overlay is a `timeline` placement, so the session drives it from the clock like an interstitial, but content keeps playing and the placement may overlap a linear region or another placement.

```typescript
// Adapter: MediaTailor nonLinearAvails, or a SCTE-35 0x38 marker, or a VAST NonLinear response
host.addPlacement({
  id: avail.availId,
  kind: "overlay",
  trigger: "timeline",
  startTime: avail.startTimeInSeconds,
  duration: Math.max(avail.durationInSeconds, 10), // IAB minimum
  minimumExposure: null,
  creative: toPlacementCreative(avail.nonLinearAdsList[0]),
  layout: {
    adViewport: { top: 70, right: 0, bottom: 0, left: 0 },
    contentViewport: null,
    transitionDuration: 500,
  },
  audioPolicy: "none",
  interactivity: null,
  refresh: null,
  linkedSlot: null,
  identifiers: ids,
  tracking: toTrackingEvents(avail.nonLinearAdsList[0].trackingEvents),
  verifications: [],
  metadata: { source: "mediatailor" },
});

// Player
session.addEventListener("placementactive", (e) => {
  if (e.detail.placement.kind === "overlay")
    overlayLayer.show(e.detail.placement);
});
```

## **12.6 Other formats (interface level)**

| Format      | kind / trigger                               | Lifecycle owner               | Layout                                                                         | Notes                                                                                                                                           |
| ----------- | -------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Squeezeback | `squeezeback` / `timeline` or `programmatic` | Session (timeline) or adapter | `adViewport` and `contentViewport` both set; `transitionDuration` 1000-2000 ms | `activating` and `deactivating` are the resize intervals. Player resizes the primary element to `contentViewport`.                              |
| Menu        | `menu` / `userAction`                        | Adapter                       | `adViewport: null`                                                             | Rendered by the platform UI, outside any media element. Session may have no `primaryElement` playing. `dismiss('navigatedAway')` on navigation. |
| Screensaver | `screensaver` / `deviceState`                | Adapter                       | Fullscreen                                                                     | Same shape as pause with `refresh` set and `dismiss('deviceTimeout' \| 'viewerDismissed')`.                                                     |
| In-Scene    | `inScene` / `composited`                     | Session (timeline)            | `adViewport: null`                                                             | Measurement only. `minimumExposure: 3`. The compositing pipeline owns rendering.                                                                |
| Companion   | `companion` / `timeline`                     | Session, via `linkedSlot`     | Integrator-defined                                                             | Activates with the linked slot. See 7.6.                                                                                                        |

# **13. Video.js 10 Integration**

Video.js 10 is a rebuild with three separated parts: a player store composed from features, UI primitives and skins, and a media element or adapter that the store attaches to. The store is flat (`paused`, `volume`, `currentTime`, `pictureInPictureAvailability`), each feature contributes state fields and actions and exports a selector, and components read state through `usePlayer` (React) or `PlayerController` (HTML). The store contains exactly the features passed to `createPlayer`, with no dependency resolution, and features are currently parameterless. The media side is moving toward small capabilities that media implementations provide, so that store features do not reach into platform specifics. Ads integration is on the post-10.0 roadmap and has no design yet.

v7 is event-first and v10 is state-first, so the integration is a projection, not a rewrite. Nothing in Sections 5 through 11 changes; this section adds the pieces that sit between the session and the v10 store.

## **13.1 Mapping**

| v7 concept                                        | v10 home                                                                                                                  | Notes                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `AdSession`, schedule, adapters, beacons          | An ad-aware custom media element (the delegate, 13.2) that wraps the primary media and exposes the session as `media.ads` | Configuration lives on the media, which sidesteps parameterless features.                       |
| `TimeMapping`                                     | The delegate's `currentTime`, `duration` and `seekable` report content time                                               | The stock `timeFeature`, slider and time display work in content time with no UI change.        |
| `restrictions`, snapback                          | The delegate's `currentTime` setter                                                                                       | v10 seeks go through the `seek()` action to `target.currentTime`, so enforcement is one setter. |
| `InterstitialPlayer`                              | Internal to the delegate, which owns a second element for `inserted` and `replaced` regions                               | The v10 container attaches one media; the delegate presents one media while routing to two.     |
| UI state                                          | `adsFeature` (13.3)                                                                                                       | Flat, `ad`-qualified fields; `selectAds` groups them.                                           |
| `Slot.skip()`, `click()`, `AdPlacement.dismiss()` | Actions on `adsFeature`                                                                                                   | Pass-through.                                                                                   |
| `tracking`, `slotprogress`                        | Stay on the session                                                                                                       | Store state is for UI; analytics subscribes to the session.                                     |
| Break markers                                     | `timelineMarkers` state and `TimeSlider.Markers` (13.5)                                                                   | Generic, so chapters can migrate to it later.                                                   |

## **13.2 The ad-aware media delegate**

The delegate is a custom media element built on v10's media mixins. It wraps the primary element, creates the `AdSession` with the integrator's adapters and beacon sender, and presents itself to the store as the media. It is where v7's platform behavior belongs under v10's rules.

Responsibilities:

- **Clock.** `currentTime`, `duration` and `seekable` return the session's content time (Section 10.1). On VOD this hides stitched ad time from every stock component; on live it is the identity. `media.ads.time` still exposes stream time for the few consumers that need it.
- **Seek enforcement.** The `currentTime` setter runs the Section 9.3 rules. A blocked seek is redirected to the region start and the deferred target is replayed after the region completes. `enforceRestrictions: false` turns the setter into a pass-through that still fires `seekblocked`.
- **Two-element handoff.** For `inserted` and `replaced` regions the delegate owns a second `<video>` in its shadow root, implements `InterstitialPlayer` against it, and routes `play()`, `pause()`, `paused`, `currentTime` and the media events to whichever element is active. Store features see one continuous media.
- **Event policy.** The delegate decides which primary and secondary media events reach the store. It forwards `timeupdate` from the active element and suppresses the secondary element's `loadstart`, `emptied` and `durationchange`, which is the concern videojs-contrib-ads solved with redispatch in v8, moved to the layer v10 reserves for it.
- **Capability.** `media.ads: AdSession` is the capability that `adsFeature` reads. Features never construct a session.

```typescript
import { CustomMediaMixin } from "@videojs/core/dom/media/custom-media-element";

class AdMediaElement extends CustomMediaMixin(HTMLElement) {
  readonly ads: AdSession;
  private readonly primary: HTMLVideoElement;
  private readonly secondary: HTMLVideoElement;

  constructor() {
    super();
    this.primary = this.nativeEl; // provided by the mixin
    this.secondary = document.createElement("video");
    this.shadowRoot!.append(this.secondary);
    this.ads = createAdSession({
      primaryElement: this.primary,
      interstitialPlayer: new ElementInterstitialPlayer(this.secondary),
      beacons: readBeaconConfig(this),
    });
    for (const adapter of readAdapters(this)) this.ads.attachAdapter(adapter);
  }

  get currentTime(): number {
    return this.ads.time.contentTime;
  }
  set currentTime(t: number) {
    this.ads.requestSeek(this.ads.time.streamTimeForContentTime(t));
  }
  get duration(): number {
    return this.ads.time.contentDuration ?? this.primary.duration;
  }
  get seekable(): TimeRanges {
    return this.ads.time.contentSeekable;
  }
  get paused(): boolean {
    return this.active.paused;
  }
  play(): Promise<void> {
    return this.active.play();
  }
  pause(): void {
    this.active.pause();
  }
  private get active(): HTMLVideoElement {
    return this.ads.schedule.current?.insertion === "stitched" ||
      !this.ads.schedule.current
      ? this.primary
      : this.secondary;
  }
}
```

`requestSeek` and `contentSeekable` are small additions to `AdSession` and `TimeMapping` that this section introduces; they are the session-side halves of the setter and the `seekable` getter and are listed in 13.6.

## **13.3 The adsFeature and AdsState**

`adsFeature` is a `definePlayerFeature` whose `getSnapshot({ target })` reads `target.ads` and whose `subscribe` listens to session events. The rule for what goes into state: a field belongs in `AdsState` only if a UI component renders from it. Beacon and analytics data stay on the session.

```typescript
interface AdsState {
  adBreakActive: boolean;
  adBreakKind: "ad" | "content" | null;
  adBreakRemaining: number | null;
  adSlotIndex: number | null;
  adSlotCount: number | null;
  adSlotRemaining: number | null;
  adSlotTitle: string | null;
  adSkippable: boolean;
  adSkipLabelId: string | null;
  adSkipAvailableIn: number | null;
  adClickThrough: string | null;
  adContentPaused: boolean;
  adRestrictions: ReadonlyArray<NavigationRestriction>;
  adPlacements: ReadonlyArray<{
    id: string;
    kind: PlacementKind;
    state: PlacementState;
    layout: PlacementLayout;
    remaining: number | null;
  }>;

  skipAd(): void;
  clickAd(): void;
  dismissAdPlacement(id: string, reason?: DismissReason): void;
}
```

Naming follows v10's convention: flat fields, qualified where a bare name would be ambiguous (`pictureInPictureAvailability`, `textTrackList`), actions as verb plus qualified noun (`setVolume`, `requestPictureInPicture`). A nested `ad` object was rejected because v10 selectors use shallow equality, so a new object reference on every `timeupdate` during a break would re-render every component that reads any ad field. `adPlacements` is a shallow projection; a pause-ad layer reads layout and state from the store and fetches creative and interactivity from `media.ads.placements.getById(id)`.

Subscriptions: `scheduleupdated`, `interstitialstart`, `interstitialend`, `slotstart`, `slotend`, `slotskipstatechange`, `contentpause`, `contentresume`, the `placement*` events, and `timeupdate` for the `Remaining` and `adSkipAvailableIn` fields. `slotprogress` and `tracking` are not subscribed.

```typescript
export const adsFeature = definePlayerFeature<AdMediaElement>()({
  initialState: {
    adBreakActive: false,
    adBreakKind: null,
    /* ... */ adPlacements: [],
  },
  getSnapshot: ({ target }) => projectAdsState(target.ads),
  subscribe: ({ target, notify }) => {
    const off = ADS_EVENTS.map((type) => on(target.ads, type, notify));
    return () => off.forEach((f) => f());
  },
  actions: ({ target }) => ({
    skipAd: () => target.ads.schedule.currentSlot?.skip(),
    clickAd: () => target.ads.schedule.currentSlot?.click(),
    dismissAdPlacement: (id, reason) =>
      target.ads.placements.getById(id)?.dismiss(reason),
  }),
});

export const selectAds = createSelector(adsFeature);
```

Dependencies: `adsFeature` renders nothing on its own and does not require other features, but skins that show a countdown or markers also need `timeFeature`. Because v10 has no dependency resolution, the ads preset bundle lists both.

## **13.4 Break signaling contract: the metadata TextTrack**

The SVTA adapter and every other manifest-driven adapter read break signaling from the primary element's `metadata` TextTrack. This is a web standard, it is what Safari does natively, and hls.js deliberately matched it, so the same adapter runs on native, hls.js and SPF playback.

| v10 media                     | DATERANGE | emsg / ID3 | DASH EventStream | Status                                                     |
| ----------------------------- | --------- | ---------- | ---------------- | ---------------------------------------------------------- |
| Native `<video>` (Safari HLS) | Yes       | Yes        | n/a              | Works today (`DataCue`)                                    |
| HlsVideo (hls.js)             | Yes       | Yes        | n/a              | Works today (`VTTCue` with JSON)                           |
| DashVideo (dash.js)           | n/a       | Yes        | Yes              | Adapter shim: subscribe to dash.js events, synthesize cues |
| SPF (`@videojs/spf/hls/*`)    | No        | No         | n/a              | Upstream: `timedMetadataFeature`                           |

SPF composes its HLS engines from named features and already projects HLS chapters into hidden `chapters` tracks that the store picks up; a `timedMetadataFeature` that projects DATERANGE and emsg ID3 into a hidden `metadata` track is the same pattern. Until it lands, SSAI on SPF is not supported by this design; SSAI on hls.js and native is.

Cue timing caveat: hls.js places DATERANGE cues by playlist time derived from PDT, and stitched streams have a discontinuity per ad, so cue placement can drift by up to a second. Adapters treat the cue start as `startTime` and `plannedDuration`, and refine `duration` with `updateInterstitial` once the region's end is observed.

## **13.5 Break markers: timelineMarkers and TimeSlider.Markers**

v10's slider renders sections from the first `chapters` track and has no marker API. The maintainers have an open design issue stating that chapters, thumbnails, cuepoints and ad markers are the same shape of problem and are handled ad hoc or not at all. Riding the chapters track was considered and rejected: it collides with content chapters, a break splits a program chapter in two, and chapters are ranges while a stitched break in VOD content time is a point.

The design is a generic marker surface that the ads feature contributes to and that chapters can migrate to later:

```typescript
interface TimelineMarker {
  id: string;
  time: number; // content time, seconds
  duration: number | null; // null or 0 renders as a point
  kind: "ad" | "content" | "chapter" | "cuepoint" | (string & {});
  label: string | null;
  played: boolean;
  style: "highlight" | "primary";
}

// Contributed by adsFeature; other features may contribute to the same array.
interface TimelineMarkersState {
  timelineMarkers: ReadonlyArray<TimelineMarker>;
}
```

`adsFeature` maps each `Interstitial` with `kind === 'ad'` and a known `startTime` to a marker at `contentTimeForStreamTime(startTime)`, with `duration` from `timelineOccupancy` (`point` gives null, `range` gives the region duration), `style` from `timelineStyle`, and `played` from the region. Markers move when a stitched region's duration resolves late, which is correct behavior for the bar.

`TimeSlider.Markers` is a new slider part, shaped like `TimeSlider.Chapters`: it renders one element per marker from `timelineMarkers`, positioned by `time` and `duration` against the slider's range, with `data-kind`, `data-played` and `data-style` attributes for styling. It does not seek on click by default; ad markers are not navigation targets when `jump` is restricted.

## **13.6 Additions to the core API introduced by this section**

| Addition                            | Where        | Purpose                                                                                                                                     |
| ----------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `AdSession.requestSeek(streamTime)` | Section 6.1  | Session-side seek that applies Section 9.3 rules and returns the stream time actually sought. The delegate's `currentTime` setter calls it. |
| `TimeMapping.contentSeekable`       | Section 10.1 | Seekable ranges in content time, for the delegate's `seekable` getter.                                                                      |
| `AdSessionInit.timeline`            | Section 6.1  | Forces VOD or live time mapping.                                                                                                            |

## **13.7 Upstream items**

1. `timedMetadataFeature` for `@videojs/spf/hls`: project DATERANGE and emsg ID3 into a hidden `metadata` TextTrack.
2. `timelineMarkers` state and `TimeSlider.Markers`, proposed on the v10 timed-metadata design issue as the generic model it asks for.
3. The ad-aware media delegate and `adsFeature` as the reference ads integration, since the roadmap lists one and none exists.

# **14. Migration from v6**

| v6 concept                                                           | v7 disposition                                                                                        | Notes                                                                                                                                                                                              |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AdTrackList, AdTrack                                                 | Removed                                                                                               | Replaced by `AdSession.schedule` and `AdSession.placements`. A deprecated `tracksByFormat()` helper can return filtered views during migration.                                                    |
| AdTrack.servingMode, AdTrackList.linearServingMode                   | Removed                                                                                               | `Interstitial.insertion` per region.                                                                                                                                                               |
| AdFormat enum                                                        | Split                                                                                                 | `LINEAR` is implicit in Layer 1. The six non-linear values become `PlacementKind`; `companion` added.                                                                                              |
| AdCue (LINEAR track)                                                 | `Interstitial`                                                                                        | Gains insertion, resumeOffset, playoutLimit, restrictions, snap, timeline hints, played, resolution; loses ACTIVATING, DEACTIVATING, dismissReason, triggerType.                                   |
| AdCue (non-linear tracks)                                            | `AdPlacement`                                                                                         | Keeps triggerType (as `trigger`), dismissReason, transitional states.                                                                                                                              |
| Ad (linear)                                                          | `Slot`                                                                                                | Fields renamed to SVTA names; `creative.adId` and `creativeId` become `identifiers[]`; `skippable`/`skipOffset` become `skipControl`; viewports, audioPolicy, interactivity, companionAds removed. |
| Ad (non-linear)                                                      | `AdPlacement`                                                                                         | One placement per presentation.                                                                                                                                                                    |
| AdCreative                                                           | `PlacementCreative`                                                                                   | Identifiers moved out; `assetUrl`/`mimeType` become `media: MediaReference[]`.                                                                                                                     |
| AdViewport                                                           | `Viewport`                                                                                            | Unchanged shape.                                                                                                                                                                                   |
| SqueezebackMetadata                                                  | `PlacementLayout`                                                                                     | `contentViewport` and `transitionDuration` folded in; `audioEnabled` becomes `audioPolicy`.                                                                                                        |
| AdInteractivity, QRCodeInfo                                          | Unchanged                                                                                             | Placement layer only.                                                                                                                                                                              |
| AdTriggerType                                                        | `PlacementTrigger`                                                                                    | Lower camel case.                                                                                                                                                                                  |
| DismissReason                                                        | `DismissReason`                                                                                       | Placement layer only.                                                                                                                                                                              |
| AdCueState                                                           | `InterstitialState` (Layer 1), `PlacementState` (Layer 2)                                             | Transitional states only in Layer 2.                                                                                                                                                               |
| AdState                                                              | `SlotState`                                                                                           | Lower-cased.                                                                                                                                                                                       |
| Named quartile events (`firstquartile`, `midpoint`, `thirdquartile`) | `slotprogress` plus `tracking`                                                                        | Quartiles are `progress` records; UI gets `fraction`.                                                                                                                                              |
| `impression`, `click`, `skip` events on Ad                           | `tracking`, `slotclick`, `slotskip`                                                                   | Same information, flat delivery.                                                                                                                                                                   |
| Per-object EventTarget                                               | Session-level events with `detail`                                                                    | Resolves the bubbling question.                                                                                                                                                                    |
| `videoElement.adTracks` attachment                                   | `createAdSession({ primaryElement })`                                                                 | Resolves the attachment question.                                                                                                                                                                  |
| adapter.createCue / activate / deactivate                            | `host.addInterstitial` / `resolve`; `host.addPlacement` / `activatePlacement` / `deactivatePlacement` | Adapters no longer drive linear lifecycle.                                                                                                                                                         |

Recommended order: port the existing SSAI implementation first (12.1), which should delete code; then an HLS Interstitials adapter with an interstitial player (12.2); then a pause adapter (12.4); then client-side VAST (12.3).

# **15. Open Questions**

- **Default beacon sender.** Should the reference library ship a `DefaultBeaconSender` with VAST macro replacement, or is beacon transport always the integrator's? Shipping one makes 12.1 complete out of the box but duplicates what SDK-based adapters already do.
- **InterstitialPlayer ownership of the second element.** Should the session create and manage the second `HTMLMediaElement` (simpler for integrators) or receive one (required on platforms with a single hardware decoder)?
- **Resolution timeout policy.** 2 s default for `inserted` and `replaced` regions is a guess. Needs measurement against real ad-server latencies.
- **Concurrent placements.** Should the session enforce IAB exclusivity rules (for example no overlay during a squeezeback), or leave arbitration to the integrator?
- **MultiViewOffer.** The SVTA working draft adds an `offer` envelope type with an undefined MultiViewOffer object. When defined, it belongs in Layer 2 as a timed placement kind. Until then adapters ignore it.
- **Live schedule eviction.** Evicting completed regions behind the seekable window loses `played` history on DVR rewinds that re-enter the window. Decide whether to keep a bounded history.
- **`kind: 'content'` regions and tracking.** Bumpers and recaps carried as interstitials may have tracking in some systems. Decide whether `tracking` fires for non-ad regions or only for `kind: 'ad'`.
- **Menu placements without a media element.** `AdSession` requires `primaryElement`. Either make it optional or define a separate `MenuAdSession`.

# **16. Next Steps**

- Circulate v7 for review, with particular attention to Sections 5.1 (insertion modes), 6.3 (Interstitial fields) and 11.1 (host contract).
- Produce `ad-api.d.ts` from Sections 5 through 8 and 11. The code blocks in this document are the starting point and should compile with minor additions.
- Port the existing SSAI implementation to Section 12.1. Record the line-count delta; it is the first validation of the redesign.
- Build the SVTA2053 reference adapter against both scheme URIs and both envelope versions, including `$remote` resolution and unknown-type tolerance.
- Build an HLS Interstitials adapter and a reference `InterstitialPlayer` on hls.js; validate `resumeOffset`, `restrictions` and `time.integrated` against Apple's and hls.js's behavior.
- Build the pause adapter as the first Layer 2 format, then overlay.
- Track the IAB Tech Lab CTV signaling guidance and the SVTA working draft for changes to `PlacementKind` and the `offer` object.
- Video.js 10: build the ad-aware media delegate and `adsFeature` (Section 13) against the SSAI port; contribute an SPF `timedMetadataFeature` that projects DATERANGE and emsg ID3 into a hidden `metadata` track; propose `timelineMarkers` and `TimeSlider.Markers` on the v10 timed-metadata design issue.
