import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Linking,
  Modal,
  PanResponder,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useSip } from '../../context/SipContext';
import { EmptyState } from '../../components/ui/EmptyState';
import { Avatar } from '../../components/ui/Avatar';
import { PulseDot } from '../../components/ui/PulseDot';
import { HorizontalFilterScroll } from '../../components/ui/HorizontalFilterScroll';
import { getContacts } from '../../api/client';
import { subscribeToBLF, type LiveTelephonyState } from '../../api/realtime';
import type { Contact } from '../../types';
import { typography } from '../../theme/typography';
import { teamFilterChipColors } from '../../theme/filterChipColors';
import { radius, spacing } from '../../theme/spacing';

type ContactFilter = 'all' | 'extensions' | 'external' | 'favorites';
type ContactStatus = {
  label: 'Available' | 'Away' | 'On Call' | 'Offline';
  color: string;
  pulse: boolean;
  /** Presence ordering for within-extensions sort (lower = higher in list). */
  weight: number;
};
type ContactListItem =
  | { type: 'section'; id: string; title: string; count?: number }
  | { type: 'contact'; id: string; contact: Contact };

function contactTarget(contact: Contact): string | undefined {
  return contact.type === 'internal_extension' ? contact.extension ?? undefined : contact.primaryPhone?.numberRaw;
}

function contactMeta(contact: Contact): string {
  if (contact.type === 'internal_extension') return `Ext ${contact.extension || '—'} · Internal`;
  return `External · ${contact.primaryPhone?.numberRaw || contact.primaryEmail?.email || contact.company || 'Contact'}`;
}

function isExternal(contact: Contact): boolean {
  return contact.type !== 'internal_extension';
}

