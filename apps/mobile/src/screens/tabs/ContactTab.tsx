import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Linking,
  Modal,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { PanGestureHandler, State as GestureState } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme } from '../../context/ThemeContext';
import { useAuth } from '../../context/AuthContext';
import { useSip } from '../../context/SipContext';
import { EmptyState } from '../../components/ui/EmptyState';
import { Avatar } from '../../components/ui/Avatar';
import { HorizontalFilterScroll } from '../../components/ui/HorizontalFilterScroll';
import { AppActionSheet, AppConfirmDialog } from '../../components/ui/AppPopup';
import { showAppAlert } from '../../components/ui/appAlert';
import * as Clipboard from 'expo-clipboard';
import { createContact, deleteContact, getContacts, mobileQueryKeys } from '../../api/client';
import type { Contact } from '../../types';
import { typography } from '../../theme/typography';
import { teamFilterChipColors } from '../../theme/filterChipColors';
import { radius, spacing } from '../../theme/spacing';
import { ImportPhoneContactsModal } from '../../components/ImportPhoneContactsModal';
import {
  checkContactsPermission,
  requestContactsPermission,
  type PermissionState,
} from '../../contacts/phoneContactsImport';
import { saveContactToDevice } from '../../contacts/deviceContactsWrite';
import { duplicatePhoneMessage } from '../../contacts/duplicatePhoneMessage';

type ContactFilter = 'all' | 'extensions' | 'external' | 'favorites';
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

function contactSubtitle(contact: Contact): string {
  return contactMeta(contact);
}

function isExternal(contact: Contact): boolean {
  return contact.type !== 'internal_extension';
}


