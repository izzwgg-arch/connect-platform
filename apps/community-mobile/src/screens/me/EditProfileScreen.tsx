import * as ImagePicker from "expo-image-picker";
import { useCallback, useEffect, useState } from "react";
import { Image, Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { api, ApiError, mediaUrl } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Button, Field, Icon, Sheet, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";
import type { MeStackParamList } from "../../navigation/types";

type Experience = { id: string; companyName: string; title: string; startDate: string; endDate: string | null; isCurrent: boolean; location: string | null; description: string | null };
type Education = { id: string; school: string; degree: string | null; field: string | null; startYear: number | null; endYear: number | null };
type ServiceItem = { id: string; name: string; description: string | null; priceFrom: string | null; priceNote: string | null };
type Certification = { id: string; name: string; issuer: string | null; issuedAt: string | null; expiresAt: string | null };

type FullProfile = {
  profile: {
    firstName: string;
    lastName: string;
    headline: string | null;
    about: string | null;
    location: string | null;
    industry: string | null;
    coverAssetId: string | null;
    experiences: Experience[];
    educations: Education[];
    services: ServiceItem[];
    certifications: Certification[];
  };
};

type Props = NativeStackScreenProps<MeStackParamList, "EditProfile">;

export function EditProfileScreen({ navigation }: Props) {
  const { theme } = useTheme();
  const toast = useToast();
  const { me, reload } = useAuth();
  const [full, setFull] = useState<FullProfile | null>(null);
  const [firstName, setFirstName] = useState(me?.profile?.firstName ?? "");
  const [lastName, setLastName] = useState(me?.profile?.lastName ?? "");
  const [headline, setHeadline] = useState(me?.profile?.headline ?? "");
  const [about, setAbout] = useState(me?.profile?.about ?? "");
  const [location, setLocation] = useState(me?.profile?.location ?? "");
  const [industry, setIndustry] = useState(me?.profile?.industry ?? "");
  const [saving, setSaving] = useState(false);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [editSheet, setEditSheet] = useState<{ kind: "experience" | "education" | "services" | "certifications"; item?: any } | null>(null);

  const loadFull = useCallback(() => {
    api<FullProfile>("/me/profile")
      .then(setFull)
      .catch((err) => toast((err as ApiError).message, { kind: "err" }));
  }, []);

  useEffect(loadFull, [loadFull]);

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

  async function changeCover() {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      toast("Photo library access is off.", { kind: "err" });
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, allowsEditing: true, aspect: [3, 1], quality: 0.85 });
    if (result.canceled) return;
    const asset = result.assets[0];
    setUploadingCover(true);
    try {
      const form = new FormData();
      form.append("file", { uri: asset.uri, name: asset.fileName ?? "cover.jpg", type: asset.mimeType ?? "image/jpeg" } as any);
      await api("/me/cover", { method: "POST", form: form as any });
      loadFull();
      toast("Cover photo updated.");
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setUploadingCover(false);
    }
  }

  async function deleteItem(kind: "experience" | "education" | "services" | "certifications", id: string) {
    const path: Record<typeof kind, string> = {
      experience: "experiences",
      education: "educations",
      services: "services",
      certifications: "certifications",
    } as any;
    try {
      await api(`/me/profile/${path[kind]}/${id}`, { method: "DELETE" });
      loadFull();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  const cover = mediaUrl(full?.profile.coverAssetId, "medium");

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 32, gap: 18 }}>
        <Pressable onPress={changeCover} accessibilityRole="button" accessibilityLabel="Change cover photo" testID="edit-cover">
          {cover ? (
            <Image source={{ uri: cover }} style={{ width: "100%", height: 120 }} />
          ) : (
            <View style={{ width: "100%", height: 120, backgroundColor: theme.panel2, alignItems: "center", justifyContent: "center" }}>
              <Icon name="image" size={26} color={theme.dim} />
              <Text style={{ color: theme.dim, fontSize: 12, marginTop: 4 }}>{uploadingCover ? "Uploading…" : "Add a cover photo"}</Text>
            </View>
          )}
        </Pressable>

        <View style={{ paddingHorizontal: 16, gap: 14 }}>
          <Field label="First name" value={firstName} onChangeText={setFirstName} testID="edit-first" />
          <Field label="Last name" value={lastName} onChangeText={setLastName} testID="edit-last" />
          <Field label="Headline" value={headline} onChangeText={setHeadline} testID="edit-headline" />
          <Field label="About" value={about} onChangeText={setAbout} multiline testID="edit-about" />
          <Field label="Location" value={location} onChangeText={setLocation} testID="edit-location" />
          <Field label="Industry" value={industry} onChangeText={setIndustry} testID="edit-industry" />
          <Button title="Save" kind="primary" wide onPress={save} loading={saving} testID="edit-save" />

          <CrudSection
            title="Experience"
            items={full?.profile.experiences ?? []}
            renderItem={(e: Experience) => `${e.title} · ${e.companyName}`}
            onAdd={() => setEditSheet({ kind: "experience" })}
            onEdit={(item) => setEditSheet({ kind: "experience", item })}
            onDelete={(item) => deleteItem("experience", item.id)}
          />
          <CrudSection
            title="Education"
            items={full?.profile.educations ?? []}
            renderItem={(e: Education) => `${e.school}${e.degree ? ` — ${e.degree}` : ""}`}
            onAdd={() => setEditSheet({ kind: "education" })}
            onEdit={(item) => setEditSheet({ kind: "education", item })}
            onDelete={(item) => deleteItem("education", item.id)}
          />
          <CrudSection
            title="Services"
            items={full?.profile.services ?? []}
            renderItem={(s: ServiceItem) => s.name}
            onAdd={() => setEditSheet({ kind: "services" })}
            onEdit={(item) => setEditSheet({ kind: "services", item })}
            onDelete={(item) => deleteItem("services", item.id)}
          />
          <CrudSection
            title="Certifications"
            items={full?.profile.certifications ?? []}
            renderItem={(c: Certification) => `${c.name}${c.issuer ? ` — ${c.issuer}` : ""}`}
            onAdd={() => setEditSheet({ kind: "certifications" })}
            onEdit={(item) => setEditSheet({ kind: "certifications", item })}
            onDelete={(item) => deleteItem("certifications", item.id)}
          />
        </View>
      </ScrollView>

      <ItemEditorSheet spec={editSheet} onClose={() => setEditSheet(null)} onSaved={() => { setEditSheet(null); loadFull(); }} />
    </SafeAreaView>
  );
}

