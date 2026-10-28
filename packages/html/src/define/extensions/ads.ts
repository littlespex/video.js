import { MediaAdsExtension } from '../../extensions/ads';
import { safeDefine } from '../../registration/safe-define';

export { MediaAdsExtension };

safeDefine(MediaAdsExtension);

declare global {
  interface HTMLElementTagNameMap {
    [MediaAdsExtension.tagName]: MediaAdsExtension;
  }
}
