import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { spacing } from '../../theme/spacing';

type Props = {
  children: React.ReactNode;
  /** Horizontal padding for the chip row (default matches most tab screens). */
  paddingHorizontal?: number;
  /** Space below the filter row. */
  marginBottom?: number;
};

/**
 * Horizontal filter chips wrapped in a ScrollView.
 *
 * The enclosed chips own their 36-px height. Do not pin the ScrollView height:
 * Android clips the bottom of rounded active backgrounds when the viewport is
 * even a pixel tighter than the rendered border curve. Let the content padding
 * define the row height instead.
 * The bottom-clipping Android bug is addressed inside each chip via
 * `includeFontPadding: false` on the label — do not re-introduce a tighter
 * height cap here.
 */
export function HorizontalFilterScroll({
  children,
  paddingHorizontal = spacing['5'],
  marginBottom = spacing['2'],
}: Props) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      bounces={false}
      alwaysBounceHorizontal={false}
      alwaysBounceVertical={false}
      overScrollMode="never"
      style={[styles.scroller, { marginBottom }]}
      contentContainerStyle={[styles.row, { paddingHorizontal }]}
    >
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroller: {
    flexGrow: 0,
    flexShrink: 0,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 8,
    paddingBottom: 12,
  },
});
