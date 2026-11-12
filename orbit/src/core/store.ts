// localStorage helpers (§10). Keys carry the "orbit:" prefix and values are
// JSON. Every access is wrapped: a failed read returns the fallback and a
// failed write returns false, so the caller keeps the data in memory.

export const STORAGE_PREFIX = "orbit:";

/** Every key Orbit stores, without the prefix. "Erase all data" removes exactly these. */
export const STORAGE_KEYS = [
  "settings",
  "threads",
  "workspace",
  "conversations",
  "lastGreeting",
  "visits",
  "avatarSpot",
] as const;

export type StorageKey = (typeof STORAGE_KEYS)[number];

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Accessing localStorage itself can throw (e.g. blocked storage).
    return null;
  }
}

export function readJSON<T>(key: StorageKey, fallback: T): T {
  try {
    const raw = storage()?.getItem(STORAGE_PREFIX + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJSON(key: StorageKey, value: unknown): boolean {
  try {
    const s = storage();
    if (!s) return false;
    s.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKey(key: StorageKey): void {
  try {
    storage()?.removeItem(STORAGE_PREFIX + key);
  } catch {
    // Nothing to do: the key stays, which is the best we can manage.
  }
}

/** Removes exactly the seven Orbit keys. (The IndexedDB avatar is erased separately.) */
export function eraseAllStorage(): void {
  for (const key of STORAGE_KEYS) removeKey(key);
}
