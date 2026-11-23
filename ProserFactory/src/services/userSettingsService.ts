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
  ai: {
    openaiKey: string;
    anthropicKey: string;
  };
  writing: {
    defaultGenre: string;
    writingStyle: string;
    targetAudience: string;
  };
}

type StoredUserSettings = Partial<{
  profile: Partial<UserSettings['profile']>;
  ai: Partial<UserSettings['ai']>;
  writing: Partial<UserSettings['writing']>;
  updatedAt: string;
}>;

type SettingsStore = {
  version: 1;
  users: Record<string, StoredUserSettings>;
};

const EMPTY_SETTINGS: UserSettings = {
  profile: { displayName: '' },
  ai: { openaiKey: '', anthropicKey: '' },
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

function readStore(): SettingsStore {
  const filePath = getSettingsFilePath();
  if (!fs.existsSync(filePath)) {
    return { version: 1, users: {} };
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return ensureStoreShape(JSON.parse(raw));
  } catch {
    return { version: 1, users: {} };
  }
}

function writeStore(store: SettingsStore): void {
  const filePath = getSettingsFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // The store holds provider API keys: keep it owner-only, and replace it
  // atomically so an interrupted write cannot leave a truncated file.
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
    ai: {
      openaiKey: String(stored?.ai?.openaiKey ?? EMPTY_SETTINGS.ai.openaiKey),
      anthropicKey: String(stored?.ai?.anthropicKey ?? EMPTY_SETTINGS.ai.anthropicKey),
    },
    writing: {
      defaultGenre: String(stored?.writing?.defaultGenre ?? EMPTY_SETTINGS.writing.defaultGenre),
      writingStyle: String(stored?.writing?.writingStyle ?? EMPTY_SETTINGS.writing.writingStyle),
      targetAudience: String(stored?.writing?.targetAudience ?? EMPTY_SETTINGS.writing.targetAudience),
    },
  };
}

function mergeStoredSettings(current: StoredUserSettings | undefined, patch: StoredUserSettings): StoredUserSettings {
  return {
    profile: {
      ...(current?.profile ?? {}),
      ...(patch.profile ?? {}),
    },
    ai: {
      ...(current?.ai ?? {}),
      ...(patch.ai ?? {}),
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

  updateForUser(user: UserIdentity, patch: StoredUserSettings): UserSettings {
    const store = readStore();
    const userKey = String(user.id);
    store.users[userKey] = mergeStoredSettings(store.users[userKey], patch);
    writeStore(store);
    return materializeSettings(user, store.users[userKey]);
  }
}

export const userSettingsService = new UserSettingsService();