export function ContactTab() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { token } = useAuth();
  const nav = useNavigation<any>();
  const sip = useSip();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ContactFilter>('all');
  const [selected, setSelected] = useState<Contact | null>(null);
  const [menuContact, setMenuContact] = useState<Contact | null>(null);
  const [showAddContact, setShowAddContact] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Contact | null>(null);
  const [showImportFromPhone, setShowImportFromPhone] = useState(false);
  const [resolvedImportPermission, setResolvedImportPermission] = useState<PermissionState | undefined>(undefined);

  const contactsQuery = useQuery({
    queryKey: mobileQueryKeys.contacts(''),
    enabled: Boolean(token),
    queryFn: () => getContacts(token!, ''),
    staleTime: 3 * 60 * 1000,
    gcTime: 20 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
  });

  const contacts = contactsQuery.data?.rows ?? [];
  const loading = contactsQuery.isLoading && contacts.length === 0;
  // Spinner shows ONLY on a user pull-to-refresh; background/focus refetches stay silent.
  const [refreshing, setRefreshing] = useState(false);
  const error = contactsQuery.error && contacts.length === 0 ? 'Could not load contacts.' : null;
  const refetchContacts = contactsQuery.refetch;
  const load = useCallback(() => {
    refetchContacts().catch(() => undefined);
  }, [refetchContacts]);
  const onUserRefresh = useCallback(() => {
    setRefreshing(true);
    refetchContacts().catch(() => undefined).finally(() => setRefreshing(false));
  }, [refetchContacts]);

  useFocusEffect(
    useCallback(() => {
      if (!contactsQuery.data || contactsQuery.isStale) load();
    }, [contactsQuery.data, contactsQuery.isStale, load]),
  );

  // Request contacts permission within the button's gesture context so Android
  // shows the system dialog immediately rather than after async modal boot().
  const openImportContacts = useCallback(async () => {
    const current = await checkContactsPermission();
    let resolved: PermissionState = current;
    if (current.status === 'undetermined') {
      resolved = await requestContactsPermission();
    }
    setResolvedImportPermission(resolved);
    setShowImportFromPhone(true);
  }, []);

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
   * Sort extensions by extension number (numeric), then name. External +
   * favorites are A-Z. (Live presence/BLF lives only on the Team tab.)
   */
  const sortExtensions = useCallback((rows: Contact[]): Contact[] => {
    return [...rows].sort((a, b) => {
      const ea = parseInt(a.extension || '0', 10);
      const eb = parseInt(b.extension || '0', 10);
      if (Number.isFinite(ea) && Number.isFinite(eb) && ea !== eb) return ea - eb;
      return a.displayName.localeCompare(b.displayName);
    });
  }, []);

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
    if (!target) return;
    // No registration gate (2026-07-30): dial() self-registers when needed and
    // presents the call screen immediately — the stale-snapshot guard here was
    // silently eating swipe-to-call taps. See RecentTab.handleCall.
    console.log('[DIAL] contacts swipe → dial ' + target);
    sip.dial(target).catch((e) =>
      console.warn('[DIAL] contacts dial rejected: ' + (e instanceof Error ? e.message : String(e))),
    );
  }, [sip]);

  const messageContact = useCallback((contact: Contact) => {
    if (contact.type === 'internal_extension') {
      const ext = (contact.extension || '').trim();
      if (!ext) {
        showAppAlert('Message', `No extension is available for ${contact.displayName}.`);
        return;
      }
      nav.navigate('Chat', { composeNumber: ext, composeName: contact.displayName, composeKind: 'internal' });
      return;
    }
    const number = (contact.primaryPhone?.numberRaw || '').trim();
    if (!number) {
      showAppAlert('Message', `No phone number is available for ${contact.displayName}.`);
      return;
    }
    nav.navigate('Chat', { composeNumber: number, composeName: contact.displayName, composeKind: 'external' });
  }, [nav]);

  const emailContact = useCallback((contact: Contact) => {
    const email = contact.primaryEmail?.email || contact.emails?.[0]?.email;
    if (email) Linking.openURL(`mailto:${email}`).catch(() => undefined);
  }, []);

  /**
   * Ask before deleting, and open the confirm dialog only AFTER the sheet that
   * requested it has finished dismissing. Two React Native <Modal>s animating
   * at once on iOS is the exact freeze documented in AddContactModal (no view
   * controller owns the window, the app stops taking touches) — presenting over
   * a settled screen avoids it.
   */
  const requestDeleteContact = useCallback((contact: Contact) => {
    if (contact.type === 'internal_extension') return;
    setSelected(null);
    setMenuContact(null);
    setTimeout(() => setPendingDelete(contact), 300);
  }, []);

  const confirmDeleteContact = useCallback(() => {
    const contact = pendingDelete;
    setPendingDelete(null);
    if (!contact || !token) return;
    // Drop the row from the cache first so the list responds instantly. On
    // success the cache is already correct and needs no refetch — with the
    // whole directory now paged in, an invalidate would re-download every
    // contact just to learn about one deletion. Only a FAILURE refetches, to
    // put the row back.
    queryClient.setQueryData(mobileQueryKeys.contacts(''), (old: any) => {
      if (!old?.rows) return old;
      const rows = old.rows.filter((row: Contact) => row.id !== contact.id);
      if (rows.length === old.rows.length) return old;
      return {
        ...old,
        rows,
        stats: old.stats ? { ...old.stats, total: Math.max(0, (old.stats.total ?? 1) - 1) } : old.stats,
      };
    });
    deleteContact(token, contact.id)
      .then(() => {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
      })
      .catch((e: any) => {
        const code = String(e?.message || '');
        showAppAlert(
          'Could not delete contact',
          code.includes('extension_contacts_are_read_only')
            ? 'Extensions belong to your phone system and cannot be deleted here.'
            : code.includes('not_found')
              ? 'That contact no longer exists.'
              : 'Please try again.',
        );
        queryClient.invalidateQueries({ queryKey: mobileQueryKeys.contacts('') }).catch(() => undefined);
      });
  }, [pendingDelete, queryClient, token]);

  // Stable renderItem — an inline renderItem closure forces VirtualizedList to
  // re-render every mounted cell on each parent render (part of the measured
  // Contacts-tab stalls, freeze investigation 2026-07-28). Depends only on
  // stable callbacks + theme colors.
  const renderContactItem = useCallback(({ item }: { item: ContactListItem }) => (
    item.type === 'section' ? (
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
        onPress={() => setSelected(item.contact)}
        onCall={() => callContact(item.contact)}
        onMessage={() => messageContact(item.contact)}
        onMore={() => setMenuContact(item.contact)}
      />
    )
  ), [colors.textTertiary, callContact, messageContact]);

  const emptyTitle = query.trim() ? 'No matching contacts' : 'No contacts yet';
  const emptySubtitle = query.trim()
    ? 'Try a different name, number, or extension.'
    : 'Tenant contacts and extensions will appear here.';

  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.headerTitleWrap}>
          <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>Contacts</Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.78}
          onPress={() => { void openImportContacts(); }}
          style={[
            styles.headerIcon,
            { backgroundColor: colors.surfaceElevated, borderColor: colors.border, marginRight: 8 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Import contacts from phone"
        >
          <Ionicons name="cloud-download-outline" size={18} color={colors.text} />
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.78}
          onPress={() => setShowAddContact(true)}
          style={[
            styles.headerIcon,
            styles.headerIconPrimary,
            { backgroundColor: colors.primary, borderColor: colors.primary, shadowColor: colors.primary },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Add contact"
        >
          <Ionicons name="person-add" size={19} color="#fff" />
        </TouchableOpacity>
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
      </View>

      <HorizontalFilterScroll marginBottom={spacing['3']}>
        <FilterChip id="all" label="All" value={filter} color={colors.primary} onPress={setFilter} />
        <FilterChip id="extensions" label="Extensions" value={filter} color={colors.success} onPress={setFilter} />
        <FilterChip id="external" label="External" value={filter} color={colors.primary} onPress={setFilter} />
        <FilterChip id="favorites" label="Favorites" value={filter} color={colors.warning} onPress={setFilter} />
      </HorizontalFilterScroll>

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
          action={!query.trim() ? (
            <TouchableOpacity
              activeOpacity={0.84}
              onPress={() => { void openImportContacts(); }}
              style={[styles.emptyImportBtn, { backgroundColor: colors.primary, shadowColor: colors.primary }]}
            >
              <Ionicons name="cloud-download-outline" size={17} color="#fff" />
              <Text style={[typography.labelLg, { color: '#fff', marginLeft: 8 }]}>Import from phone</Text>
            </TouchableOpacity>
          ) : undefined}
        />
      ) : (
        <FlatList
          data={listItems}
          keyExtractor={(item) => item.id}
          // PERF (freeze investigation 2026-07-28): measured 1.6–7.2s JS-thread
          // stalls isolated to this tab (autonomous tab-bisect runs E/F/C).
          // Defaults pre-render ~21 screens of rows; with a large directory
          // that builds hundreds of card views in one JS turn. Render one
          // screen and fill ahead lazily; renderItem is stabilized below so
          // memoized rows are not re-rendered by unrelated parent state.
          initialNumToRender={10}
          maxToRenderPerBatch={8}
          updateCellsBatchingPeriod={60}
          windowSize={5}
          removeClippedSubviews
          // iOS needs bounce enabled for pull-to-refresh; Android unchanged
          // (see IOS_WORK_ANDROID_GUARDRAILS.md).
          bounces={Platform.OS === 'ios'}
          alwaysBounceVertical={Platform.OS === 'ios'}
          overScrollMode="never"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onUserRefresh} tintColor={colors.primary} colors={[colors.primary]} progressBackgroundColor={colors.surface} />}
          contentContainerStyle={styles.list}
          renderItem={renderContactItem}
        />
      )}

      <ContactDetailModal
        contact={selected}
        onClose={() => setSelected(null)}
        onCall={callContact}
        onMessage={messageContact}
        onEmail={emailContact}
        onDelete={requestDeleteContact}
      />

      <AddContactModal
        visible={showAddContact}
        onClose={() => setShowAddContact(false)}
        onCreated={() => {
          setShowAddContact(false);
          queryClient.invalidateQueries({ queryKey: mobileQueryKeys.contacts('') }).catch(() => undefined);
        }}
      />
      <ImportPhoneContactsModal
        visible={showImportFromPhone}
        authToken={token}
        initialPermission={resolvedImportPermission}
        onClose={() => {
          setShowImportFromPhone(false);
          setResolvedImportPermission(undefined);
        }}
        onImported={(result) => {
          if (result.imported > 0 || result.duplicatesMerged > 0) {
            queryClient.invalidateQueries({ queryKey: mobileQueryKeys.contacts('') }).catch(() => undefined);
          }
        }}
      />
      <AppActionSheet
        visible={Boolean(menuContact)}
        title={menuContact?.displayName}
        message={menuContact ? contactSubtitle(menuContact) : undefined}
        onClose={() => setMenuContact(null)}
        actions={[
          { label: 'Favorite', icon: 'star-outline', muted: true },
          { label: 'Message', icon: 'chatbubble-ellipses-outline', onPress: () => menuContact && messageContact(menuContact) },
          { label: 'Call', icon: 'call-outline', onPress: () => menuContact && callContact(menuContact) },
          // Extensions are live PBX users, not saved contacts — the server
          // refuses to delete them, so the option is not offered.
          ...(menuContact && menuContact.type !== 'internal_extension'
            ? [{
                label: 'Delete Contact',
                icon: 'trash-outline' as const,
                destructive: true,
                onPress: () => menuContact && requestDeleteContact(menuContact),
              }]
            : []),
        ]}
      />
      <AppConfirmDialog
        visible={Boolean(pendingDelete)}
        title="Delete contact?"
        message={pendingDelete ? `${pendingDelete.displayName} will be removed from your company's contacts.` : undefined}
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDeleteContact}
        onClose={() => setPendingDelete(null)}
      />
    </View>
  );
}

