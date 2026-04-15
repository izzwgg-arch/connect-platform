/**
 * ConnectIcon — vector rendition of the Connect app icon.
 *
 * Matches the generated app-store icon: blue→cyan→violet gradient rounded-square,
 * white phone handset, three outward signal arcs to the upper-right.
 * Works at any size without image assets.
 */
import React from 'react';
import { View, StyleSheet } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

interface ConnectIconProps {
  /** Overall icon bounding box in dp. Default: 88. */
  size?: number;
  /** Override corner radius (default: 22% of size). */
  borderRadius?: number;
}

export function ConnectIcon({ size = 88, borderRadius }: ConnectIconProps) {
  const br = borderRadius ?? Math.round(size * 0.22);
  const phoneSize = Math.round(size * 0.46);

  // Signal arc dimensions — three arcs radiating from phone upper-right
  const arcBase = Math.round(size * 0.12);
  const arcBorderWidth = Math.max(1.5, Math.round(size * 0.025));

  // Arc offset from phone icon center
  const arcOffsetX = Math.round(size * 0.08);
  const arcOffsetY = Math.round(size * 0.06);

  return (
    <View style={{ width: size, height: size, borderRadius: br, ...SHADOW }}>
      <LinearGradient
        colors={['#1d4ed8', '#2563eb', '#0ea5e9', '#7c3aed']}
        start={{ x: 0.05, y: 0.0 }}
        end={{ x: 0.95, y: 1.0 }}
        style={[styles.container, { width: size, height: size, borderRadius: br }]}
      >
        {/* Subtle top-left inner highlight — premium glass feel */}
        <View
          pointerEvents="none"
          style={[styles.innerHighlight, { borderRadius: br }]}
        />

        {/* Phone + arcs layout */}
        <View style={styles.iconGroup}>
          {/* Phone handset */}
          <Ionicons
            name="call"
            size={phoneSize}
            color="#ffffff"
            style={styles.phone}
          />

          {/* Signal arcs positioned top-right of phone */}
          <View
            pointerEvents="none"
            style={[
              styles.arcsWrap,
              {
                top: '50%',
                left: '50%',
                marginTop: -arcOffsetY - arcBase * 3.2,
                marginLeft: arcOffsetX,
              },
            ]}
          >
            {([
              { scale: 1.0, opacity: 0.95 },
              { scale: 1.65, opacity: 0.65 },
              { scale: 2.3, opacity: 0.35 },
            ] as const).map(({ scale, opacity }, i) => {
              const r = arcBase * scale;
              return (
                <View
                  key={i}
                  style={{
                    position: 'absolute',
                    width: r * 2,
                    height: r * 2,
                    borderRadius: r,
                    borderWidth: arcBorderWidth,
                    borderColor: `rgba(255,255,255,${opacity})`,
                    // Show only the top-right quarter
                    borderLeftColor: 'transparent',
                    borderBottomColor: 'transparent',
                    transform: [{ rotate: '-10deg' }],
                    // center each arc on the same anchor point
                    top: -r,
                    left: -r,
                  }}
                />
              );
            })}
          </View>
        </View>
      </LinearGradient>
    </View>
  );
}

/** Subtle drop-shadow so the icon lifts off dark backgrounds. */
const SHADOW = {
  shadowColor: '#0ea5e9',
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.35,
  shadowRadius: 12,
  elevation: 12,
};

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  innerHighlight: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Diagonal white overlay — gives glass/depth impression
    backgroundColor: 'rgba(255,255,255,0.07)',
  },
  iconGroup: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  phone: {
    // Slight vertical nudge to optically center phone + arcs together
    marginRight: 0,
  },
  arcsWrap: {
    position: 'absolute',
  },
});
