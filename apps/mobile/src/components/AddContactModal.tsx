import React, { useEffect, useState } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { createContact } from '../api/client';
import { showAppAlert } from './ui/appAlert';
import { spacing } from '../theme/spacing';

export type AddContactPrefill = {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  company?: string;
  notes?: string;
};

/**
 * Shared, editable "New Contact" sheet used by both the Contacts tab and the
 * Recent Calls "Add to Contacts" action. When opened from a recent call it is
 * pre-filled with the external phone number (and a caller name if the PBX sent
 * a real caller ID) so the user can review/edit the name and add details before
 * saving — it never silently saves a bare, nameless number.
 */
export function AddContactModal({
  visible,
  onClose,
  onCreated,
  prefill,
  title = 'New Contact',
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: (saved?: { displayName: string }) => void;
  prefill?: AddContactPrefill;
  title?: string;
}) {
  const { colors } = useTheme();
  const { token } = useAuth();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Re-seed the form from the prefill each time the sheet opens.
  useEffect(() => {
    if (visible) {
      setFirstName(prefill?.firstName ?? '');
      setLastName(prefill?.lastName ?? '');
      setPhone(prefill?.phone ?? '');
      setEmail(prefill?.email ?? '');
      setCompany(prefill?.company ?? '');
      setNotes(prefill?.notes ?? '');
      setSubmitting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const close = () => {
    if (submitting) return;
    onClose();
  };

  const hasName = firstName.trim() || lastName.trim();
  const hasContact = phone.trim() || email.trim();
  const canSubmit = !submitting && hasName && hasContact;

  const submit = async () => {
    if (!canSubmit || !token) return;
    setSubmitting(true);
    try {
      const displayName = `${firstName.trim()} ${lastName.trim()}`.trim() || phone.trim();
      await createContact(token, {
        firstName: firstName.trim() || undefined,
        lastName: lastName.trim() || undefined,
        company: company.trim() || undefined,
        notes: notes.trim() || undefined,
        phones: phone.trim() ? [{ type: 'mobile', numberRaw: phone.trim(), isPrimary: true }] : [],
        emails: email.trim() ? [{ type: 'work', email: email.trim(), isPrimary: true }] : [],
      });
      onCreated({ displayName });
    } catch (e: any) {
      const msg = String(e?.message || '').toUpperCase();
      if (msg.includes('DUPLICATE_PHONE')) {
        showAppAlert('Duplicate phone', 'A contact with this phone number already exists.');
      } else if (msg.includes('NAME_PHONE_OR_EMAIL_REQUIRED')) {
        showAppAlert('Missing info', 'Please provide a name plus a phone or email.');
      } else {
        showAppAlert('Could not save contact', 'Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={[styles.modalBackdrop, { backgroundColor: colors.overlay }]}>
        <View style={[styles.addSheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.sheetHandleWrap}>
            <View style={[styles.sheetHandle, { backgroundColor: colors.borderLight }]} />
          </View>

          <View style={styles.addHeaderRow}>
            <TouchableOpacity onPress={close} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={[styles.addHeaderCancel, { color: colors.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
            <Text style={[styles.addHeaderTitle, { color: colors.text }]}>{title}</Text>
            <TouchableOpacity onPress={submit} disabled={!canSubmit} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text style={[styles.addHeaderSave, { color: canSubmit ? colors.primary : colors.textTertiary }]}>
                {submitting ? 'Saving…' : 'Save'}
              </Text>
            </TouchableOpacity>
          </View>

          <ScrollView
            style={styles.addFormScroll}
            contentContainerStyle={styles.addFormContent}
            showsVerticalScrollIndicator={false}
            bounces={false}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>FIRST NAME</Text>
              <View style={[styles.fieldInput, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
                <TextInput
                  value={firstName}
                  onChangeText={setFirstName}
                  placeholder="First name"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.fieldInputText, { color: colors.text }]}
                  autoCapitalize="words"
                  autoFocus
                />
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>LAST NAME</Text>
              <View style={[styles.fieldInput, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
                <TextInput
                  value={lastName}
                  onChangeText={setLastName}
                  placeholder="Last name"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.fieldInputText, { color: colors.text }]}
                  autoCapitalize="words"
                />
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>PHONE</Text>
              <View style={[styles.fieldInput, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
                <Ionicons name="call-outline" size={16} color={colors.textTertiary} />
                <TextInput
                  value={phone}
                  onChangeText={setPhone}
                  placeholder="Phone number"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.fieldInputText, { color: colors.text, flex: 1 }]}
                  keyboardType="phone-pad"
                />
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>EMAIL</Text>
              <View style={[styles.fieldInput, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
                <Ionicons name="mail-outline" size={16} color={colors.textTertiary} />
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="Email address"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.fieldInputText, { color: colors.text, flex: 1 }]}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                />
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>COMPANY</Text>
              <View style={[styles.fieldInput, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
                <Ionicons name="business-outline" size={16} color={colors.textTertiary} />
                <TextInput
                  value={company}
                  onChangeText={setCompany}
                  placeholder="Company (optional)"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.fieldInputText, { color: colors.text, flex: 1 }]}
                />
              </View>
            </View>

            <View style={styles.fieldGroup}>
              <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>NOTES</Text>
              <View style={[styles.fieldInput, styles.fieldInputMultiline, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
                <TextInput
                  value={notes}
                  onChangeText={setNotes}
                  placeholder="Add notes (optional)"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.fieldInputText, { color: colors.text, flex: 1, textAlignVertical: 'top' }]}
                  multiline
                  numberOfLines={3}
                />
              </View>
            </View>

            {!hasName || !hasContact ? (
              <Text style={[styles.addHint, { color: colors.textTertiary }]}>
                Enter a name plus a phone number or email.
              </Text>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalBackdrop: { flex: 1, justifyContent: 'flex-end' },
  addSheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    paddingHorizontal: spacing['6'],
    paddingBottom: spacing['8'],
    paddingTop: spacing['3'],
    maxHeight: '92%',
  },
  sheetHandleWrap: { alignItems: 'center', marginBottom: 10 },
  sheetHandle: { width: 42, height: 5, borderRadius: 999 },
  addHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 4,
    marginBottom: spacing['5'],
  },
  addHeaderCancel: { fontSize: 15, fontWeight: '600' },
  addHeaderTitle: { fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
  addHeaderSave: { fontSize: 15, fontWeight: '800' },
  addFormScroll: { flexShrink: 1 },
  addFormContent: { paddingBottom: spacing['2'] },
  fieldGroup: { marginBottom: spacing['4'] },
  fieldLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.9, marginBottom: 8, marginLeft: 4 },
  fieldInput: {
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 50,
    alignSelf: 'stretch',
  },
  fieldInputMultiline: { minHeight: 96, paddingVertical: 12, alignItems: 'flex-start' },
  fieldInputText: { flex: 1, fontSize: 15, paddingVertical: 0 },
  addHint: { fontSize: 12, textAlign: 'center', marginTop: spacing['2'], fontStyle: 'italic' },
});