function CrudSection({
  title,
  items,
  renderItem,
  onAdd,
  onEdit,
  onDelete,
}: {
  title: string;
  items: any[];
  renderItem: (item: any) => string;
  onAdd: () => void;
  onEdit: (item: any) => void;
  onDelete: (item: any) => void;
}) {
  const { theme } = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <Text style={{ color: theme.text, fontWeight: "800" }}>{title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={`Add ${title.toLowerCase()}`} onPress={onAdd} testID={`edit-add-${title.toLowerCase()}`}>
          <Icon name="plus" size={18} color={theme.accent} />
        </Pressable>
      </View>
      {items.length === 0 ? <Text style={{ color: theme.dim, fontSize: 12 }}>None added yet.</Text> : null}
      {items.map((item) => (
        <View key={item.id} style={{ flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: theme.panel, borderRadius: 10, padding: 10 }}>
          <Text style={{ color: theme.text, flex: 1 }}>{renderItem(item)}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Edit" onPress={() => onEdit(item)} hitSlop={6}>
            <Icon name="edit" size={16} color={theme.dim} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Delete" onPress={() => onDelete(item)} hitSlop={6}>
            <Icon name="trash" size={16} color={theme.danger} />
          </Pressable>
        </View>
      ))}
    </View>
  );
}

