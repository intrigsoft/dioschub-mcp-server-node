import type { BindIdentity, PublicTestUser, TestUserEntry, TestUserLoginResult } from './types.js';

/** `capabilities.experimental` entry declared on initialize when test users are on. */
export const TEST_USERS_CAPABILITY = 'dioschub/testUsers';
/** Default environment variable holding the test users list. */
export const DEFAULT_TEST_USERS_ENV = 'DIOSC_TEST_USERS';
/** Fixed lifetime of a test handle and its stored artifacts: 60 minutes, no refresh. */
export const TEST_HANDLE_TTL_SECONDS = 60 * 60;
/** Default attempts per minute on the two ticket routes together. */
export const DEFAULT_TEST_RATE_LIMIT_PER_MINUTE = 30;

export const MAX_TEST_USERS = 50;
export const TEST_USER_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_NAME_LENGTH = 100;
const MAX_NOTE_LENGTH = 200;

/**
 * The test users list (or the `testUsers` config) is invalid. The message names
 * the source and the entry's position, never a value from the list.
 */
export class TestUsersConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TestUsersConfigError';
  }
}

/** One loaded entry: the public part, kept apart from the private part. */
export interface LoadedTestUser {
  readonly public: Readonly<PublicTestUser>;
  readonly credentials: unknown;
}

export interface LoadedTestUsers {
  readonly byKey: ReadonlyMap<string, LoadedTestUser>;
  /** Public parts only, in list order: the `test-users` answer. */
  readonly publicList: readonly Readonly<PublicTestUser>[];
  /** Where the list came from (the variable's name or `testUsers.users`). */
  readonly source: string;
}

/**
 * Read and check the list. Returns null when there is none (unset, empty, or
 * `[]`): the feature is off. Throws TestUsersConfigError when the list is bad.
 *
 * Never put a value from the list in a message: not the parse error either,
 * since V8's JSON.parse messages quote the input.
 */
export function loadTestUsers(
  config: { users?: string | TestUserEntry[]; env?: string },
  env: NodeJS.ProcessEnv = process.env,
): LoadedTestUsers | null {
  if (config.env !== undefined && (typeof config.env !== 'string' || config.env.length === 0)) {
    throw new TestUsersConfigError('testUsers.env must be a non-empty string');
  }
  const envName = config.env ?? DEFAULT_TEST_USERS_ENV;
  const source = config.users !== undefined ? 'testUsers.users' : envName;
  const raw: unknown = config.users !== undefined ? config.users : env[envName];

  let list: unknown;
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string') {
    if (raw.trim() === '') return null;
    try {
      list = JSON.parse(raw);
    } catch {
      throw new TestUsersConfigError(`${source} is not valid JSON`);
    }
  } else {
    list = raw;
  }

  if (!Array.isArray(list)) throw new TestUsersConfigError(`${source} must be a JSON list`);
  if (list.length === 0) return null;
  if (list.length > MAX_TEST_USERS) {
    throw new TestUsersConfigError(`${source} has more than ${MAX_TEST_USERS} entries`);
  }

  const byKey = new Map<string, LoadedTestUser>();
  const firstIndex = new Map<string, number>();
  const publicList: Readonly<PublicTestUser>[] = [];

  list.forEach((item: unknown, index) => {
    const at = `${source}: entry ${index}`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new TestUsersConfigError(`${at} must be an object`);
    }
    const entry = item as Record<string, unknown>;

    const key = entry.key;
    if (typeof key !== 'string' || !TEST_USER_KEY_PATTERN.test(key)) {
      throw new TestUsersConfigError(`${at}: key must match ${TEST_USER_KEY_PATTERN.source}`);
    }
    const seen = firstIndex.get(key);
    if (seen !== undefined) {
      throw new TestUsersConfigError(`${at}: key is the same as entry ${seen}'s; keys must be unique`);
    }

    const name = entry.name;
    if (typeof name !== 'string' || charLength(name) < 1 || charLength(name) > MAX_NAME_LENGTH) {
      throw new TestUsersConfigError(`${at}: name must be a string of 1 to ${MAX_NAME_LENGTH} characters`);
    }

    const note = entry.note;
    if (note !== undefined && (typeof note !== 'string' || charLength(note) > MAX_NOTE_LENGTH)) {
      throw new TestUsersConfigError(`${at}: note must be a string of at most ${MAX_NOTE_LENGTH} characters`);
    }

    const readOnly = entry.readOnly;
    if (readOnly !== undefined && typeof readOnly !== 'boolean') {
      throw new TestUsersConfigError(`${at}: readOnly must be true or false`);
    }

    if (!('credentials' in entry) || entry.credentials === undefined || entry.credentials === null) {
      throw new TestUsersConfigError(`${at}: credentials is required`);
    }

    // Pick the public fields one by one: an unknown field never reaches the list.
    const pub: PublicTestUser = Object.freeze({
      key,
      name,
      ...(note !== undefined ? { note } : {}),
      readOnly: readOnly === true,
    });
    firstIndex.set(key, index);
    byKey.set(key, Object.freeze({ public: pub, credentials: entry.credentials }));
    publicList.push(pub);
  });

  return { byKey, publicList: Object.freeze(publicList), source };
}

function charLength(s: string): number {
  return [...s].length;
}

/**
 * Check what `login` returned and keep only the fields the Hub contract names,
 * so a script cannot forward anything extra in the identity by accident.
 */
export function readLoginResult<TAuth>(
  value: unknown,
): { auth: TAuth; identity: BindIdentity } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { auth, identity } = value as Partial<TestUserLoginResult<TAuth>>;
  if (auth === undefined || auth === null) return null;
  if (typeof identity !== 'object' || identity === null) return null;
  const { userId, username, role } = identity as Partial<BindIdentity>;
  if (typeof userId !== 'string' || typeof username !== 'string') return null;
  if (typeof role !== 'object' || role === null) return null;
  if (typeof role.id !== 'string' || typeof role.name !== 'string') return null;
  return { auth, identity: { userId, username, role: { id: role.id, name: role.name } } };
}

/**
 * Attempts per sliding minute, for the whole process. In memory: each replica
 * counts on its own.
 */
export class AttemptLimiter {
  private readonly stamps: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Count one attempt. Returns 0 when allowed, else the seconds until one is. */
  take(): number {
    const t = this.now();
    while (this.stamps.length > 0 && this.stamps[0]! <= t - this.windowMs) this.stamps.shift();
    if (this.stamps.length >= this.max) {
      return Math.max(1, Math.ceil((this.stamps[0]! + this.windowMs - t) / 1000));
    }
    this.stamps.push(t);
    return 0;
  }
}
