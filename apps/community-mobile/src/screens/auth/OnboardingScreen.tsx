import { useEffect, useState } from "react";
import { SafeAreaView, ScrollView, Text, View } from "react-native";
import { api, ApiError } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { Avatar, Button, Chip, Field, useToast } from "../../ui";
import { useTheme } from "../../theme/ThemeProvider";

const OBJECTIVES = ["Grow my business", "Find customers", "Find vendors", "Professional networking", "Find employment", "Hire employees", "Recruit", "Sell services", "Find partners", "Attend events", "Learn", "Find referrals"];
const INDUSTRIES = ["Apparel & uniforms", "Printing & signage", "Construction & trades", "Real estate", "Healthcare", "Retail", "Wholesale & distribution", "Technology", "Telecom", "Accounting & bookkeeping", "Transportation & logistics", "Food & catering", "Nonprofit", "Education", "Legal", "Insurance", "Marketing", "Manufacturing", "Other"];
const LANGUAGES = ["English", "Yiddish", "Hebrew", "Spanish", "Russian", "French", "Hungarian", "Portuguese"];
const STEPS = ["About you", "What you're here for", "Skills", "Where you work", "Follow a few companies"];

type OrgLite = { id: string; slug: string; displayName: string; logoAssetId: string | null; industry: string | null; reason?: string };

function toggle(list: string[], set: (v: string[]) => void, v: string) {
  set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
}

export function OnboardingScreen() {
  const { theme } = useTheme();
  const toast = useToast();
  const { me, reload } = useAuth();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [headline, setHeadline] = useState(me?.profile?.headline ?? "");
  const [industry, setIndustry] = useState(me?.profile?.industry ?? "");
  const [location, setLocation] = useState(me?.profile?.location ?? "");
  const [objectives, setObjectives] = useState<string[]>(me?.profile?.objectives ?? []);
  const [skills, setSkills] = useState<string[]>(me?.profile?.skills ?? []);
  const [skillInput, setSkillInput] = useState("");
  const [serviceArea, setServiceArea] = useState((me?.profile?.serviceArea ?? []).join(", "));
  const [languages, setLanguages] = useState<string[]>(me?.profile?.languages ?? ["English"]);
  const [suggested, setSuggested] = useState<OrgLite[]>([]);
  const [followed, setFollowed] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (step === 4) {
      api<{ organizations: OrgLite[] }>("/recommendations/organizations?limit=8")
        .then((r) => setSuggested(r.organizations))
        .catch(() => setSuggested([]));
    }
  }, [step]);

  async function follow(org: OrgLite) {
    try {
      await api(`/organizations/${org.id}/follow`, { method: "POST" });
      setFollowed((s) => new Set(s).add(org.id));
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    }
  }

  async function finish() {
    setBusy(true);
    try {
      await api("/me/onboarding/done", { method: "POST" });
      await reload();
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  async function saveStep() {
    setBusy(true);
    try {
      if (step === 0) await api("/me/profile", { method: "PATCH", body: { headline: headline || undefined, industry: industry || undefined, location: location || undefined } });
      if (step === 1) await api("/me/profile", { method: "PATCH", body: { objectives } });
      if (step === 2) await api("/me/profile", { method: "PATCH", body: { skills } });
      if (step === 3) await api("/me/profile", { method: "PATCH", body: { serviceArea: serviceArea.split(",").map((x) => x.trim()).filter(Boolean), languages } });
      if (step === STEPS.length - 1) return finish();
      setStep(step + 1);
    } catch (err) {
      toast((err as ApiError).message, { kind: "err" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.panel2, overflow: "hidden" }}>
          <View style={{ height: 6, width: `${((step + 1) / STEPS.length) * 100}%`, backgroundColor: theme.accent }} />
        </View>
        <Text style={{ color: theme.text, fontSize: 20, fontWeight: "800" }}>{STEPS[step]}</Text>

        {step === 0 ? (
          <View style={{ gap: 12 }}>
            <Field label="Headline" placeholder="e.g. Owner at Acme Signs" value={headline} onChangeText={setHeadline} testID="ob-headline" />
            <Field label="Location" placeholder="City, State" value={location} onChangeText={setLocation} testID="ob-location" />
            <Text style={{ color: theme.dim, fontSize: 13, fontWeight: "600" }}>Industry</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {INDUSTRIES.map((i) => (
                <Chip key={i} label={i} active={industry === i} onPress={() => setIndustry(i)} />
              ))}
            </View>
          </View>
        ) : null}

        {step === 1 ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {OBJECTIVES.map((o) => (
              <Chip key={o} label={o} active={objectives.includes(o)} icon={objectives.includes(o) ? "check" : undefined} onPress={() => toggle(objectives, setObjectives, o)} />
            ))}
          </View>
        ) : null}

        {step === 2 ? (
          <View style={{ gap: 12 }}>
            <Field
              label="Add a skill and press done"
              value={skillInput}
              onChangeText={setSkillInput}
              onSubmitEditing={() => {
                const v = skillInput.trim();
                if (v && !skills.includes(v)) setSkills([...skills, v]);
                setSkillInput("");
              }}
              returnKeyType="done"
              testID="ob-skill"
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {skills.map((s) => (
                <Chip key={s} label={`${s} ×`} active onPress={() => setSkills(skills.filter((x) => x !== s))} />
              ))}
            </View>
          </View>
        ) : null}

        {step === 3 ? (
          <View style={{ gap: 12 }}>
            <Field label="Service area (comma separated)" value={serviceArea} onChangeText={setServiceArea} testID="ob-service-area" />
            <Text style={{ color: theme.dim, fontSize: 13, fontWeight: "600" }}>Languages</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {LANGUAGES.map((l) => (
                <Chip key={l} label={l} active={languages.includes(l)} onPress={() => toggle(languages, setLanguages, l)} />
              ))}
            </View>
          </View>
        ) : null}

        {step === 4 ? (
          <View style={{ gap: 10 }}>
            <Text style={{ color: theme.dim }}>Suggested from your industry and area.</Text>
            {suggested.map((o) => (
              <View key={o.id} style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 10, backgroundColor: theme.panel, borderRadius: 12 }}>
                <Avatar assetId={o.logoAssetId} name={o.displayName} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: theme.text, fontWeight: "700" }}>{o.displayName}</Text>
                  <Text style={{ color: theme.dim, fontSize: 12 }}>{[o.industry, o.reason].filter(Boolean).join(" · ")}</Text>
                </View>
                <Button title={followed.has(o.id) ? "Following" : "Follow"} kind={followed.has(o.id) ? "secondary" : "primary"} onPress={() => follow(o)} disabled={followed.has(o.id)} />
              </View>
            ))}
          </View>
        ) : null}

        <View style={{ flexDirection: "row", justifyContent: "space-between", marginTop: 12 }}>
          <Button title="Back" onPress={() => setStep(Math.max(0, step - 1))} disabled={step === 0 || busy} testID="ob-back" />
          <Button title={step === STEPS.length - 1 ? "Finish" : "Continue"} kind="primary" onPress={saveStep} loading={busy} testID="ob-continue" />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
