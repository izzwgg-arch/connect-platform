// Persistent storage for the offline op queue (AsyncStorage, already a mobile dep).
// Sensitive payloads should be minimized; secure fields go through expo-secure-store
// elsewhere. The queue holds operational intent (scan tokens, status changes), not secrets.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { serialize, deserialize, type QueuedOp } from "./offlineQueue";

const KEY = "cc_delivery_opqueue_v1";

export async function loadQueue(): Promise<QueuedOp[]> {
  try {
    return deserialize(await AsyncStorage.getItem(KEY));
  } catch {
    return [];
  }
}

export async function saveQueue(queue: QueuedOp[]): Promise<void> {
  try {
    await AsyncStorage.setItem(KEY, serialize(queue));
  } catch {
    /* best-effort; queue stays in memory */
  }
}

export async function clearQueue(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
