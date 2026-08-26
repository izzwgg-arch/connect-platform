// In-app route map (Loopcom Driver only — registered in DriverApp's stack).
// Izzy 2026-08-25: the map can stay INSIDE the app or hand off to an external
// navigation app — a driver setting — "but either way make the route very
// user-friendly for driving": big type, the next stop always pinned in a
// bottom bar with one giant Navigate button, follow-me on by default.
//
// The map itself is Leaflet + OpenStreetMap tiles inside a WebView — no Google
// Maps API key, no react-native-maps native build. ⛔ This screen is
// OVERVIEW + follow-me, deliberately NOT turn-by-turn: voice-guided
// turn-by-turn is what the external handoff (Waze / Google / Apple) is for,
// and the Navigate button here always offers it.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet, Alert, Linking } from "react-native";
import { useNavigation, useRoute } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewProps } from "react-native-webview";

// react-native-webview 13.x's class typing collapses to `never` under this
// repo's React 19 types (a known upstream mismatch) — reassert the props.
const MapWebView = WebView as unknown as React.ComponentClass<WebViewProps>;
import * as Location from "expo-location";

import { useAuth } from "../../context/AuthContext";
import { useTheme } from "../../context/ThemeContext";
import { getRuns, getStopNav } from "../../delivery/deliveryClient";
import { getNavPrefs, type NavPrefs } from "../../delivery/navPrefs";

const DONE = new Set(["DONE", "DELIVERED", "FAILED", "SKIPPED", "CANCELED"]);

interface MapStop {
  orderId: string;
  seq: number;
  lat: number | null;
  lng: number | null;
  label: string;
  customerName?: string | null;
  done: boolean;
}

function buildMapHtml(stops: MapStop[], dark: boolean): string {
  const pts = stops.filter((s) => s.lat != null && s.lng != null);
  const stopsJson = JSON.stringify(
    pts.map((s) => ({ lat: s.lat, lng: s.lng, n: s.seq, done: s.done, label: s.label })),
  );
  // Self-contained page; Leaflet from the CDN (the phone is online on a run —
  // location batches are being posted the whole time anyway).
  return `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"/>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html,body,#map{margin:0;height:100%;background:${dark ? "#0c1218" : "#f6f8fb"}}
  .stop-pin{display:grid;place-items:center;width:30px;height:30px;border-radius:50%;
    background:#22a8ff;color:#04121d;font:800 14px/1 -apple-system,Roboto,sans-serif;
    border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4)}
  .stop-pin.done{background:#10b981;color:#04140c}
  .me-pin{width:18px;height:18px;border-radius:50%;background:#4f7bff;border:3px solid #fff;
    box-shadow:0 0 0 6px rgba(79,123,255,.25)}
</style></head><body><div id="map"></div><script>
  var stops=${stopsJson};
  var map=L.map('map',{zoomControl:false,attributionControl:true});
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap'}).addTo(map);
  var open=stops.filter(function(s){return !s.done});
  var line=open.map(function(s){return [s.lat,s.lng]});
  if(line.length>1){L.polyline(line,{color:'#22a8ff',weight:5,opacity:.75}).addTo(map);}
  stops.forEach(function(s){
    L.marker([s.lat,s.lng],{icon:L.divIcon({className:'',html:'<div class="stop-pin'+(s.done?' done':'')+'">'+(s.done?'\\u2713':s.n)+'</div>',iconSize:[30,30],iconAnchor:[15,15]})})
      .addTo(map).bindPopup('<b style="font-size:15px">Stop '+s.n+'</b><br>'+s.label);
  });
  if(stops.length){map.fitBounds(L.latLngBounds(stops.map(function(s){return [s.lat,s.lng]})).pad(0.2));}
  else{map.setView([41.34,-74.17],12);}
  var me=null,follow=true;
  window.updateDriver=function(lat,lng){
    if(!me){me=L.marker([lat,lng],{icon:L.divIcon({className:'',html:'<div class="me-pin"></div>',iconSize:[18,18],iconAnchor:[9,9]}),zIndexOffset:1000}).addTo(map);}
    me.setLatLng([lat,lng]);
    if(follow){map.panTo([lat,lng],{animate:true});}
  };
  window.setFollow=function(f){follow=f};
  map.on('dragstart',function(){follow=false});
</script></body></html>`;
}

