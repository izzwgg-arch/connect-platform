import React, { useRef, useEffect } from 'react';
import {
  TouchableOpacity,
  Animated,
  View,
  Text,
  StyleSheet,
  Vibration,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';

type CallButtonVariant = 'answer' | 'decline' | 'mute' | 'speaker' | 'hold' | 'keypad' | 'transfer' | 'add' | 'end' | 'neutral';

type Props = {
  variant: CallButtonVariant;
  onPress: () => void;
  active?: boolean;
  label?: string;
  disabled?: boolean;
  size?: 'sm' | 'md' | 'lg';
};

const CONFIG: Record<CallButtonVariant, {
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon?: keyof typeof Ionicons.glyphMap;
  defaultBg: string;
  activeBg: string;
  iconColor: string;
  activeIconColor?: string;
  glow?: string;
}> = {
  answer: {
    icon: 'call',
    defaultBg: '#22c55e',
    activeBg: '#16a34a',
    iconColor: '#fff',
    glow: 'rgba(34, 197, 94, 0.5)',
  },
  decline: {
    icon: 'call',
    defaultBg: '#ef4444',
    activeBg: '#dc2626',
    iconColor: '#fff',
    glow: 'rgba(239, 68, 68, 0.5)',
  },
  end: {
    icon: 'call',
    defaultBg: '#ef4444',
    activeBg: '#dc2626',
    iconColor: '#fff',
    glow: 'rgba(239, 68, 68, 0.4)',
  },
  mute: {
    icon: 'mic-outline',
    activeIcon: 'mic-off-outline',
    defaultBg: 'rgba(255,255,255,0.1)',
    activeBg: 'rgba(255,255,255,0.2)',
    iconColor: 'rgba(255,255,255,0.9)',
  },
  speaker: {
    icon: 'volume-high-outline',
    activeIcon: 'volume-high',
    defaultBg: 'rgba(255,255,255,0.1)',
    activeBg: 'rgba(59,130,246,0.3)',
    iconColor: 'rgba(255,255,255,0.9)',
    activeIconColor: '#3b82f6',
  },
  hold: {
    icon: 'pause-outline',
    activeIcon: 'play-outline',
    defaultBg: 'rgba(255,255,255,0.1)',
    activeBg: 'rgba(245,158,11,0.25)',
    iconColor: 'rgba(255,255,255,0.9)',
    activeIconColor: '#f59e0b',
  },
  keypad: {
    icon: 'keypad-outline',
    defaultBg: 'rgba(255,255,255,0.1)',
    activeBg: 'rgba(255,255,255,0.2)',
    iconColor: 'rgba(255,255,255,0.9)',
  },
  transfer: {
    icon: 'swap-horizontal-outline',
    defaultBg: 'rgba(255,255,255,0.1)',
    activeBg: 'rgba(255,255,255,0.2)',
    iconColor: 'rgba(255,255,255,0.9)',
  },
  add: {
    icon: 'person-add-outline',
    defaultBg: 'rgba(255,255,255,0.1)',
    activeBg: 'rgba(255,255,255,0.2)',
    iconColor: 'rgba(255,255,255,0.9)',
  },
  neutral: {
    icon: 'ellipsis-horizontal',
    defaultBg: 'rgba(255,255,255,0.1)',
    activeBg: 'rgba(255,255,255,0.2)',
    iconColor: 'rgba(255,255,255,0.9)',
  },
};

const SIZES = { sm: 48, md: 60, lg: 72 };
const ICON_SIZES = { sm: 20, md: 26, lg: 32 };

export function CallButton({ variant, onPress, active, label, disabled, size = 'md' }: Props) {
  const { colors } = useTheme();
  const config = CONFIG[variant];
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(0)).current;

  // Pulse for answer button
  useEffect(() => {
    if (variant === 'answer') {
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(glowAnim, { toValue: 1, duration: 900, useNativeDriver: true }),
          Animated.timing(glowAnim, { toValue: 0, duration: 900, useNativeDriver: true }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }
  }, [variant]);

  const dim = SIZES[size];
  const iconSize = ICON_SIZES[size];
  const bg = active ? config.activeBg : config.defaultBg;
  const iconColor = active ? (config.activeIconColor ?? config.iconColor) : config.iconColor;
  const icon = active && config.activeIcon ? config.activeIcon : config.icon;
  const rotation = variant === 'decline' ? '135deg' : variant === 'end' ? '135deg' : '0deg';

  const handlePress = () => {
    Animated.sequence([
      Animated.timing(scaleAnim, { toValue: 0.88, duration: 80, useNativeDriver: true }),
      Animated.timing(scaleAnim, { toValue: 1, duration: 120, useNativeDriver: true }),
    ]).start();
    onPress();
  };

  return (
    <View style={styles.wrapper}>
      {config.glow && variant === 'answer' && (
        <Animated.View
          style={[
            styles.glow,
            {
              width: dim + 20,
              height: dim + 20,
              borderRadius: (dim + 20) / 2,
              backgroundColor: config.glow,
              opacity: glowAnim,
            },
          ]}
        />
      )}
      <Animated.View style={{ transform: [{ scale: scaleAnim }] }}>
        <TouchableOpacity
          onPress={handlePress}
          disabled={disabled}
          activeOpacity={0.8}
          style={[
            styles.button,
            {
              width: dim,
              height: dim,
              borderRadius: dim / 2,
              backgroundColor: bg,
              opacity: disabled ? 0.4 : 1,
            },
          ]}
        >
          <Ionicons
            name={icon}
            size={iconSize}
            color={iconColor}
            style={[
              variant === 'decline' || variant === 'end'
                ? { transform: [{ rotate: rotation }] }
                : {},
            ]}
          />
        </TouchableOpacity>
      </Animated.View>
      {label && (
        <Text style={[styles.label, { color: 'rgba(255,255,255,0.7)' }]}>{label}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
  },
  glow: {
    position: 'absolute',
    zIndex: -1,
  },
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    marginTop: 6,
    fontSize: 11,
    fontWeight: '500',
    letterSpacing: 0.3,
  },
});
