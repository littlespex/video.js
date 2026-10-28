import {
  type TimelineMarkerGeometry,
  TimeSliderMarkerCSSVars,
  TimeSliderMarkerDataAttrs,
  TimeSliderMarkersCore,
} from '@videojs/core';
import { applyStateDataAttrs, selectTime, selectTimelineMarkers } from '@videojs/core/dom';
import type { PropertyValues } from '@videojs/element';
import { ContextConsumer } from '@videojs/element/context';
import { cloneTemplateRoot, getTemplateElement, getTemplateRoot } from '@videojs/utils/dom';

import { playerContext } from '../../player/context';
import { PlayerController } from '../../player/controller';
import { sliderContext } from '../slider/context';
import { UIElement } from '../ui-element';

/**
 * Renders the player's timeline markers (ad breaks today) along the time slider by cloning a light-DOM template once
 * per marker. The required template must contain exactly one HTML root element. Each clone is positioned by the
 * marker's content time and span and carries `data-kind`, `data-played`, `data-style` and `data-point` for styling.
 *
 * Unlike the chapters part, markers do not partition the track and are not seek targets: ad markers restrict `jump`, so
 * the element is inert.
 *
 * @internal
 */
export class TimeSliderMarkersElement extends UIElement {
  static readonly tagName = 'media-time-slider-markers';

  readonly #core = new TimeSliderMarkersCore();
  readonly #slider = new ContextConsumer(this, { context: sliderContext, subscribe: true });
  readonly #markers = new PlayerController(this, playerContext, selectTimelineMarkers);
  readonly #time = new PlayerController(this, playerContext, selectTime);
  readonly #rendered = new Map<string, HTMLElement>();
  #templateRoot: HTMLElement | null = null;
  #templateChecked = false;

  override connectedCallback(): void {
    super.connectedCallback();
    this.setAttribute('aria-hidden', 'true');
  }

  protected override update(_changed: PropertyValues): void {
    super.update(_changed);

    const slider = this.#slider.value;
    const duration = this.#time.value?.duration ?? 0;
    const templateRoot = this.#getTemplateRoot();

    if (!slider) return;

    applyStateDataAttrs(this, slider.state, slider.stateAttrMap);

    if (!templateRoot) return;

    const markers = this.#markers.value?.timelineMarkers ?? [];
    const geometry = this.#core.getGeometry(markers, duration);
    const next = new Map<string, HTMLElement>();

    for (const marker of geometry) {
      let root = this.#rendered.get(marker.key) ?? cloneTemplateRoot(templateRoot, this.ownerDocument);

      this.#place(root, marker);
      applyStateDataAttrs(root, marker, TimeSliderMarkerDataAttrs);

      next.set(marker.key, root);
    }

    for (const [key, root] of this.#rendered) {
      if (!next.has(key)) root.remove();
    }

    for (const root of next.values()) {
      if (root.parentNode !== this) this.appendChild(root);
    }

    this.#rendered.clear();

    for (const [key, root] of next) this.#rendered.set(key, root);
  }

  #place(root: HTMLElement, marker: TimelineMarkerGeometry): void {
    root.style.setProperty(TimeSliderMarkerCSSVars.start, marker.startPercent);
    root.style.setProperty(TimeSliderMarkerCSSVars.width, marker.widthPercent);

    const label = marker.label ?? '';

    if (root.getAttribute('aria-label') !== label) {
      if (label) root.setAttribute('aria-label', label);
      else root.removeAttribute('aria-label');
    }
  }

  #getTemplateRoot(): HTMLElement | null {
    if (this.#templateChecked) return this.#templateRoot;

    const template = getTemplateElement(this);

    if (!template) {
      for (const node of [...this.childNodes]) node.remove();

      return null;
    }

    this.#templateChecked = true;
    const root = getTemplateRoot(template);

    for (const node of [...this.childNodes]) {
      if (node !== template) node.remove();
    }

    if (root?.namespaceURI !== 'http://www.w3.org/1999/xhtml') {
      if (__DEV__) {
        console.warn(`[${this.localName}] template must contain exactly one HTML root element.`);
      }

      return null;
    }

    // SAFETY: the namespace check above rejects anything that is not an HTML element.
    this.#templateRoot = root as HTMLElement;
    return this.#templateRoot;
  }
}
