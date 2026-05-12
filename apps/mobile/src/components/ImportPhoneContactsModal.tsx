/**
 * ImportPhoneContactsModal — a multi-step modal:
 *   1. Permission gate (request / denied with "open settings")
 *   2. Loading device contacts + cross-referencing existing directory
 *   3. Preview with selectable rows (Select all, individual checkboxes,
 *      "skip already-existing" toggle)
 *   4. Importing... progress
 *   5. Result summary
 *
 * Designed to fit the existing dark/glass Connect aesthetic.
 */
import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { typography } from '../theme/typography';
import { spacing, radius } from '../theme/spacing';
import {
  buildImportPreview,
  checkContactsPermission,
  importContacts,
  openAppSettings,
  requestContactsPermission,
  type ImportPreview,
  type ImportResult,
  type PermissionState,
  type PhoneContactCandidate,
} from '../contacts/phoneContactsImport';

type Step = 'permission' | 'permission_denied' | 'loading' | 'preview' | 'importing' | 'done' | 'error';

type ProgressState = { done: number; total: number; currentName: string } | null;

export type ImportPhoneContactsModalProps = {
  visible: boolean;
  authToken: string | null;
  onClose: () => void;
  onImported?: (result: ImportResult) => void;
  /**
   * Optional: permission status already resolved by the caller (e.g. from
   * the button's onPress handler, where the gesture context guarantees the
   * system dialog will fire). When supplied, the modal skips its own
   * checkContactsPermission() call and jumps straight to the appropriate
   * step — preventing the timing issue where async boot() runs outside the
   * original user-gesture window on Android 12+ and the system dialog never
   * appears.
   */
  initialPermission?: PermissionState;
};

