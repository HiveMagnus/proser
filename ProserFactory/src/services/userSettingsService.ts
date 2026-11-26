import fs from 'fs';
import path from 'path';

type UserIdentity = {
  id: number;
  username: string;
};

export interface UserSettings {
  profile: {
    displayName: string;
  };
  writing: {
    defaultGenre: string;
    writingStyle: string;
    targetAudience: string;
  };
}

type StoredUserSettings = Partial<{
  profile: Partial<UserSettings['profile']>;
  writing: Partial<UserSettings['writing']>;
  updatedAt: string;
}>;

export type UserSettingsPatch = Pick<StoredUserSettings, 'profile' | 'writing'>;

type SettingsStore = {
  version: 1;
  users: Record<string, StoredUserSettings>;
};

const EMPTY_SETTINGS: UserSettings = {
  profile: { displayName: '' },
  writing: { defaultGenre: '', writingStyle: '', targetAudience: '' },
};

function getSettingsFilePath(): string {
  return process.env.USER_SETTINGS_FILE || path.resolve(process.cwd(), 'data/user-settings.json');
}

function ensureStoreShape(raw: unknown): SettingsStore {
  if (!raw || typeof raw !== 'object') {
    return { version: 1, users: {} };
  }

  const users = (raw as { users?: unknown }).users;
  if (!users || typeof users !== 'object' || Array.isArray(users)) {
    return { version: 1, users: {} };
  }

  return {
    version: 1,
    users: users as Record<string, StoredUserSettings>,
  };
}

/**
 * Earlier releases stored per-user cloud provider keys (`ai`) that nothing
 * used. Drop them from the store so they are neither served nor kept at rest.
 */
function removeRetiredSecrets(store: SettingsStore): boolean {
  let changed = false;
  for (const settings of Object.values(store.users)) {
    if (settings && typeof settings === 'object' && hasOwn(settings, 'ai')) {
      delete (settings as Record<string, unknown>).ai;
      changed = true;
    }
  }
  return changed;
}

function readStore(): SettingsStore {
  const filePath = getSettingsFilePath();
  if (!fs.existsSync(filePath)) {
    return { version: 1, users: {} };
  }

  let store: SettingsStore;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    store = ensureStoreShape(JSON.parse(raw));
  } catch {
    return { version: 1, users: {} };
  }
  if (removeRetiredSecrets(store)) {
    try { writeStore(store); } catch { /* the next successful write retries */ }
  }
  return store;
}

function writeStore(store: SettingsStore): void {
  const filePath = getSettingsFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Keep the store owner-only, and replace it atomically so an interrupted
  // write cannot leave a truncated file.
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function hasOwn(obj: object | undefined, key: string): boolean {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function materializeSettings(user: UserIdentity, stored?: StoredUserSettings): UserSettings {
  const profile = stored?.profile;
  return {
    profile: {
      displayName: hasOwn(profile, 'displayName')
        ? String(profile?.displayName ?? '')
        : user.username,
    },
    writing: {
      defaultGenre: String(stored?.writing?.defaultGenre ?? EMPTY_SETTINGS.writing.defaultGenre),
      writingStyle: String(stored?.writing?.writingStyle ?? EMPTY_SETTINGS.writing.writingStyle),
      targetAudience: String(stored?.writing?.targetAudience ?? EMPTY_SETTINGS.writing.targetAudience),
    },
  };
}

function mergeStoredSettings(current: StoredUserSettings | undefined, patch: UserSettingsPatch): StoredUserSettings {
  return {
    profile: {
      ...(current?.profile ?? {}),
      ...(patch.profile ?? {}),
    },
    writing: {
      ...(current?.writing ?? {}),
      ...(patch.writing ?? {}),
    },
    updatedAt: new Date().toISOString(),
  };
}

class UserSettingsService {
  getForUser(user: UserIdentity): UserSettings {
    const store = readStore();
    return materializeSettings(user, store.users[String(user.id)]);
  }

  updateForUser(user: UserIdentity, patch: UserSettingsPatch): UserSettings {
    const store = readStore();
    const userKey = String(user.id);
    store.users[userKey] = mergeStoredSettings(store.users[userKey], patch);
    writeStore(store);
    return materializeSettings(user, store.users[userKey]);
  }
}

export const userSettingsService = new UserSettingsService();