const FilterChip = memo(function FilterChip({
  id,
  label,
  value,
  color,
  onPress,
}: {
  id: ContactFilter;
  label: string;
  value: ContactFilter;
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
      <Text
        numberOfLines={1}
        style={[styles.filterText, { color: active ? color : colors.textSecondary }]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
});

const ContactCard = memo(function ContactCard({
  contact,
  onPress,
  onCall,
  onMessage,
  onMore,
}: {
  contact: Contact;
  onPress: () => void;
  onCall: () => void;
  onMessage: () => void;
  onMore: () => void;
}) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;

  // Full parity with RecentTab's row swipe (2026-07-30): rubber-banded drag,
  // early horizontal claim, arm haptic, flick-or-distance commit, and — the
  // fix for rows freezing mid-swipe — an onPanResponderTerminate that springs
  // the row home when the gesture is stolen (scroll, modal, navigation). The
  // old copy had no terminate handler, so an interrupted swipe left the card
  // stuck translated off-position.
  const ACTION_THRESHOLD = 44;
  const FLICK_MIN_DX = 24;
  // gesture-handler velocityX is px/SECOND (PanResponder's vx was px/ms).
  const FLICK_MIN_VX = 450;
  const MAX_DRAG = 104;
  const armedRef = useRef<null | 'call' | 'message'>(null);

  // Live-callback refs — see RecentTab: the handlers read the latest props
  // through refs so re-renders can never orphan an in-flight gesture.
  const onCallRef = useRef(onCall);
  onCallRef.current = onCall;
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  // MODERN GESTURE ENGINE (2026-07-30) — see RecentTab's CallCard for the full
  // story: PanResponder was losing a native race against the FlatList scroll
  // recognizer (granted → terminated, no release), so most swipes did nothing.
  // PanGestureHandler locks the swipe natively after 12px horizontal travel.
  // Tap-through guard — see RecentTab: a swipe must never also open the
  // contact detail sheet on finger-up.
  const suppressPressRef = useRef(false);

  const onPanEvent = useCallback(
    (e: any) => {
      const dx = e.nativeEvent.translationX as number;
      if (Math.abs(dx) > 6) suppressPressRef.current = true;
      let v = dx;
      if (v > ACTION_THRESHOLD) v = ACTION_THRESHOLD + (v - ACTION_THRESHOLD) * 0.35;
      else if (v < -ACTION_THRESHOLD) v = -ACTION_THRESHOLD + (v + ACTION_THRESHOLD) * 0.35;
      translateX.setValue(Math.max(-MAX_DRAG, Math.min(v, MAX_DRAG)));
      const armed = dx > ACTION_THRESHOLD ? 'call' : dx < -ACTION_THRESHOLD ? 'message' : null;
      if (armed !== armedRef.current) {
        armedRef.current = armed;
        if (armed) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
        }
      }
    },
    [translateX],
  );

  const onPanStateChange = useCallback(
    (e: any) => {
      const { state, translationX: dx, velocityX } = e.nativeEvent;
      const done =
        state === GestureState.END ||
        state === GestureState.CANCELLED ||
        state === GestureState.FAILED;
      if (!done) return;
      const springHome = () =>
        Animated.spring(translateX, {
          toValue: 0,
          useNativeDriver: true,
          speed: 18,
          bounciness: 8,
        }).start();
      if (state !== GestureState.END) {
        armedRef.current = null;
        springHome();
        return;
      }
      const rightCommit =
        dx > ACTION_THRESHOLD || (dx > FLICK_MIN_DX && velocityX > FLICK_MIN_VX);
      const leftCommit =
        dx < -ACTION_THRESHOLD || (dx < -FLICK_MIN_DX && velocityX < -FLICK_MIN_VX);
      const action = rightCommit ? 'call' : leftCommit ? 'message' : null;
      console.log(
        '[SWIPE] contacts release dx=' + dx.toFixed(0) +
        ' vx=' + velocityX.toFixed(0) + ' action=' + (action || 'none'),
      );
      springHome();
      armedRef.current = null;
      // Release the tap guard once the touch sequence is safely over.
      setTimeout(() => {
        suppressPressRef.current = false;
      }, 250);
      if (action) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
        // Defer so the row visibly springs back before we act/navigate.
        setTimeout(() => {
          if (action === 'call') onCallRef.current();
          else onMessageRef.current();
        }, 10);
      }
    },
    [translateX],
  );

  const pressIn = useCallback(() => {
    Animated.spring(scale, { toValue: 0.98, speed: 30, bounciness: 0, useNativeDriver: true }).start();
  }, [scale]);
  const pressOut = useCallback(() => {
    Animated.spring(scale, { toValue: 1, speed: 25, bounciness: 4, useNativeDriver: true }).start();
  }, [scale]);

  const callHintOpacity = translateX.interpolate({
    inputRange: [0, ACTION_THRESHOLD],
    outputRange: [0, 1],
    extrapolate: 'clamp',
  });
  const callHintScale = translateX.interpolate({
    inputRange: [0, ACTION_THRESHOLD],
    outputRange: [0.6, 1],
    extrapolate: 'clamp',
  });
  const msgHintOpacity = translateX.interpolate({
    inputRange: [-ACTION_THRESHOLD, 0],
    outputRange: [1, 0],
    extrapolate: 'clamp',
  });
  const msgHintScale = translateX.interpolate({
    inputRange: [-ACTION_THRESHOLD, 0],
    outputRange: [1, 0.6],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.swipeWrap}>
      <View style={styles.swipeBg}>
        <Animated.View
          style={[
            styles.swipeHint,
            {
              backgroundColor: colors.successMuted,
              opacity: callHintOpacity,
              transform: [{ scale: callHintScale }],
            },
          ]}
        >
          <Ionicons name="call-outline" size={16} color={colors.success} />
        </Animated.View>
        <Animated.View
          style={[
            styles.swipeHint,
            {
              backgroundColor: colors.tealMuted,
              opacity: msgHintOpacity,
              transform: [{ scale: msgHintScale }],
            },
          ]}
        >
          <Ionicons name="chatbubble-ellipses-outline" size={16} color={colors.teal} />
        </Animated.View>
      </View>

      <PanGestureHandler
        activeOffsetX={[-12, 12]}
        failOffsetY={[-12, 12]}
        onGestureEvent={onPanEvent}
        onHandlerStateChange={onPanStateChange}
      >
        <Animated.View style={{ transform: [{ translateX }, { scale }] }}>
        <TouchableOpacity
          activeOpacity={0.92}
          onPress={() => {
            if (suppressPressRef.current) return;
            onPress();
          }}
          onPressIn={pressIn}
          onPressOut={pressOut}
          style={[
            styles.card,
            {
              backgroundColor: colors.surface,
              borderColor: colors.borderSubtle,
              shadowColor: '#000',
            },
          ]}
        >
          <View style={styles.avatarWrap}>
            <Avatar name={contact.displayName} size="md" />
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
      </PanGestureHandler>
    </View>
  );
});