export function ImportPhoneContactsModal({
  visible,
  authToken,
  onClose,
  onImported,
  initialPermission,
}: ImportPhoneContactsModalProps) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>('permission');
  const [permCanAskAgain, setPermCanAskAgain] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<ProgressState>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  // Reset state every time the modal becomes visible.
  useEffect(() => {
    if (!visible) return;
    setStep('permission');
    setErrorMessage(null);
    setPreview(null);
    setSearch('');
    setSelectedIds(new Set());
    setProgress(null);
    setResult(null);
    void boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const boot = useCallback(async () => {
    // Use the caller-supplied permission if available — avoids re-requesting
    // inside the Modal where the gesture context may have already expired.
    const current = initialPermission ?? await checkContactsPermission();
    if (current.status === 'granted') {
      void load();
    } else if (current.status === 'denied') {
      setPermCanAskAgain(current.canAskAgain);
      setStep(current.canAskAgain ? 'permission' : 'permission_denied');
    } else {
      // undetermined: caller should have requested already; fall back to the
      // "Continue" screen so the user can retry from within the modal.
      setStep('permission');
    }
  }, [initialPermission]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!authToken) {
      setErrorMessage('You must be signed in to import contacts.');
      setStep('error');
      return;
    }
    setStep('loading');
    try {
      const data = await buildImportPreview(authToken);
      setPreview(data);
      // Default selection: every candidate that's NEW (not already in the
      // directory and has at least one phone number).
      const initial = new Set<string>();
      for (const c of data.candidates) {
        if (!c.alreadyExists && !c.skipReason) initial.add(c.id);
      }
      setSelectedIds(initial);
      setStep('preview');
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (msg.includes('contacts_permission_not_granted')) {
        setStep('permission');
      } else if (msg.startsWith('contacts_read_failed:')) {
        const detail = msg.replace(/^contacts_read_failed:/, '').trim() || 'Unknown error';
        setErrorMessage(
          `Could not read device contacts (${detail}). If you denied permission, open Settings and allow Contacts for Connect, then try again.`,
        );
        setStep('error');
      } else {
        setErrorMessage('Could not read your phone contacts. Please try again.');
        setStep('error');
      }
    }
  }, [authToken]);

  const grant = useCallback(async () => {
    const next = await requestContactsPermission();
    if (next.status === 'granted') {
      void load();
    } else {
      setPermCanAskAgain(next.status === 'denied' ? next.canAskAgain : false);
      setStep(next.status === 'denied' && !next.canAskAgain ? 'permission_denied' : 'permission');
    }
  }, [load]);

  const filteredCandidates = useMemo(() => {
    if (!preview) return [];
    const query = search.trim().toLowerCase();
    if (!query) return preview.candidates;
    return preview.candidates.filter((c) => {
      if (c.displayName.toLowerCase().includes(query)) return true;
      if (c.company.toLowerCase().includes(query)) return true;
      return c.phones.some((p) => p.numberRaw.includes(query) || p.numberNormalized.includes(query));
    });
  }, [preview, search]);

  const importableInFiltered = useMemo(
    () => filteredCandidates.filter((c) => !c.alreadyExists && !c.skipReason),
    [filteredCandidates],
  );

  const allFilteredSelected =
    importableInFiltered.length > 0 && importableInFiltered.every((c) => selectedIds.has(c.id));

  const toggle = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllFiltered = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allFilteredSelected) {
        for (const c of importableInFiltered) next.delete(c.id);
      } else {
        for (const c of importableInFiltered) next.add(c.id);
      }
      return next;
    });
  }, [allFilteredSelected, importableInFiltered]);

  const runImport = useCallback(async () => {
    if (!authToken || !preview) return;
    const chosen = preview.candidates.filter((c) => selectedIds.has(c.id));
    if (chosen.length === 0) {
      Alert.alert('Nothing selected', 'Pick at least one contact to import.');
      return;
    }
    setStep('importing');
    setProgress({ done: 0, total: chosen.length, currentName: chosen[0]?.displayName ?? '' });
    try {
      const res = await importContacts(authToken, chosen, (p) => setProgress(p));
      setResult(res);
      setStep('done');
      onImported?.(res);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      console.error('[contacts_import] runImport_failed', msg, err);
      setErrorMessage(
        msg.includes('import')
          ? msg
          : 'Import stopped unexpectedly. Check your connection and try again with a smaller selection first.',
      );
      setStep('error');
    }
  }, [authToken, preview, selectedIds, onImported]);

  const closeModal = useCallback(() => {
    if (step === 'importing') return; // don't allow close mid-import
    onClose();
  }, [step, onClose]);

  return (
    <Modal animationType="slide" transparent visible={visible} onRequestClose={closeModal}>
      <View style={styles.backdrop}>
        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surfaceElevated,
              borderColor: colors.border,
              paddingTop: 12,
              paddingBottom: insets.bottom + 16,
            },
          ]}
        >
          <View style={styles.headerRow}>
            <View style={styles.headerHandle} />
          </View>

          <View style={[styles.headerInner, { paddingHorizontal: spacing['4'] }]}>
            <View style={[styles.headerIcon, { backgroundColor: colors.primary + '22' }]}>
              <Ionicons name="people" size={20} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[typography.h3, { color: colors.text }]}>
                Import from phone
              </Text>
              <Text style={[typography.caption, { color: colors.textSecondary, marginTop: 2 }]}>
                {step === 'preview' && preview
                  ? `${preview.totalFound} found · ${preview.newCount} new · ${preview.alreadyExistsCount} already in app`
                  : 'Bring your device contacts into Connect'}
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.closeBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}
              onPress={closeModal}
              activeOpacity={0.74}
              disabled={step === 'importing'}
            >
              <Ionicons name="close" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          <View style={[styles.body, { paddingHorizontal: spacing['4'] }]}>
            {step === 'permission' && (
              <PermissionView
                onGrant={grant}
                onCancel={onClose}
              />
            )}

            {step === 'permission_denied' && (
              <PermissionDeniedView
                onOpenSettings={() => openAppSettings()}
                onCancel={onClose}
              />
            )}

            {step === 'loading' && (
              <View style={styles.center}>
                <ActivityIndicator color={colors.primary} size="large" />
                <Text style={[typography.body, { color: colors.textSecondary, marginTop: 12 }]}>
                  Reading your phone contacts...
                </Text>
              </View>
            )}

            {step === 'preview' && preview && (
              <>
                <View style={[styles.searchBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <Ionicons name="search-outline" size={16} color={colors.textTertiary} />
                  <TextInput
                    placeholder="Search by name or number"
                    placeholderTextColor={colors.textTertiary}
                    value={search}
                    onChangeText={setSearch}
                    style={[styles.searchInput, { color: colors.text }]}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                </View>

                <View style={styles.statsRow}>
                  <Stat label="Total" value={preview.totalFound} color={colors.text} />
                  <StatDivider color={colors.border} />
                  <Stat label="New" value={preview.newCount} color={colors.primary} />
                  <StatDivider color={colors.border} />
                  <Stat label="In app" value={preview.alreadyExistsCount} color={colors.success} />
                  <StatDivider color={colors.border} />
                  <Stat label="No phone" value={preview.skippedNoPhoneCount} color={colors.textTertiary} />
                </View>

                <TouchableOpacity
                  style={[styles.selectAllBar, { borderColor: colors.border, backgroundColor: colors.surface + 'aa' }]}
                  onPress={toggleAllFiltered}
                  activeOpacity={0.78}
                >
                  <Ionicons
                    name={allFilteredSelected ? 'checkbox' : 'square-outline'}
                    size={18}
                    color={allFilteredSelected ? colors.primary : colors.textTertiary}
                  />
                  <Text style={[typography.body, { color: colors.text, flex: 1, marginLeft: 10 }]}>
                    {allFilteredSelected ? 'Deselect new' : 'Select all new'}
                  </Text>
                  <Text style={[typography.caption, { color: colors.textSecondary }]}>
                    {selectedIds.size} selected
                  </Text>
                </TouchableOpacity>

                <FlatList
                  data={filteredCandidates}
                  keyExtractor={(item) => item.id}
                  contentContainerStyle={{ paddingBottom: 120 }}
                  renderItem={({ item }) => (
                    <CandidateRow
                      candidate={item}
                      selected={selectedIds.has(item.id)}
                      onToggle={toggle}
                    />
                  )}
                  ListEmptyComponent={
                    <Text style={[typography.body, { color: colors.textTertiary, textAlign: 'center', marginTop: 32 }]}>
                      No contacts match your search.
                    </Text>
                  }
                />

                <View style={[styles.footer, { paddingHorizontal: 0 }]}>
                  <TouchableOpacity
                    onPress={onClose}
                    style={[styles.btn, styles.btnSecondary, { borderColor: colors.border }]}
                    activeOpacity={0.78}
                  >
                    <Text style={[typography.labelLg, { color: colors.textSecondary }]}>Cancel</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={runImport}
                    style={[styles.btn, styles.btnPrimary, { backgroundColor: colors.primary }]}
                    activeOpacity={0.84}
                    disabled={selectedIds.size === 0}
                  >
                    <Ionicons name="cloud-upload-outline" size={17} color="#fff" />
                    <Text style={[typography.labelLg, { color: '#fff', marginLeft: 8 }]}>
                      Import {selectedIds.size > 0 ? `(${selectedIds.size})` : ''}
                    </Text>
                  </TouchableOpacity>
                </View>
              </>
            )}

            {step === 'importing' && progress && (
              <View style={styles.center}>
                <ActivityIndicator color={colors.primary} size="large" />
                <Text style={[typography.body, { color: colors.text, marginTop: 14, fontWeight: '600' }]}>
                  {progress.done} of {progress.total} saved
                </Text>
                <Text style={[typography.caption, { color: colors.textSecondary, marginTop: 6 }]} numberOfLines={2}>
                  {progress.done === 0 && progress.total > 0
                    ? 'Starting uploads — the counter moves after each contact finishes (not while waiting on the network).'
                    : progress.currentName}
                </Text>
                <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
                  <View
                    style={[
                      styles.progressFill,
                      {
                        backgroundColor: colors.primary,
                        width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%`,
                      },
                    ]}
                  />
                </View>
              </View>
            )}

            {step === 'done' && result && (
              <ResultView result={result} onClose={onClose} />
            )}

            {step === 'error' && (
              <View style={styles.center}>
                <Ionicons name="alert-circle-outline" size={48} color={colors.warning} />
                <Text style={[typography.h3, { color: colors.text, marginTop: 14 }]}>
                  Something went wrong
                </Text>
                <Text style={[typography.body, { color: colors.textSecondary, marginTop: 6, textAlign: 'center' }]}>
                  {errorMessage ?? 'Please try again.'}
                </Text>
                <TouchableOpacity
                  onPress={() => boot()}
                  style={[styles.btn, styles.btnPrimary, { backgroundColor: colors.primary, marginTop: 18 }]}
                  activeOpacity={0.84}
                >
                  <Text style={[typography.labelLg, { color: '#fff' }]}>Try again</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </View>
    </Modal>
  );
}

// ── Inner views ─────────────────────────────────────────────────────────

const PermissionView = memo(function PermissionView({
  onGrant,
  onCancel,
}: {
  onGrant: () => void;
  onCancel: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.center}>
      <View style={[styles.bigIcon, { backgroundColor: colors.primary + '22' }]}>
        <Ionicons name="lock-closed" size={26} color={colors.primary} />
      </View>
      <Text style={[typography.h3, { color: colors.text, marginTop: 14, textAlign: 'center' }]}>
        Allow access to your contacts
      </Text>
      <Text style={[typography.body, { color: colors.textSecondary, marginTop: 8, textAlign: 'center', lineHeight: 21 }]}>
        Connect will read your phone contacts only when you tap "Continue". Nothing is uploaded
        until you select which ones to import.
      </Text>
      <TouchableOpacity
        onPress={onGrant}
        style={[styles.btn, styles.btnPrimary, { backgroundColor: colors.primary, marginTop: 22, paddingHorizontal: 32 }]}
        activeOpacity={0.84}
      >
        <Text style={[typography.labelLg, { color: '#fff' }]}>Continue</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onCancel} style={{ marginTop: 14 }}>
        <Text style={[typography.body, { color: colors.textTertiary }]}>Not now</Text>
      </TouchableOpacity>
    </View>
  );
});

const PermissionDeniedView = memo(function PermissionDeniedView({
  onOpenSettings,
  onCancel,
}: {
  onOpenSettings: () => void;
  onCancel: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.center}>
      <View style={[styles.bigIcon, { backgroundColor: colors.warning + '22' }]}>
        <Ionicons name="alert-circle" size={26} color={colors.warning} />
      </View>
      <Text style={[typography.h3, { color: colors.text, marginTop: 14, textAlign: 'center' }]}>
        Contacts access is blocked
      </Text>
      <Text style={[typography.body, { color: colors.textSecondary, marginTop: 8, textAlign: 'center', lineHeight: 21 }]}>
        Open Settings and turn on the Contacts permission for Connect, then come back here to
        continue.
      </Text>
      <TouchableOpacity
        onPress={onOpenSettings}
        style={[styles.btn, styles.btnPrimary, { backgroundColor: colors.primary, marginTop: 22, paddingHorizontal: 32 }]}
        activeOpacity={0.84}
      >
        <Ionicons name="settings-outline" size={17} color="#fff" />
        <Text style={[typography.labelLg, { color: '#fff', marginLeft: 8 }]}>Open Settings</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onCancel} style={{ marginTop: 14 }}>
        <Text style={[typography.body, { color: colors.textTertiary }]}>Cancel</Text>
      </TouchableOpacity>
    </View>
  );
});

const CandidateRow = memo(function CandidateRow({
  candidate,
  selected,
  onToggle,
}: {
  candidate: PhoneContactCandidate;
  selected: boolean;
  onToggle: (id: string) => void;
}) {
  const { colors } = useTheme();
  const disabled = candidate.alreadyExists || !!candidate.skipReason;
  const statusLabel = candidate.skipReason === 'no_phone'
    ? 'No phone'
    : candidate.alreadyExists
    ? 'Already in app'
    : null;

  return (
    <TouchableOpacity
      onPress={() => !disabled && onToggle(candidate.id)}
      activeOpacity={disabled ? 1 : 0.7}
      style={[
        styles.row,
        { borderColor: colors.border, opacity: disabled ? 0.55 : 1 },
      ]}
    >
      <Ionicons
        name={disabled ? 'remove-circle-outline' : selected ? 'checkbox' : 'square-outline'}
        size={20}
        color={disabled ? colors.textTertiary : selected ? colors.primary : colors.textTertiary}
      />
      <View style={{ flex: 1, marginLeft: 12 }}>
        <Text style={[typography.body, { color: colors.text, fontWeight: '600' }]} numberOfLines={1}>
          {candidate.displayName}
        </Text>
        <Text style={[typography.caption, { color: colors.textSecondary }]} numberOfLines={1}>
          {candidate.phones[0]?.numberRaw ?? 'No number'}
          {candidate.company ? ` · ${candidate.company}` : ''}
        </Text>
      </View>
      {statusLabel && (
        <View
          style={[
            styles.badge,
            {
              backgroundColor: candidate.alreadyExists ? colors.success + '22' : colors.surface,
              borderColor: candidate.alreadyExists ? colors.success + '55' : colors.border,
            },
          ]}
        >
          <Text
            style={[
              typography.labelSm,
              { color: candidate.alreadyExists ? colors.success : colors.textTertiary },
            ]}
          >
            {statusLabel}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
});

const ResultView = memo(function ResultView({
  result,
  onClose,
}: {
  result: ImportResult;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.center}>
      <View style={[styles.bigIcon, { backgroundColor: colors.success + '22' }]}>
        <Ionicons name="checkmark-circle" size={28} color={colors.success} />
      </View>
      <Text style={[typography.h3, { color: colors.text, marginTop: 14 }]}>
        Import complete
      </Text>
      <View style={[styles.summary, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <SummaryRow icon="cloud-done-outline" label="Imported" value={result.imported} color={colors.primary} />
        <SummaryRow icon="git-merge-outline" label="Already existed (merged)" value={result.duplicatesMerged} color={colors.success} />
        <SummaryRow icon="ban-outline" label="Skipped (no phone)" value={result.skippedNoPhone} color={colors.textTertiary} />
        {result.failures > 0 && (
          <SummaryRow icon="alert-circle-outline" label="Failed" value={result.failures} color={colors.warning} />
        )}
      </View>
      {result.failureMessages.length > 0 && (
        <View style={{ marginTop: 14, alignSelf: 'stretch' }}>
          <Text style={[typography.labelSm, { color: colors.textSecondary, marginBottom: 6 }]}>
            Some contacts could not be imported:
          </Text>
          {result.failureMessages.map((msg, idx) => (
            <Text
              key={idx}
              style={[typography.caption, { color: colors.textTertiary, marginBottom: 4 }]}
              numberOfLines={2}
            >
              • {msg}
            </Text>
          ))}
        </View>
      )}
      <TouchableOpacity
        onPress={onClose}
        style={[styles.btn, styles.btnPrimary, { backgroundColor: colors.primary, marginTop: 22, paddingHorizontal: 36 }]}
        activeOpacity={0.84}
      >
        <Text style={[typography.labelLg, { color: '#fff' }]}>Done</Text>
      </TouchableOpacity>
    </View>
  );
});

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  const { colors } = useTheme();
  return (
    <View style={styles.stat}>
      <Text style={[typography.h2, { color }]}>{value}</Text>
      <Text style={[typography.caption, { color: colors.textTertiary }]}>{label}</Text>
    </View>
  );
}
function StatDivider({ color }: { color: string }) {
  return <View style={[styles.statDivider, { backgroundColor: color }]} />;
}
function SummaryRow({
  icon, label, value, color,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: number;
  color: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={styles.summaryRow}>
      <Ionicons name={icon} size={17} color={color} />
      <Text style={[typography.body, { color: colors.text, flex: 1, marginLeft: 10 }]}>{label}</Text>
      <Text style={[typography.body, { color, fontWeight: '700' }]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(2,6,17,0.78)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: '92%',
  },
  headerRow: {
    alignItems: 'center',
    marginBottom: 6,
  },
  headerHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#475569',
  },
  headerInner: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    gap: 10,
  },
  headerIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  body: {
    flex: 1,
    paddingTop: 8,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
    paddingHorizontal: spacing['2'],
  },
  bigIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 10 : 6,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
    marginBottom: 12,
  },
  searchInput: {
    flex: 1,
    fontSize: 14,
    paddingVertical: 4,
  },
  statsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    paddingVertical: 8,
    marginBottom: 4,
  },
  stat: {
    flex: 1,
    alignItems: 'center',
  },
  statDivider: {
    width: StyleSheet.hairlineWidth,
    marginVertical: 6,
    opacity: 0.5,
  },
  selectAllBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    paddingTop: 12,
  },
  btn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    borderRadius: radius.md,
  },
  btnSecondary: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  btnPrimary: { },
  progressTrack: {
    width: '80%',
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
    marginTop: 18,
  },
  progressFill: {
    height: '100%',
  },
  summary: {
    alignSelf: 'stretch',
    marginTop: 18,
    padding: 14,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
