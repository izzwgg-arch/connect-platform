import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  ActivityIndicator,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuth } from '../../context/AuthContext';
import { useSip } from '../../context/SipContext';
import { useTheme } from '../../context/ThemeContext';
import { redeemMobileProvisioningToken, exchangeQrToken } from '../../api/client';
import { typography } from '../../theme/typography';
import { spacing, radius } from '../../theme/spacing';

type QrPayload = { type: string; token: string; apiBaseUrl?: string };

type Phase = 'scanning' | 'processing' | 'success' | 'error';

export function QrProvisionScreen() {
  const { colors, isDark } = useTheme();
  const { token: authToken, setTokenFromQr } = useAuth();
  const sip = useSip();
  const insets = useSafeAreaInsets();
  const nav = useNavigation<NativeStackNavigationProp<any>>();

  const [permission, requestPermission] = useCameraPermissions();
  const [phase, setPhase] = useState<Phase>('scanning');
  const [message, setMessage] = useState('');
  const [scanned, setScanned] = useState(false);
  const successAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!permission?.granted) {
      requestPermission();
    }
  }, []);

  const handleSuccess = () => {
    Animated.spring(successAnim, { toValue: 1, useNativeDriver: true, speed: 14, bounciness: 10 }).start();
    setPhase('success');
    setTimeout(() => {
      try {
        nav.navigate('Tabs' as any);
      } catch {
        nav.goBack();
      }
    }, 1800);
  };

  const handleBarCodeScanned = async ({ data }: { data: string }) => {
    if (scanned || phase !== 'scanning') return;
    setScanned(true);
    setPhase('processing');

    try {
      const payload: QrPayload = JSON.parse(data);

      if (payload.type !== 'MOBILE_PROVISIONING') {
        throw new Error('QR code is not a Connect provisioning QR. Try again.');
      }

      let sipPassword: string;
      let provisioning: any;

      if (authToken) {
        // Logged in: just redeem the provisioning token
        const result = await redeemMobileProvisioningToken(authToken, {
          token: payload.token,
          apiBaseUrl: payload.apiBaseUrl,
          deviceInfo: { platform: 'ANDROID' },
        });
        sipPassword = result.sipPassword;
        provisioning = result.provisioning;
      } else {
        // Not logged in: full QR exchange (get session token + SIP bundle)
        const result = await exchangeQrToken(
          payload.token,
          { platform: 'ANDROID' },
          payload.apiBaseUrl
        );
        await setTokenFromQr(result.sessionToken);
        sipPassword = result.sipPassword;
        provisioning = result.provisioning;
      }

      await sip.saveProvisioning({
        sipUsername: provisioning.sipUsername,
        sipPassword,
        sipWsUrl: provisioning.sipWsUrl,
        sipDomain: provisioning.sipDomain,
        outboundProxy: provisioning.outboundProxy,
        iceServers: provisioning.iceServers,
        dtmfMode: provisioning.dtmfMode,
      });

      await sip.register().catch(() => undefined);
      handleSuccess();
    } catch (e: any) {
      setMessage(e?.message || 'Provisioning failed. Try again.');
      setPhase('error');
    }
  };

  const retry = () => {
    setScanned(false);
    setPhase('scanning');
    setMessage('');
  };

  if (!permission) {
    return (
      <View style={[styles.center, { backgroundColor: '#090e18' }]}>
        <ActivityIndicator color="#3b82f6" />
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <LinearGradient colors={['#090e18', '#111827']} style={styles.container}>
        <View style={[styles.center, { paddingBottom: insets.bottom + 40 }]}>
          <View style={[styles.iconWrap, { backgroundColor: 'rgba(59,130,246,0.1)', borderColor: 'rgba(59,130,246,0.25)' }]}>
            <Ionicons name="camera-outline" size={36} color="#3b82f6" />
          </View>
          <Text style={[typography.h2, { color: '#f0f4ff', textAlign: 'center', marginTop: 20 }]}>
            Camera Access Needed
          </Text>
          <Text style={[typography.body, { color: 'rgba(136,153,187,0.9)', textAlign: 'center', marginTop: 10 }]}>
            Grant camera permission to scan your provisioning QR code.
          </Text>
          <TouchableOpacity style={styles.btn} onPress={() => requestPermission()} activeOpacity={0.85}>
            <Text style={styles.btnText}>Grant Permission</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => nav.goBack()} style={{ marginTop: 16 }}>
            <Text style={{ color: 'rgba(136,153,187,0.8)', fontSize: 14 }}>Go Back</Text>
          </TouchableOpacity>
        </View>
      </LinearGradient>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: '#000' }]}>
      {/* Camera */}
      {phase === 'scanning' && (
        <CameraView
          style={StyleSheet.absoluteFill}
          onBarcodeScanned={handleBarCodeScanned}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        />
      )}

      {/* Overlay */}
      <LinearGradient
        colors={['rgba(9,14,24,0.85)', 'transparent', 'rgba(9,14,24,0.85)']}
        style={StyleSheet.absoluteFill}
      />

      {/* Top bar */}
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <TouchableOpacity
          onPress={() => nav.goBack()}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        >
          <Ionicons name="close" size={26} color="#f0f4ff" />
        </TouchableOpacity>
        <Text style={[typography.h4, { color: '#f0f4ff' }]}>Pair Device</Text>
        <View style={{ width: 26 }} />
      </View>

      {/* Scanner frame / state */}
      <View style={styles.frameArea}>
        {phase === 'scanning' && (
          <>
            <View style={[styles.scanFrame, { borderColor: 'rgba(59,130,246,0.8)' }]}>
              <View style={[styles.corner, styles.cornerTL, { borderColor: '#3b82f6' }]} />
              <View style={[styles.corner, styles.cornerTR, { borderColor: '#3b82f6' }]} />
              <View style={[styles.corner, styles.cornerBL, { borderColor: '#3b82f6' }]} />
              <View style={[styles.corner, styles.cornerBR, { borderColor: '#3b82f6' }]} />
            </View>
            <Text style={[typography.body, { color: 'rgba(240,244,255,0.85)', textAlign: 'center', marginTop: 20 }]}>
              Scan the QR code shown in{'\n'}the Connect portal
            </Text>
          </>
        )}

        {phase === 'processing' && (
          <View style={styles.stateBox}>
            <ActivityIndicator size="large" color="#3b82f6" />
            <Text style={[typography.h4, { color: '#f0f4ff', marginTop: 20 }]}>Provisioning…</Text>
            <Text style={[typography.body, { color: 'rgba(136,153,187,0.9)', marginTop: 8 }]}>
              Configuring your SIP extension
            </Text>
          </View>
        )}

        {phase === 'success' && (
          <Animated.View style={[styles.stateBox, { transform: [{ scale: successAnim }], opacity: successAnim }]}>
            <View style={[styles.successCircle, { backgroundColor: 'rgba(16,185,129,0.15)', borderColor: 'rgba(16,185,129,0.4)' }]}>
              <Ionicons name="checkmark" size={48} color="#10b981" />
            </View>
            <Text style={[typography.h2, { color: '#f0f4ff', marginTop: 20 }]}>Device Paired!</Text>
            <Text style={[typography.body, { color: 'rgba(136,153,187,0.9)', marginTop: 8 }]}>
              Your extension is ready to use.
            </Text>
          </Animated.View>
        )}

        {phase === 'error' && (
          <View style={styles.stateBox}>
            <View style={[styles.successCircle, { backgroundColor: 'rgba(244,63,94,0.15)', borderColor: 'rgba(244,63,94,0.4)' }]}>
              <Ionicons name="alert-circle-outline" size={48} color="#f43f5e" />
            </View>
            <Text style={[typography.h3, { color: '#f0f4ff', marginTop: 20, textAlign: 'center' }]}>
              Provisioning Failed
            </Text>
            <Text style={[typography.body, { color: 'rgba(136,153,187,0.9)', marginTop: 10, textAlign: 'center' }]}>
              {message}
            </Text>
            <TouchableOpacity style={[styles.btn, { marginTop: 24 }]} onPress={retry} activeOpacity={0.85}>
              <Text style={styles.btnText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Bottom hint */}
      {phase === 'scanning' && (
        <View style={[styles.bottomHint, { paddingBottom: insets.bottom + 20 }]}>
          <Ionicons name="information-circle-outline" size={16} color="rgba(136,153,187,0.7)" style={{ marginRight: 6 }} />
          <Text style={[typography.caption, { color: 'rgba(136,153,187,0.7)' }]}>
            The QR code expires in 2 minutes. Refresh it in the portal if needed.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing['5'],
    paddingBottom: spacing['3'],
    zIndex: 10,
  },
  frameArea: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanFrame: {
    width: 220,
    height: 220,
    borderRadius: 8,
    borderWidth: 1,
    backgroundColor: 'transparent',
    position: 'relative',
  },
  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderWidth: 3,
  },
  cornerTL: { top: -2, left: -2, borderBottomWidth: 0, borderRightWidth: 0, borderTopLeftRadius: 6 },
  cornerTR: { top: -2, right: -2, borderBottomWidth: 0, borderLeftWidth: 0, borderTopRightRadius: 6 },
  cornerBL: { bottom: -2, left: -2, borderTopWidth: 0, borderRightWidth: 0, borderBottomLeftRadius: 6 },
  cornerBR: { bottom: -2, right: -2, borderTopWidth: 0, borderLeftWidth: 0, borderBottomRightRadius: 6 },
  stateBox: { alignItems: 'center', padding: 32 },
  successCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  bottomHint: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing['8'],
    paddingTop: spacing['4'],
  },
  btn: {
    backgroundColor: '#3b82f6',
    height: 48,
    borderRadius: radius['2xl'],
    paddingHorizontal: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  iconWrap: {
    width: 80,
    height: 80,
    borderRadius: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    marginBottom: 16,
  },
});
