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
 * IMPORTANT: do NOT constrain this scroller to a fixed height. On Android,
 * if the ScrollView height is tighter than the pill's rendered box (which
 * includes the 1px border AND the hidden font metrics padding inside
 * `<Text>`), the bottom of the rounded border gets clipped. Let the row
 * size itself from the children, and add a tiny `paddingVertical` so the
 * border curves have subpixel breathing room.
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
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
});