export function ContactTab() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const sip = useSip();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [live, setLive] = useState<LiveTelephonyState | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ContactFilter>('all');
  const [selected, setSelected] = useState<Contact | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (!token) return;
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const data = await getContacts(token, query);
      setContacts(data.rows ?? []);
    } catch {
      setError('Could not load contacts.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [query, token]);

  useEffect(() => {
    const t = setTimeout(() => load(false), 250);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    if (!token) return undefined;
    return subscribeToBLF(token, setLive);
  }, [token]);

  const stats = useMemo(() => ({
    total: contacts.length,
    extensions: contacts.filter((c) => c.type === 'internal_extension').length,
    external: contacts.filter(isExternal).length,
    favorites: contacts.filter((c) => c.favorite).length,
  }), [contacts]);

  const statusFor = useCallback((contact: Contact): ContactStatus | null => {
    if (contact.type !== 'internal_extension' || !contact.extension) return null;
    if (!live) return { label: 'Offline', color: colors.textTertiary, pulse: false, weight: 3 };
    const ext = contact.extension;
    const hasRinging = [...live.calls.values()].some((call) =>
      (call.state === 'ringing' || call.state === 'dialing') &&
      (call.extensions || []).includes(ext) &&
      (!contact.tenantId || !call.tenantId || call.tenantId === contact.tenantId),
    );
    if (hasRinging) return { label: 'Away', color: colors.warning, pulse: true, weight: 1 };
    const hasActive = [...live.calls.values()].some((call) =>
      (call.state === 'up' || call.state === 'held') &&
      (call.extensions || []).includes(ext) &&
      (!contact.tenantId || !call.tenantId || call.tenantId === contact.tenantId),
    );
    if (hasActive) return { label: 'On Call', color: colors.danger, pulse: true, weight: 2 };
    return { label: 'Available', color: colors.success, pulse: true, weight: 0 };
  }, [colors.danger, colors.success, colors.textTertiary, colors.warning, live]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts
      .filter((contact) => {
        if (filter === 'extensions') return contact.type === 'internal_extension';
        if (filter === 'external') return isExternal(contact);
        if (filter === 'favorites') return contact.favorite;
        return true;
      })
      .filter((contact) =>
        !q ||
        contact.displayName.toLowerCase().includes(q) ||
        (contact.extension || '').includes(q) ||
        (contact.primaryPhone?.numberRaw || '').includes(q) ||
        (contact.primaryEmail?.email || '').toLowerCase().includes(q),
      );
  }, [contacts, filter, query]);

  /**
   * Sort extensions by presence (available → ringing → on-call → offline),
   * then by extension number. External + favorites are A-Z.
   */
  const sortExtensions = useCallback((rows: Contact[]): Contact[] => {
    return [...rows].sort((a, b) => {
      const sa = statusFor(a);
      const sb = statusFor(b);
      const wa = sa?.weight ?? 3;
      const wb = sb?.weight ?? 3;
      if (wa !== wb) return wa - wb;
      const ea = parseInt(a.extension || '0', 10);
      const eb = parseInt(b.extension || '0', 10);
      if (Number.isFinite(ea) && Number.isFinite(eb) && ea !== eb) return ea - eb;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [statusFor]);

  const sortAlpha = useCallback((rows: Contact[]): Contact[] => {
    return [...rows].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }, []);

  const listItems = useMemo<ContactListItem[]>(() => {
    const items: ContactListItem[] = [];
    const addSection = (title: string, rows: Contact[]) => {
      if (!rows.length) return;
      items.push({ type: 'section', id: `section:${title}`, title, count: rows.length });
      rows.forEach((contact) => items.push({ type: 'contact', id: contact.id, contact }));
    };

    if (filter === 'extensions') {
      addSection('Extensions', sortExtensions(visible));
    } else if (filter === 'external') {
      addSection('External', sortAlpha(visible));
    } else if (filter === 'favorites') {
      addSection('Favorites', sortAlpha(visible));
    } else {
      addSection('Extensions', sortExtensions(visible.filter((c) => c.type === 'internal_extension')));
      addSection('External', sortAlpha(visible.filter(isExternal)));
      addSection('Favorites', sortAlpha(visible.filter((c) => c.favorite && c.type !== 'internal_extension' && !isExternal(c))));
    }
    return items;
  }, [filter, sortAlpha, sortExtensions, visible]);

  const callContact = useCallback((contact: Contact) => {
    const target = contactTarget(contact);
    if (target && sip.registrationState === 'registered') sip.dial(target);
  }, [sip]);

  const messageContact = useCallback((contact: Contact) => {
    Alert.alert('Message', `Open Chat to message ${contact.displayName}.`);
  }, []);

  const emailContact = useCallback((contact: Contact) => {
    const email = contact.primaryEmail?.email || contact.emails?.[0]?.email;
    if (email) Linking.openURL(`mailto:${email}`).catch(() => undefined);
  }, []);

  const emptyTitle = query.trim() ? 'No matching contacts' : 'No contacts yet';
  const emptySubtitle = query.trim()
    ? 'Try a different name, number, or extension.'
    : 'Tenant contacts and extensions will appear here.';

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerTitleWrap}>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>Contacts</Text>
          <Text style={[styles.headerSub, { color: colors.textSecondary }]} numberOfLines={1}>
            {stats.total} tenant contacts
          </Text>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity
            activeOpacity={0.78}
            style={[
              styles.headerIcon,
              styles.headerIconPrimary,
              { backgroundColor: colors.primaryMuted, borderColor: colors.primary + '33' },
            ]}
          >
            <Ionicons name="person-add-outline" size={19} color={colors.primary} />
          </TouchableOpacity>
          <TouchableOpacity
            activeOpacity={0.78}
            style={[styles.headerIcon, { backgroundColor: colors.surfaceElevated + 'cc', borderColor: colors.border }]}
          >
            <Ionicons name="ellipsis-vertical" size={19} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      </View>

      <View style={styles.searchRow}>
        <View style={[styles.searchBox, { backgroundColor: colors.surfaceElevated + 'cc', borderColor: colors.border }]}>
          <Ionicons name="search-outline" size={17} color={colors.textTertiary} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search contacts, extension, or name"
            placeholderTextColor={colors.textTertiary}
            style={[styles.searchInput, { color: colors.text }]}
            autoCapitalize="none"
            autoCorrect={false}
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name="close-circle" size={16} color={colors.textTertiary} />
            </TouchableOpacity>
          )}
        </View>
        <TouchableOpacity
          activeOpacity={0.78}
          style={[styles.filterButton, { backgroundColor: colors.surfaceElevated + 'cc', borderColor: colors.border }]}
        >
          <Ionicons name="options-outline" size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>

      <View style={styles.filterWrap}>
        <HorizontalFilterScroll marginBottom={spacing['3']}>
          <FilterChip id="all" label="All" icon="people-outline" value={filter} count={stats.total} color={colors.primary} onPress={setFilter} />
          <FilterChip id="extensions" label="Extensions" icon="people-circle-outline" value={filter} count={stats.extensions} color={colors.success} onPress={setFilter} />
          <FilterChip id="external" label="External" icon="globe-outline" value={filter} count={stats.external} color={colors.primary} onPress={setFilter} />
          <FilterChip id="favorites" label="Favorites" icon="star-outline" value={filter} count={stats.favorites} color={colors.warning} onPress={setFilter} />
        </HorizontalFilterScroll>
        {/* Soft fade on the right edge hints that more chips scroll horizontally. */}
        <LinearGradient
          pointerEvents="none"
          colors={[colors.bg + '00', colors.bg]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.filterFade}
        />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
          <Text style={[typography.body, { color: colors.textSecondary, marginTop: 12 }]}>Loading contacts...</Text>
        </View>
      ) : error ? (
        <EmptyState icon="alert-circle-outline" title="Could not load contacts" subtitle={error} />
      ) : listItems.length === 0 ? (
        <EmptyState
          icon={query.trim() ? 'search-outline' : 'person-outline'}
          title={emptyTitle}
          subtitle={emptySubtitle}
        />
      ) : (
        <FlatList
          data={listItems}
          keyExtractor={(item) => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={colors.primary} />}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => item.type === 'section' ? (
            <View style={styles.sectionHeader}>
              <Text style={[styles.sectionText, { color: colors.textTertiary }]}>
                {item.title}
                {typeof item.count === 'number' ? ` · ${item.count}` : ''}
              </Text>
              <TouchableOpacity style={styles.sortAction} activeOpacity={0.74}>
                <Ionicons name="swap-vertical-outline" size={13} color={colors.textTertiary} />
                <Text style={[styles.sortText, { color: colors.textTertiary }]}>Sort</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <ContactCard
              contact={item.contact}
              status={statusFor(item.contact)}
              onPress={() => setSelected(item.contact)}
              onCall={() => callContact(item.contact)}
              onMessage={() => messageContact(item.contact)}
              onMore={() => Alert.alert(item.contact.displayName, 'Contact actions', [
                { text: 'Favorite' },
                { text: 'Message', onPress: () => messageContact(item.contact) },
                { text: 'Call', onPress: () => callContact(item.contact) },
                { text: 'Cancel', style: 'cancel' },
              ])}
            />
          )}
        />
      )}

      <TouchableOpacity
        activeOpacity={0.82}
        style={[
          styles.fab,
          {
            backgroundColor: colors.primary + 'ee',
            borderColor: colors.white + '24',
            shadowColor: colors.primary,
          },
        ]}
      >
        <Ionicons name="person-add-outline" size={23} color="#fff" />
      </TouchableOpacity>

      <ContactDetailModal
        contact={selected}
        onClose={() => setSelected(null)}
        onCall={callContact}
        onMessage={messageContact}
        onEmail={emailContact}
      />
    </View>
  );
}

