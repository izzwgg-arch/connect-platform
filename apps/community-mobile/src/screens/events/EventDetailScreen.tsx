import * as Calendar from "expo-calendar";
import * as Sharing from "expo-sharing";
import * as FileSystem from "expo-file-system/legacy";
import { useCallback, useEffect, useState } from "react";
import { Image, Linking, SafeAreaView, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { API_URL, api, ApiError, mediaUrl } from "../../api/client";
import { Avatar, Button, Chip, Skeleton, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { HomeStackParamList } from "../../navigation/types";

type EventDetail = {
  event: {
    id: string;
    slug: string;
    title: string;
    description: string | null;
    mode: string;
    startsAt: string;
    endsAt: string;
    venue: string | null;
    address: string | null;
    onlineUrl: string | null;
    coverAssetId: string | null;
    hostId: string;
  };
  myRsvp: { status: string; visible: boolean } | null;
  counts: { going: number; interested: number; spotsLeft: number | null };
  attendeeListVisible: boolean;
  attendees: Array<{ person: { id: string; name: string; avatarAssetId: string | null }; status: string }>;
  inYourNetwork: { count: number; people: Array<{ id: string; name: string }> };
  calendar: { icsUrl: string; googleUrl: string };
};

type Props = NativeStackScreenProps<HomeStackParamList, "EventDetail">;

export function EventDetailScreen({ route, navigation }: Props) {
  const { slug, id } = route.params;
  const { theme } = useTheme();
  const toast = useToast();
  const [data, setData] = useState<EventDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!slug) return;
    api<EventDetail>(`/public/events/${slug}`)
      .then(setData)
      .catch((err) => toast((err as ApiError).message, { kind: "err" }));
  }, [slug]);

  useEffect(load, [load]);

  async function rsvp(status: "GOING" | "INTERESTED" | "NOT_GOING") {
    if (!data) return;
    setBusy(true);
    try {
      await api(`/events/${data.event.id}/rsvp`, { method: "POST", body: { status } });
      load();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function addToCalendar() {
    if (!data) return;
    try {
      const perm = await Calendar.requestCalendarPermissionsAsync();
      if (!perm.granted) {
        await shareIcs();
        return;
      }
      const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
      const writable = calendars.find((c) => c.allowsModifications) ?? calendars[0];
      let calendarId = writable?.id;
      if (!calendarId) {
        const defaultSource = calendars[0]?.source ?? { isLocalAccount: true, name: "Loopcom Community", type: "" as any };
        calendarId = await Calendar.createCalendarAsync({
          title: "Loopcom Community",
          color: theme.accent,
          entityType: Calendar.EntityTypes.EVENT,
          source: defaultSource as any,
          sourceId: (defaultSource as any).id,
          name: "loopcomCommunity",
          ownerAccount: "loopcomCommunity",
          accessLevel: Calendar.CalendarAccessLevel.OWNER,
        });
      }
      await Calendar.createEventAsync(calendarId, {
        title: data.event.title,
        startDate: new Date(data.event.startsAt),
        endDate: new Date(data.event.endsAt),
        location: data.event.mode === "ONLINE" ? data.event.onlineUrl ?? undefined : data.event.address ?? data.event.venue ?? undefined,
        notes: data.event.description ?? undefined,
      });
      toast("Added to your calendar.");
    } catch {
      await shareIcs();
    }
  }

  async function shareIcs() {
    if (!data) return;
    try {
      const path = `${FileSystem.cacheDirectory}${data.event.slug}.ics`;
      const res = await FileSystem.downloadAsync(`${API_URL}${data.calendar.icsUrl}`, path);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(res.uri);
      else toast(`Saved to ${res.uri}`);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  if (!data) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg, padding: 16 }}>
        <Skeleton height={160} radius={16} />
      </SafeAreaView>
    );
  }

  const e = data.event;
  const cover = mediaUrl(e.coverAssetId, "medium");
  const status = data.myRsvp?.status;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 24, gap: 14 }}>
        {cover ? <Image source={{ uri: cover }} style={{ width: "100%", height: 180 }} /> : null}
        <View style={{ paddingHorizontal: 16, gap: 10 }}>
          <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>{e.title}</Text>
          <Text style={{ color: theme.text }}>{new Date(e.startsAt).toLocaleString([], { dateStyle: "full", timeStyle: "short" })}</Text>
          <Text style={{ color: theme.dim }}>{e.mode === "ONLINE" ? "Online event" : e.venue ?? e.address ?? "In person"}</Text>

          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Button title={status === "GOING" ? "Going ✓" : "Going"} kind={status === "GOING" ? "primary" : "secondary"} onPress={() => rsvp("GOING")} loading={busy} testID="event-rsvp-going" />
            <Button title={status === "INTERESTED" ? "Interested ✓" : "Interested"} kind={status === "INTERESTED" ? "primary" : "secondary"} onPress={() => rsvp("INTERESTED")} loading={busy} />
            {status ? <Button title="Cancel RSVP" kind="danger" onPress={() => rsvp("NOT_GOING")} loading={busy} /> : null}
          </View>
          {data.counts.spotsLeft != null ? <Text style={{ color: theme.dim, fontSize: 12 }}>{data.counts.spotsLeft} spots left</Text> : null}

          <View style={{ flexDirection: "row", gap: 10 }}>
            <Button title="Add to calendar" icon="cal" onPress={addToCalendar} testID="event-add-calendar" />
            <Button title="Share .ics" icon="share" onPress={shareIcs} />
            {e.mode !== "IN_PERSON" && e.onlineUrl && status === "GOING" ? <Button title="Join online" icon="video" onPress={() => Linking.openURL(e.onlineUrl!)} /> : null}
          </View>

          {e.description ? <Text style={{ color: theme.text, lineHeight: 20 }}>{e.description}</Text> : null}

          <Text style={{ color: theme.text, fontWeight: "800" }}>
            {data.counts.going} going · {data.counts.interested} interested
          </Text>
          {data.inYourNetwork.count ? <Text style={{ color: theme.dim, fontSize: 12 }}>{data.inYourNetwork.count} people you know are going</Text> : null}

          {data.attendeeListVisible && data.attendees.length ? (
            <View style={{ gap: 8 }}>
              <Text style={{ color: theme.text, fontWeight: "800" }}>Attendees</Text>
              {data.attendees.slice(0, 20).map((a) => (
                <View key={a.person.id} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Avatar assetId={a.person.avatarAssetId} name={a.person.name} size={28} />
                  <Text style={{ color: theme.text }}>{a.person.name}</Text>
                  <Chip label={a.status.toLowerCase()} />
                </View>
              ))}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
