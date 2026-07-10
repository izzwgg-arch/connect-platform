import React from 'react';
import { Text } from 'react-native';
import { useCallTimer } from '../../hooks/useCallTimer';
import { typography } from '../../theme/typography';

type Props = { running: boolean; connectedAt: number | null; style?: any };

export function CallTimer({ running, connectedAt, style }: Props) {
  const { formatted } = useCallTimer(connectedAt, running);
  return (
    <Text style={[typography.callTimer, { color: 'rgba(255,255,255,0.7)' }, style]}>
      {running ? formatted : '––:––'}
    </Text>
  );
}