export function DriverMapScreen() {
  const insets = useSafeAreaInsets();
  const nav = useNavigation<any>();
  const route = useRoute<any>();
  const { colors, isDark } = useTheme();
  const { token } = useAuth();
  const webRef = useRef<any>(null);
  const [stops, setStops] = useState<MapStop[]>([]);
  const [prefs, setPrefs] = useState<NavPrefs | null>(null);
  const focusOrderId: string | undefined = route.params?.focusOrderId;

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const runs = await getRuns(token);
      const all: MapStop[] = [];
      for (const r of runs) {
        for (const [i, s] of (r.stops || []).entries()) {
          const o = s.order || {};
          all.push({
            orderId: o.id || s.orderId,
            seq: i + 1,
            lat: o.lat ?? null,
            lng: o.lng ?? null,
            label: `${o.addrLine1 || "Stop"}${o.addrUnit ? ` ${o.addrUnit}` : ""}`,
            customerName: o.customerName,
            done: DONE.has(s.status) || DONE.has(o.status),
          });
        }
      }
      setStops(all);
    } catch {
      /* the map shows empty; the runs screen carries the real error */
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { getNavPrefs().then(setPrefs); }, []);

  // Follow-me: light foreground watch while the screen is open. The run's own
  // tracking (foreground service) is independent — this is display only.
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      const perm = await Location.getForegroundPermissionsAsync().catch(() => null);
      if (perm?.status !== "granted") return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 3000, distanceInterval: 10 },
        (loc) => {
          webRef.current?.injectJavaScript(
            `window.updateDriver && window.updateDriver(${loc.coords.latitude},${loc.coords.longitude});true;`,
          );
        },
      );
    })();
    return () => { sub?.remove(); };
  }, []);

  const nextStop = useMemo(() => {
    if (focusOrderId) {
      const f = stops.find((s) => s.orderId === focusOrderId && !s.done);
      if (f) return f;
    }
    return stops.find((s) => !s.done) ?? null;
  }, [stops, focusOrderId]);

  const html = useMemo(() => buildMapHtml(stops, isDark), [stops, isDark]);

  async function navigateExternal() {
    if (!nextStop || !token) return;
    try {
      const { url } = await getStopNav(token, nextStop.orderId, prefs?.navApp ?? "waze");
      await Linking.openURL(url);
    } catch (e: any) {
      Alert.alert("Navigation unavailable", e?.body?.code === "no_coords" ? "This stop has no map location yet." : "Couldn't open navigation.");
    }
  }

  return (
    <View style={[styles.fill, { backgroundColor: colors.bg }]}>
      <MapWebView
        ref={webRef}
        source={{ html }}
        originWhitelist={["*"]}
        style={styles.fill}
        // The map page is our own generated HTML; never let a popup or tapped
        // attribution link take over the app's map surface.
        setSupportMultipleWindows={false}
        onShouldStartLoadWithRequest={(req: { url: string }) => req.url === "about:blank" || req.url.startsWith("data:")}
      />
      <View style={[styles.topBar, { top: insets.top + 8 }]}>
        <TouchableOpacity style={[styles.roundBtn, { backgroundColor: colors.surface, borderColor: colors.border }]} onPress={() => nav.goBack()}>
          <Text style={[styles.roundBtnText, { color: colors.text }]}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.roundBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={() => webRef.current?.injectJavaScript("window.setFollow && window.setFollow(true);true;")}
        >
          <Text style={[styles.roundBtnText, { color: colors.primary, fontSize: 16 }]}>◎</Text>
        </TouchableOpacity>
      </View>
      <View style={[styles.bottom, { paddingBottom: insets.bottom + 14, backgroundColor: colors.surface, borderColor: colors.border }]}>
        {nextStop ? (
          <>
            <Text style={[styles.nextLabel, { color: colors.textSecondary }]}>NEXT STOP · {nextStop.seq} of {stops.length}</Text>
            <Text style={[styles.nextName, { color: colors.text }]} numberOfLines={1}>
              {nextStop.customerName ? `${nextStop.customerName} — ` : ""}{nextStop.label}
            </Text>
            <View style={styles.bottomBtns}>
              <TouchableOpacity style={[styles.bigBtn, { backgroundColor: colors.primary }]} onPress={navigateExternal}>
                <Text style={[styles.bigBtnText, { color: colors.white }]}>Navigate</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.bigBtn, styles.bigBtnGhost, { borderColor: colors.border }]}
                onPress={() => nav.navigate("Delivery", { screen: "DeliveryStop", params: { orderId: nextStop.orderId, orderRef: `#${nextStop.seq}`, addr: nextStop.label, customerName: nextStop.customerName } })}
              >
                <Text style={[styles.bigBtnText, { color: colors.text }]}>Open stop</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <Text style={[styles.nextName, { color: colors.textSecondary }]}>No stops left — nice work.</Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  topBar: { position: "absolute", left: 12, right: 12, flexDirection: "row", justifyContent: "space-between" },
  roundBtn: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  roundBtnText: { fontSize: 24, fontWeight: "700", lineHeight: 26 },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, borderTopWidth: 1, paddingHorizontal: 16, paddingTop: 12, borderTopLeftRadius: 18, borderTopRightRadius: 18 },
  nextLabel: { fontSize: 11, fontWeight: "800", letterSpacing: 1 },
  nextName: { fontSize: 17, fontWeight: "700", marginTop: 3, marginBottom: 10 },
  bottomBtns: { flexDirection: "row", gap: 10 },
  bigBtn: { flex: 1, borderRadius: 12, paddingVertical: 15, alignItems: "center" },
  bigBtnGhost: { borderWidth: 1, backgroundColor: "transparent" },
  bigBtnText: { fontWeight: "800", fontSize: 16 },
});
