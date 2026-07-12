import React from 'react';
import { Text } from 'react-native';
import { useCallTimer } from '../../hooks/useCallTimer';
import { typography } from '../../theme/typography';

type Props = { running?: boolean; startAt?: number | null; style?: any };

export function CallTimer({ running, startAt, style }: Props) {
  // Prefer an absolute start timestamp (answeredAt) so the timer shows true
  // elapsed time and survives app backgrounding; fall back to the boolean.
  const arg: number | boolean = startAt != null ? startAt : !!running;
  const { formatted } = useCallTimer(arg);
  const show = startAt != null || !!running;
  return (
    <Text style={[typography.callTimer, { color: 'rgba(255,255,255,0.7)' }, style]}>
      {show ? formatted : '––:––'}
    </Text>
  );
}
