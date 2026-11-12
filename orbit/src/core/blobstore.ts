// The VRM avatar file (§7.4, §10): IndexedDB database `orbit-files`, store
// `files`, key `avatar`, holding {name, data, savedAt}. Every call opens the
// database, runs one transaction and closes it again. IndexedDB is the only
// thing Orbit keeps outside localStorage, and only for this one file.

export const DB_NAME = "orbit-files";
export const DB_VERSION = 1;
export const STORE_NAME = "files";
export const AVATAR_KEY = "avatar";

export interface AvatarRecord {
  /** The file name the user picked, e.g. "callie.vrm". */
  name: string;
  data: ArrayBuffer;
  /** Date.now() when it was saved. */
  savedAt: number;
}

/** The part of IDBFactory this module uses, so tests can pass fake-indexeddb's. */
export type IDBFactoryLike = Pick<IDBFactory, "open">;

/** The factory to use: the one passed in, else the page's own. Undefined when there is none. */
function pickFactory(idb: IDBFactoryLike | undefined): IDBFactoryLike | undefined {
  if (idb) return idb;
  try {
    return (globalThis as { indexedDB?: IDBFactoryLike }).indexedDB ?? undefined;
  } catch {
    // Some browsers throw on the property itself when storage is blocked.
    return undefined;
  }
}

function openDatabase(idb: IDBFactoryLike): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Could not open the avatar database."));
  });
}

/** Opens the database, runs one transaction on the store and closes the database again. */
async function transact<T>(
  idb: IDBFactoryLike,
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openDatabase(idb);
  try {
    // Another tab upgrading the database must never be kept waiting by us.
    db.onversionchange = () => db.close();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const request = work(tx.objectStore(STORE_NAME));
      // Wait for the transaction, not the request: only then is a write durable.
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error ?? request.error ?? new Error("The avatar transaction failed."));
      tx.onabort = () => reject(tx.error ?? new Error("The avatar transaction was aborted."));
    });
  } finally {
    db.close();
  }
}

/** A stored value as an AvatarRecord, or null when it is not one. */
function readRecord(v: unknown): AvatarRecord | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  // The tag check also holds for an ArrayBuffer made in another realm.
  if (typeof o.name !== "string" || Object.prototype.toString.call(o.data) !== "[object ArrayBuffer]") return null;
  return { name: o.name, data: o.data as ArrayBuffer, savedAt: typeof o.savedAt === "number" ? o.savedAt : 0 };
}

/**
 * Stores the avatar, replacing any earlier one. Rejects if IndexedDB is not
 * available or the write fails, so the caller can tell the user.
 */
export async function saveAvatar(name: string, data: ArrayBuffer, idb?: IDBFactoryLike): Promise<void> {
  const factory = pickFactory(idb);
  if (!factory) throw new Error("This browser cannot store files (IndexedDB is not available).");
  const record: AvatarRecord = { name, data, savedAt: Date.now() };
  await transact(factory, "readwrite", (store) => store.put(record, AVATAR_KEY));
}

/**
 * The stored avatar, or null when there is none. Never rejects: if IndexedDB is
 * missing or unreadable she simply has no VRM body.
 */
export async function loadAvatar(idb?: IDBFactoryLike): Promise<AvatarRecord | null> {
  const factory = pickFactory(idb);
  if (!factory) return null;
  try {
    return readRecord(await transact<unknown>(factory, "readonly", (store) => store.get(AVATAR_KEY)));
  } catch {
    return null;
  }
}

/**
 * Removes the stored avatar. Resolves at once when IndexedDB is not available
 * (nothing can be stored); rejects if the delete itself fails.
 */
export async function deleteAvatar(idb?: IDBFactoryLike): Promise<void> {
  const factory = pickFactory(idb);
  if (!factory) return;
  await transact(factory, "readwrite", (store) => store.delete(AVATAR_KEY));
}
