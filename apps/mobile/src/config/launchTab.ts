import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Which tab the app opens on after launch (Izzy 2026-08-05: some users live in
 * the dialer, others in Recents/Messages/Voicemail).
 *
 * Device-local preference (AsyncStorage), shared by iOS and Android — the tab
 * navigator is the same JS on both. It only feeds `initialRouteName`, which
 * react-navigation reads once at mount, so notification deep links, incoming
 * call screens, and in-app navigation are untouched.
 *
 * Ids MUST match the `Tab.Screen name=` values in TabNavigator exactly.
 */
export type LaunchTabId = 'Team' | 'Keypad' | 'Recent' | 'Chat' | 'Voicemail';

export const LAUNCH_TAB_KEY = 'cc_launch_tab_v1';

export const DEFAULT_LAUNCH_TAB: LaunchTabId = 'Team';

/** Cycle order for the Settings row; labels are the user-facing names. */
export const LAUNCH_TAB_OPTIONS: Array<{ id: LaunchTabId; label: string }> = [
  { id: 'Team', label: 'Team (default)' },
  { id: 'Keypad', label: 'Keypad' },
  { id: 'Recent', label: 'Recents' },
  { id: 'Chat', label: 'Messages' },
  { id: 'Voicemail', label: 'Voicemail' },
];

export function launchTabLabel(id: LaunchTabId): string {
  return LAUNCH_TAB_OPTIONS.find((o) => o.id === id)?.label ?? 'Team (default)';
}

function isLaunchTabId(v: unknown): v is LaunchTabId {
  return LAUNCH_TAB_OPTIONS.some((o) => o.id === v);
}

/** Read the stored preference; unknown/missing values fall back to the default
 *  so a stale key from a removed tab can never strand the navigator. */
export async function getLaunchTab(): Promise<LaunchTabId> {
  try {
    const raw = await AsyncStorage.getItem(LAUNCH_TAB_KEY);
    return isLaunchTabId(raw) ? raw : DEFAULT_LAUNCH_TAB;
  } catch {
    return DEFAULT_LAUNCH_TAB;
  }
}

export async function setLaunchTab(id: LaunchTabId): Promise<void> {
  try {
    await AsyncStorage.setItem(LAUNCH_TAB_KEY, id);
  } catch {
    /* preference is best-effort; next launch just uses the default */
  }
}
