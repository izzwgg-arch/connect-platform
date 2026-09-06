import { useWindowDimensions } from 'react-native';
import { phoneLayoutWidth } from './phoneLayoutWidth';

/**
 * Live, portrait-clamped window width. See ./phoneLayoutWidth.ts for why a
 * module-scope `Dimensions.get('window')` must never be used for this.
 */
export function usePhoneLayoutWidth(): number {
  const { width, height } = useWindowDimensions();
  return phoneLayoutWidth(width, height);
}