const FilterChip = memo(function FilterChip({
  id,
  label,
  icon,
  value,
  count,
  color,
  onPress,
}: {
  id: ContactFilter;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  value: ContactFilter;
  count: number;
  color: string;
  onPress: (next: ContactFilter) => void;
}) {
  const { colors } = useTheme();
  const active = value === id;
  const surface = teamFilterChipColors(active, color, colors);
  return (
    <TouchableOpacity
      activeOpacity={0.76}
      onPress={() => onPress(id)}
      style={[styles.filterChip, surface]}
    >
      <Ionicons name={icon} size={14} color={active ? color : colors.textTertiary} />
      <Text
        numberOfLines={1}
        style={[styles.filterText, { color: active ? color : colors.textSecondary }]}
      >
        {label}
      </Text>
      {count > 0 && (
        <View
          style={[
            styles.countBadge,
            {
              backgroundColor: active ? `${color}26` : colors.surfaceElevated,
              borderColor: active ? 'transparent' : colors.borderSubtle,
            },
          ]}
        >
          <Text style={[styles.countText, { color: active ? color : colors.textTertiary }]}>
            {count > 99 ? '99+' : count}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
});

const ContactCard = memo(function ContactCard({
  contact,
  status,
  onPress,
  onCall,
  onMessage,
  onMore,
}: {
  contact: Contact;
  status: ContactStatus | null;
  onPress: () => void;
  onCall: () => void;
  onMessage: () => void;
  onMore: () => void;
}) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const tone = status?.color ?? colors.textTertiary;

  const panResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 14 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
    onPanResponderMove: (_, gesture) => {
      translateX.setValue(Math.max(-112, Math.min(gesture.dx, 86)));
    },
    onPanResponderRelease: (_, gesture) => {
      const action = gesture.dx > 54 ? 'call' : gesture.dx < -54 ? 'message' : null;
      Animated.spring(translateX, { toValue: 0, useNativeDriver: true }).start();
      if (action === 'call') onCall();
      if (action === 'message') onMessage();
    },
  }), [onCall, onMessage, translateX]);

  const pressIn = useCallback(() => {
    Animated.spring(scale, { toValue: 0.98, speed: 30, bounciness: 0, useNativeDriver: true }).start();
  }, [scale]);
  const pressOut = useCallback(() => {
    Animated.spring(scale, { toValue: 1, speed: 25, bounciness: 4, useNativeDriver: true }).start();
  }, [scale]);

  const presenceLabel = status?.label ?? 'Offline';
  const onCallAccent = status?.label === 'On Call';

  return (
    <View style={styles.swipeWrap}>
      <View style={styles.swipeBg}>
        <View style={[styles.swipeHint, { backgroundColor: colors.successMuted }]}>
          <Ionicons name="call-outline" size={16} color={colors.success} />
        </View>
        <View style={[styles.swipeHint, { backgroundColor: colors.tealMuted }]}>
          <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.teal} />
        </View>
      </View>

      <Animated.View style={{ transform: [{ translateX }, { scale }] }} {...panResponder.panHandlers}>
        <TouchableOpacity
          activeOpacity={0.92}
          onPress={onPress}
          onPressIn={pressIn}
          onPressOut={pressOut}
          style={[
            styles.card,
            {
              backgroundColor: colors.surface,
              borderColor: onCallAccent ? colors.danger + '33' : colors.borderSubtle,
              shadowColor: '#000',
            },
          ]}
        >
          <View
            style={[
              styles.avatarWrap,
              onCallAccent
                ? { shadowColor: colors.danger, shadowOpacity: 0.25, shadowRadius: 10, elevation: 4 }
                : null,
            ]}
          >
            <Avatar name={contact.displayName} size="md" />
            <View style={[styles.presenceBadge, { borderColor: colors.surface, backgroundColor: colors.surface }]}>
              <PulseDot color={tone} size={10} active={status?.pulse ?? false} />
            </View>
          </View>

          <View style={styles.info}>
            <View style={styles.nameLine}>
              <Text style={[styles.nameText, { color: colors.text }]} numberOfLines={1}>
                {contact.displayName}
              </Text>
              {contact.favorite && <Ionicons name="star" size={13} color={colors.warning} />}
            </View>
            <Text style={[styles.metaText, { color: colors.textSecondary }]} numberOfLines={1}>
              {contactMeta(contact)}
            </Text>
            <View
              style={[
                styles.statusPill,
                {
                  backgroundColor: tone + '18',
                  borderColor: tone + '40',
                },
              ]}
            >
              <View style={[styles.statusDot, { backgroundColor: tone }]} />
              <Text style={[styles.statusPillText, { color: tone }]} numberOfLines={1}>
                {presenceLabel}
              </Text>
            </View>
          </View>

          <View style={styles.actionRow}>
            <TouchableOpacity
              onPress={onMessage}
              activeOpacity={0.74}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              style={[styles.actionBtn, { backgroundColor: colors.tealMuted, borderColor: colors.teal + '33' }]}
            >
              <Ionicons name="chatbubble-ellipses-outline" size={17} color={colors.teal} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onCall}
              activeOpacity={0.74}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              style={[
                styles.actionBtn,
                styles.actionBtnPrimary,
                { backgroundColor: colors.primary, borderColor: colors.primary, shadowColor: colors.primary },
              ]}
            >
              <Ionicons name="call" size={18} color="#fff" />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={onMore}
              activeOpacity={0.74}
              hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              style={styles.moreBtn}
            >
              <Ionicons name="ellipsis-horizontal" size={18} color={colors.textTertiary} />
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
});