function AddContactModal({
  visible,
  onClose,
  onCreated,
}: {
  visible: boolean;
  onClose: () => void;
  onCreated: () => void;
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

  const reset = () => {
    setFirstName('');
    setLastName('');
    setPhone('');
    setEmail('');
    setCompany('');
    setNotes('');
    setSubmitting(false);
  };

  const close = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const hasName = firstName.trim() || lastName.trim();
  const hasContact = phone.trim() || email.trim();
  const canSubmit = !submitting && hasName && hasContact;

  const submit = async () => {
    if (!canSubmit || !token) return;
    setSubmitting(true);
    try {
      await createContact(token, {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        company: company.trim() || undefined,
        notes: notes.trim() || undefined,
        phones: phone.trim() ? [{ type: 'mobile', numberRaw: phone.trim(), isPrimary: true }] : [],
        emails: email.trim() ? [{ type: 'work', email: email.trim(), isPrimary: true }] : [],
      });
      // Mirror into the device address book (Google/iCloud) so it backs up &
      // syncs like WhatsApp. Best-effort — never blocks the save flow.
      //
      // APP-FREEZE FIX (Izzy 2026-07-31) — see the matching comment in
      // components/AddContactModal.tsx. This mirror can raise the system
      // Contacts permission dialog; kicking it off in the same tick as the
      // sheet dismissal let iOS present that alert while the modal was still
      // going away, leaving the app unable to accept touches. Close first,
      // mirror after the animation settles.
      const devicePayload = {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        displayName: `${firstName.trim()} ${lastName.trim()}`.trim() || phone.trim(),
        company: company.trim(),
        phones: phone.trim() ? [{ numberRaw: phone.trim(), type: 'mobile' }] : [],
        emails: email.trim() ? [{ email: email.trim(), type: 'work' }] : [],
      };
      reset();
      onCreated();
      setTimeout(() => { void saveContactToDevice(devicePayload); }, 700);
    } catch (e: any) {
      const msg = String(e?.message || '').toUpperCase();
      if (msg.includes('DUPLICATE_PHONE')) {
        showAppAlert('Already in your contacts', duplicatePhoneMessage(e?.existingContactName));
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
            <Text style={[styles.addHeaderTitle, { color: colors.text }]}>New Contact</Text>
            <TouchableOpacity
              onPress={submit}
              disabled={!canSubmit}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
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
            alwaysBounceVertical={false}
            overScrollMode="never"
            keyboardShouldPersistTaps="handled"
          >
          <View style={styles.fieldGroup}>
            <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>FIRST NAME</Text>
            <View style={[styles.fieldInput, styles.fieldInputFull, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
                <TextInput
                  value={firstName}
                  onChangeText={setFirstName}
                  placeholder="First name"
                  placeholderTextColor={colors.textTertiary}
                  style={[styles.fieldInputText, { color: colors.text }]}
                  autoCapitalize="words"
                />
              </View>
          </View>

          <View style={styles.fieldGroup}>
            <Text style={[styles.fieldLabel, { color: colors.textTertiary }]}>LAST NAME</Text>
            <View style={[styles.fieldInput, styles.fieldInputFull, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
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
            <View style={[styles.fieldInput, styles.fieldInputFull, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
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
            <View style={[styles.fieldInput, styles.fieldInputFull, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
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
            <View style={[styles.fieldInput, styles.fieldInputFull, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
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
            <View style={[styles.fieldInput, styles.fieldInputFull, styles.fieldInputMultiline, { backgroundColor: colors.surfaceElevated, borderColor: colors.border }]}>
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

/**
 * Copy a value to the clipboard with a short confirmation (Izzy 2026-08-01:
 * "after I go into a contact, I should be able to copy-paste their name").
 * Applied to the name, every phone number and every email in the detail sheet,
 * since they are all things people copy out to paste somewhere else.
 */
async function copyContactValue(label: string, value: string | null | undefined) {
  const v = (value || '').trim();
  if (!v) return;
  await Clipboard.setStringAsync(v).catch(() => undefined);
  showAppAlert('Copied', v.length > 60 ? `${label} copied` : v);
}

function ContactDetailModal({
  contact,
  onClose,
  onCall,
  onMessage,
  onEmail,
  onDelete,
}: {
  contact: Contact | null;
  onClose: () => void;
  onCall: (contact: Contact) => void;
  onMessage: (contact: Contact) => void;
  onEmail: (contact: Contact) => void;
  onDelete: (contact: Contact) => void;
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
              <TouchableOpacity
                onPress={() => copyContactValue('Name', contact.displayName)}
                activeOpacity={0.6}
                accessibilityRole="button"
                accessibilityLabel={`Copy name ${contact.displayName}`}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 14 }}
              >
                <Text style={[typography.h2, { color: colors.text, textAlign: 'center' }]}>{contact.displayName}</Text>
                <Ionicons name="copy-outline" size={15} color={colors.textSecondary} />
              </TouchableOpacity>
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
                <TouchableOpacity
                  key={phone.id || phone.numberRaw}
                  onPress={() => copyContactValue('Number', phone.numberRaw)}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={`Copy number ${phone.numberRaw}`}
                >
                  <Text style={[typography.bodySm, { color: colors.text }]}>
                    {phone.type}: {phone.numberRaw}
                  </Text>
                </TouchableOpacity>
              ))}
              {contact.type === 'internal_extension' && contact.extension ? (
                <Text style={[typography.bodySm, { color: colors.text }]}>extension: {contact.extension}</Text>
              ) : null}
              {(contact.emails || []).map((email) => (
                <TouchableOpacity
                  key={email.id || email.email}
                  onPress={() => copyContactValue('Email', email.email)}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel={`Copy email ${email.email}`}
                >
                  <Text style={[typography.bodySm, { color: colors.textSecondary }]}>
                    {email.type}: {email.email}
                  </Text>
                </TouchableOpacity>
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
            {contact.type !== 'internal_extension' ? (
              <TouchableOpacity
                activeOpacity={0.82}
                onPress={() => onDelete(contact)}
                style={[styles.deleteButton, { backgroundColor: colors.dangerMuted, borderColor: colors.danger + '33' }]}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${contact.displayName}`}
              >
                <Ionicons name="trash-outline" size={17} color={colors.danger} />
                <Text style={[styles.deleteButtonText, { color: colors.danger }]}>Delete Contact</Text>
              </TouchableOpacity>
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
  headerIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIconPrimary: {
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  emptyImportBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 18,
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
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

  /**
   * Android clips the bottom curve of fully-rounded bordered pills when the
   * pill has a fixed `height` — the hidden font-metrics padding inside
   * `<Text>` pushes the text past the border box. Use `paddingVertical`
   * instead of `height`, and turn off `includeFontPadding` on the label.
   * Never set `overflow: 'hidden'` — that also clips the rounded corners.
   */
  filterChip: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    height: 36,
    paddingHorizontal: 16,
    borderRadius: 18,
    borderWidth: 1,
  },
  filterText: {
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.2,
    textAlign: 'center',
    includeFontPadding: false,
    textAlignVertical: 'center',
  },

  list: {
    paddingHorizontal: spacing['5'],
    paddingTop: spacing['1'],
    paddingBottom: spacing['5'],
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
  addFormScroll: {
    flexShrink: 1,
  },
  addFormContent: {
    paddingBottom: spacing['2'],
  },
  fieldGroup: {
    marginBottom: spacing['4'],
  },
  fieldLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.9,
    marginBottom: 8,
    marginLeft: 4,
  },
  fieldInput: {
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 50,
  },
  fieldInputFull: {
    alignSelf: 'stretch',
  },
  fieldInputMultiline: {
    minHeight: 96,
    paddingVertical: 12,
    alignItems: 'flex-start',
  },
  fieldInputText: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
  },
  addHint: {
    fontSize: 12,
    textAlign: 'center',
    marginTop: spacing['2'],
    fontStyle: 'italic',
  },
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
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: spacing['4'],
    paddingVertical: 13,
    borderRadius: 16,
    borderWidth: 1,
  },
  deleteButtonText: { fontSize: 15, fontWeight: '800' },
});