function ItemEditorSheet({
  spec,
  onClose,
  onSaved,
}: {
  spec: { kind: "experience" | "education" | "services" | "certifications"; item?: any } | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!spec) return;
    const item = spec.item ?? {};
    if (spec.kind === "experience") {
      setValues({
        companyName: item.companyName ?? "",
        title: item.title ?? "",
        startDate: item.startDate ? item.startDate.slice(0, 10) : "",
        endDate: item.endDate ? item.endDate.slice(0, 10) : "",
        location: item.location ?? "",
        description: item.description ?? "",
      });
    } else if (spec.kind === "education") {
      setValues({ school: item.school ?? "", degree: item.degree ?? "", field: item.field ?? "", startYear: item.startYear ? String(item.startYear) : "", endYear: item.endYear ? String(item.endYear) : "" });
    } else if (spec.kind === "services") {
      setValues({ name: item.name ?? "", description: item.description ?? "", priceFrom: item.priceFrom ?? "", priceNote: item.priceNote ?? "" });
    } else {
      setValues({ name: item.name ?? "", issuer: item.issuer ?? "", issuedAt: item.issuedAt ? item.issuedAt.slice(0, 10) : "" });
    }
  }, [spec?.kind, spec?.item?.id]);

  async function submit() {
    if (!spec) return;
    setSaving(true);
    try {
      const isEdit = !!spec.item;
      if (spec.kind === "experience") {
        if (!values.companyName?.trim() || !values.title?.trim() || !values.startDate?.trim()) {
          toast("Company, title and start date are needed.", { kind: "err" });
          setSaving(false);
          return;
        }
        const body = {
          companyName: values.companyName.trim(),
          title: values.title.trim(),
          startDate: values.startDate.trim(),
          endDate: values.endDate?.trim() || null,
          isCurrent: !values.endDate?.trim(),
          location: values.location?.trim() || null,
          description: values.description?.trim() || null,
        };
        if (isEdit) await api(`/me/profile/experiences/${spec.item.id}`, { method: "PATCH", body });
        else await api("/me/profile/experiences", { method: "POST", body });
      } else if (spec.kind === "education") {
        if (!values.school?.trim()) {
          toast("A school name is needed.", { kind: "err" });
          setSaving(false);
          return;
        }
        const body = {
          school: values.school.trim(),
          degree: values.degree?.trim() || null,
          field: values.field?.trim() || null,
          startYear: values.startYear?.trim() ? Number(values.startYear.trim()) : null,
          endYear: values.endYear?.trim() ? Number(values.endYear.trim()) : null,
        };
        if (isEdit) await api(`/me/profile/educations/${spec.item.id}`, { method: "PATCH", body });
        else await api("/me/profile/educations", { method: "POST", body });
      } else if (spec.kind === "services") {
        if (!values.name?.trim()) {
          toast("A service name is needed.", { kind: "err" });
          setSaving(false);
          return;
        }
        const body = { name: values.name.trim(), description: values.description?.trim() || null, priceFrom: values.priceFrom?.trim() ? Number(values.priceFrom.trim()) : null, priceNote: values.priceNote?.trim() || null };
        if (isEdit) await api(`/me/profile/services/${spec.item.id}`, { method: "PATCH", body });
        else await api("/me/profile/services", { method: "POST", body });
      } else {
        if (!values.name?.trim()) {
          toast("A certification name is needed.", { kind: "err" });
          setSaving(false);
          return;
        }
        const body = { name: values.name.trim(), issuer: values.issuer?.trim() || null, issuedAt: values.issuedAt?.trim() || null };
        if (isEdit) await api(`/me/profile/certifications/${spec.item.id}`, { method: "PATCH", body });
        else await api("/me/profile/certifications", { method: "POST", body });
      }
      onSaved();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setSaving(false);
    }
  }

  function set(key: string, v: string) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  return (
    <Sheet visible={!!spec} onClose={onClose} title={spec ? `${spec.item ? "Edit" : "Add"} ${spec.kind}` : ""}>
      <ScrollView contentContainerStyle={{ gap: 10 }}>
        {spec?.kind === "experience" ? (
          <>
            <Field label="Title" value={values.title ?? ""} onChangeText={(v) => set("title", v)} testID="item-title" />
            <Field label="Company" value={values.companyName ?? ""} onChangeText={(v) => set("companyName", v)} testID="item-company" />
            <Field label="Start date (YYYY-MM-DD)" value={values.startDate ?? ""} onChangeText={(v) => set("startDate", v)} testID="item-start" />
            <Field label="End date (blank = current)" value={values.endDate ?? ""} onChangeText={(v) => set("endDate", v)} testID="item-end" />
            <Field label="Location" value={values.location ?? ""} onChangeText={(v) => set("location", v)} testID="item-location" />
            <Field label="Description" value={values.description ?? ""} onChangeText={(v) => set("description", v)} multiline testID="item-description" />
          </>
        ) : null}
        {spec?.kind === "education" ? (
          <>
            <Field label="School" value={values.school ?? ""} onChangeText={(v) => set("school", v)} testID="item-school" />
            <Field label="Degree" value={values.degree ?? ""} onChangeText={(v) => set("degree", v)} testID="item-degree" />
            <Field label="Field of study" value={values.field ?? ""} onChangeText={(v) => set("field", v)} testID="item-field" />
            <Field label="Start year" value={values.startYear ?? ""} onChangeText={(v) => set("startYear", v)} keyboardType="number-pad" testID="item-start-year" />
            <Field label="End year" value={values.endYear ?? ""} onChangeText={(v) => set("endYear", v)} keyboardType="number-pad" testID="item-end-year" />
          </>
        ) : null}
        {spec?.kind === "services" ? (
          <>
            <Field label="Service name" value={values.name ?? ""} onChangeText={(v) => set("name", v)} testID="item-name" />
            <Field label="Description" value={values.description ?? ""} onChangeText={(v) => set("description", v)} multiline testID="item-description" />
            <Field label="Price from" value={values.priceFrom ?? ""} onChangeText={(v) => set("priceFrom", v)} keyboardType="decimal-pad" testID="item-price" />
            <Field label="Price note" value={values.priceNote ?? ""} onChangeText={(v) => set("priceNote", v)} testID="item-price-note" />
          </>
        ) : null}
        {spec?.kind === "certifications" ? (
          <>
            <Field label="Name" value={values.name ?? ""} onChangeText={(v) => set("name", v)} testID="item-name" />
            <Field label="Issuer" value={values.issuer ?? ""} onChangeText={(v) => set("issuer", v)} testID="item-issuer" />
            <Field label="Issued (YYYY-MM-DD)" value={values.issuedAt ?? ""} onChangeText={(v) => set("issuedAt", v)} testID="item-issued" />
          </>
        ) : null}
        <Button title="Save" kind="primary" wide onPress={submit} loading={saving} testID="item-save" />
      </ScrollView>
    </Sheet>
  );
}