function ContactDetailModal({
  contact,
  onClose,
  onCall,
  onMessage,
  onEmail,
}: {
  contact: Contact | null;
  onClose: () => void;
  onCall: (contact: Contact) => void;
  onMessage: (contact: Contact) => void;
  onEmail: (contact: Contact) => void;
}) {
  const { colors } = useTheme();
  return (
    <Modal visible={Boolean(contact)} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.modalBackdrop, { backgroundColor: colors.overlay }]}>
        {contact && (
          <View style={[styles.detailSheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={styles.sheetHandleWrap}>
              <View style={[styles.sheetHandle, { backgroundColor: colors.borderLight }]} />
            </View>
            <TouchableOpacity style={styles.closeButton} onPress={onClose}>
              <Ionicons name="close" size={20} color={colors.textSecondary} />
            </TouchableOpacity>
            <View style={styles.detailHeader}>
              <Avatar name={contact.displayName} size="xl" />
              <Text style={[typography.h2, { color: colors.text, marginTop: 14, textAlign: 'center' }]}>{contact.displayName}</Text>
              <Text style={[typography.bodySm, { color: colors.textSecondary, textAlign: 'center' }]}>
                {contact.company || contact.title || (contact.type === 'internal_extension' ? `Extension ${contact.extension}` : 'Contact')}
              </Text>
            </View>
            <View style={styles.detailActions}>
              <TouchableOpacity style={[styles.detailAction, { backgroundColor: colors.successMuted }]} onPress={() => onCall(contact)}>
                <Ionicons name="call" size={18} color={colors.success} />
                <Text style={[styles.detailActionText, { color: colors.success }]}>Call</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.detailAction, { backgroundColor: colors.tealMuted }]} onPress={() => onMessage(contact)}>
                <Ionicons name="chatbubble" size={18} color={colors.teal} />
                <Text style={[styles.detailActionText, { color: colors.teal }]}>Message</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.detailAction, { backgroundColor: colors.primaryMuted }]} onPress={() => onEmail(contact)}>
                <Ionicons name="mail" size={18} color={colors.primary} />
                <Text style={[styles.detailActionText, { color: colors.primary }]}>Email</Text>
              </TouchableOpacity>
            </View>
            <View style={[styles.detailBlock, { borderColor: colors.border, backgroundColor: colors.surfaceElevated }]}>
              {(contact.phones || []).map((phone) => (
                <Text key={phone.id || phone.numberRaw} style={[typography.bodySm, { color: colors.text }]}>
                  {phone.type}: {phone.numberRaw}
                </Text>
              ))}
              {contact.type === 'internal_extension' && contact.extension ? (
                <Text style={[typography.bodySm, { color: colors.text }]}>extension: {contact.extension}</Text>
              ) : null}
              {(contact.emails || []).map((email) => (
                <Text key={email.id || email.email} style={[typography.bodySm, { color: colors.textSecondary }]}>
                  {email.type}: {email.email}
                </Text>
              ))}
              {contact.notes ? <Text style={[typography.bodySm, { color: colors.textSecondary, marginTop: 8 }]}>{contact.notes}</Text> : null}
            </View>
            {contact.tags?.length ? (
              <View style={styles.tagRow}>
                {contact.tags.map((tag) => (
                  <View key={tag.id} style={[styles.tag, { backgroundColor: colors.primaryMuted }]}>
                    <Text style={[styles.tagText, { color: colors.primary }]}>{tag.name}</Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },

  header: {
    paddingHorizontal: spacing['5'],
    paddingBottom: spacing['3'],
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerTitleWrap: { flex: 1, minWidth: 0, paddingRight: spacing['3'] },
  headerTitle: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  headerSub: {
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '500',
    marginTop: 2,
  },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIconPrimary: {
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },

  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing['5'],
    marginBottom: spacing['3'],
  },
  searchBox: {
    flex: 1,
    height: 44,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchInput: {
    flex: 1,
    fontSize: 14.5,
    letterSpacing: 0,
    paddingVertical: 0,
  },
  filterButton: {
    width: 44,
    height: 44,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /** Wrapper so we can overlay a subtle fade on the right edge. */
  filterWrap: {
    position: 'relative',
  },
  filterFade: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 28,
  },

  /**
   * Chip geometry: fixed height, single-line label; parent ScrollView prevents wrapping.
   * NOTE: do not set `overflow: 'hidden'` — Android RN clips `borderRadius: 9999`
   * views to a rectangle when overflow is hidden + borderWidth > 0, chopping the pill.
   */
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 34,
    paddingHorizontal: 14,
    borderRadius: radius.full,
    borderWidth: 1,
    gap: 6,
  },
  filterText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  countBadge: {
    minWidth: 22,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
  },
  countText: {
    fontSize: 11,
    fontWeight: '800',
  },

  list: {
    paddingHorizontal: spacing['5'],
    paddingTop: spacing['1'],
    paddingBottom: 120,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing['4'],
    marginBottom: spacing['2'],
  },
  sectionText: {
    fontSize: 11,
    lineHeight: 16,
    fontWeight: '800',
    letterSpacing: 0.9,
    textTransform: 'uppercase',
    opacity: 0.7,
  },
  sortAction: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  sortText: { fontSize: 11, fontWeight: '700', opacity: 0.7 },

  /** Card row. Soft surface, hairline border, subtle shadow. Scales on press. */
  swipeWrap: { overflow: 'hidden', borderRadius: 18, marginBottom: 10 },
  swipeBg: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  swipeHint: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 76,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 18,
    borderWidth: 1,
    shadowOpacity: 0.08,
    shadowOffset: { width: 0, height: 4 },
    shadowRadius: 10,
    elevation: 1,
  },

  avatarWrap: {
    marginRight: 12,
    borderRadius: 20,
  },
  presenceBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },

  info: { flex: 1, minWidth: 0 },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 2 },
  nameText: {
    flex: 1,
    minWidth: 0,
    fontSize: 15.5,
    lineHeight: 20,
    fontWeight: '800',
    letterSpacing: -0.15,
  },
  metaText: {
    fontSize: 12.5,
    lineHeight: 16,
    opacity: 0.7,
    marginBottom: 5,
  },
  statusPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusPillText: {
    fontSize: 10.5,
    fontWeight: '800',
    letterSpacing: 0.2,
  },

  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginLeft: 10,
  },
  actionBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionBtnPrimary: {
    width: 40,
    height: 40,
    borderRadius: 20,
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  moreBtn: {
    width: 30,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },

  fab: {
    position: 'absolute',
    right: 22,
    bottom: 92,
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 18,
    elevation: 6,
  },

  modalBackdrop: { flex: 1, justifyContent: 'flex-end' },
  detailSheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    borderWidth: 1,
    paddingHorizontal: spacing['5'],
    paddingBottom: spacing['8'],
    paddingTop: spacing['3'],
    maxHeight: '88%',
  },
  sheetHandleWrap: { alignItems: 'center', marginBottom: 10 },
  sheetHandle: { width: 42, height: 5, borderRadius: 999 },
  closeButton: { position: 'absolute', top: 18, right: 18, zIndex: 2 },
  detailHeader: { alignItems: 'center', paddingTop: spacing['3'] },
  detailActions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: spacing['5'],
    marginBottom: spacing['4'],
  },
  detailAction: {
    flex: 1,
    borderRadius: radius.xl,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    gap: 5,
  },
  detailActionText: { fontSize: 12, fontWeight: '800', letterSpacing: 0.2 },
  detailBlock: {
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: spacing['4'],
    gap: 6,
  },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: spacing['4'] },
  tag: { borderRadius: radius.full, paddingHorizontal: 10, paddingVertical: 5 },
  tagText: { fontSize: 11, fontWeight: '800' },
});
