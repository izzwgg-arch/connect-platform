import { StyleSheet } from "react-native";

export const colors = {
  bg: "#eceef1",
  panel: "#ffffff",
  topbar: "#2f3237",
  side: "#2e3135",
  border: "#d9dee4",
  text: "#1f2429",
  subText: "#485362",
  primary: "#0f95cf",
  danger: "#b53333",
  ok: "#1f7b33"
};

export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  topbar: {
    height: 44,
    backgroundColor: colors.topbar,
    borderBottomWidth: 1,
    borderBottomColor: "#1f2328",
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between"
  },
  topbarTitle: { color: "#f1f4f6", fontSize: 14, fontWeight: "600" },
  topbarAvatar: {
    width: 24,
    height: 24,
    borderRadius: 2,
    backgroundColor: "#3b4148",
    alignItems: "center",
    justifyContent: "center"
  },
  topbarAvatarText: { color: "#f1f4f6", fontSize: 10, fontWeight: "700" },
  content: { flex: 1, padding: 10 },
  card: {
    backgroundColor: colors.panel,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 2,
    padding: 12,
    marginBottom: 10
  },
  title: { fontSize: 20, fontWeight: "600", color: colors.text, marginBottom: 8 },
  sectionTitle: { fontSize: 14, fontWeight: "600", color: colors.text, marginBottom: 8 },
  text: { color: colors.text, fontSize: 12, marginBottom: 6 },
  input: {
    height: 34,
    borderWidth: 1,
    borderColor: "#c8d0d8",
    borderRadius: 2,
    backgroundColor: "#fff",
    paddingHorizontal: 10,
    color: colors.text,
    marginBottom: 8
  },
  button: {
    height: 34,
    borderRadius: 2,
    backgroundColor: colors.primary,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 12,
    marginRight: 6,
    marginBottom: 6
  },
  buttonText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center" },
  chip: {
    paddingHorizontal: 8,
    height: 22,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: "center",
    marginRight: 6
  },
  chipText: { fontSize: 10, fontWeight: "700" }
});
