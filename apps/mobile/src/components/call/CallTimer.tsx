import React from 'react';
import { Text } from 'react-native';
import { useCallTimer } from '../../hooks/useCallTimer';
import { typography } from '../../theme/typography';

type Props = { running: boolean; style?: any };

export function CallTimer({ running, style }: Props) {
  const { formatted } = useCallTimer(running);
  return (
    <Text style={[typography.callTimer, { color: 'rgba(255,255,255,0.7)' }, style]}>
      {running ? formatted : '––:––'}
    </Text>
  );
}
