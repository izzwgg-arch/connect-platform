import { useState } from "react";
import { SafeAreaView, ScrollView } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, Field, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { MeStackParamList } from "../../navigation/types";

type Props = NativeStackScreenProps<MeStackParamList, "EditProfile">;

export function EditProfileScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const { me, reload } = useAuth();
  const p = me?.profile;
  const [firstName, setFirstName] = useState(p?.firstName ?? "");
  const [lastName, setLastName] = useState(p?.lastName ?? "");
  const [headline, setHeadline] = useState(p?.headline ?? "");
  const [about, setAbout] = useState(p?.about ?? "");
  const [location, setLocation] = useState(p?.location ?? "");
  const [industry, setIndustry] = useState(p?.industry ?? "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api("/me/profile", {
        method: "PATCH",
        body: { firstName, lastName, headline: headline || undefined, about: about || undefined, location: location || undefined, industry: industry || undefined },
      });
      await reload();
      toast("Profile saved.");
      navigation.goBack();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }}>
        <Field label="First name" value={firstName} onChangeText={setFirstName} testID="edit-first" />
        <Field label="Last name" value={lastName} onChangeText={setLastName} testID="edit-last" />
        <Field label="Headline" value={headline} onChangeText={setHeadline} testID="edit-headline" />
        <Field label="About" value={about} onChangeText={setAbout} multiline testID="edit-about" />
        <Field label="Location" value={location} onChangeText={setLocation} testID="edit-location" />
        <Field label="Industry" value={industry} onChangeText={setIndustry} testID="edit-industry" />
        <Button title="Save" kind="primary" wide onPress={save} loading={saving} testID="edit-save" />
      </ScrollView>
    </SafeAreaView>
  );
}
