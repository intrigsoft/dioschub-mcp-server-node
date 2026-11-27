/**
 * A mock "Northwind" business app. It has its OWN auth — a session cookie it
 * mints at /login and validates on every data request. This stands in for the
 * real app the MCP server fronts. The point: this backend genuinely rejects
 * requests without a valid cookie, so the framework's credential pass-through
 * has to do real work — a fake that ignores auth wouldn't prove anything.
 */
import express, { type Express, type Request } from 'express';
import { randomUUID } from 'node:crypto';

interface Session {
  user: string;
  customerId: string;
}

export interface NorthwindBackend {
  app: Express;
  /** Simulate the app minting a session for a user; returns the cookie VALUE. */
  login(user: string, customerId: string): string;
  /** Simulate the user's session dying (logout / expiry). */
  invalidate(cookieValue: string): void;
}

const PRODUCTS = [
  { id: 1, name: 'Chai', price: 18 },
  { id: 2, name: 'Chang', price: 19 },
  { id: 3, name: 'Aniseed Syrup', price: 10 },
];

const ORDERS: Record<string, Array<{ id: number; total: number }>> = {
  ALFKI: [
    { id: 10643, total: 814.5 },
    { id: 10692, total: 878.0 },
  ],
  ANATR: [{ id: 10308, total: 88.8 }],
};

const COOKIE_NAME = 'nw_session';

/**
 * Accounts that can sign in through POST /login. Demo values only: a real app
 * checks its own user store. The test users example signs in through here.
 */
const ACCOUNTS: Record<string, { password: string; customerId: string }> = {
  ALFKI: { password: 'demo-password-not-real', customerId: 'ALFKI' },
};

function tokenFrom(req: Request): string | undefined {
  const cookie = req.header('cookie');
  if (!cookie) return undefined;
  const match = cookie.split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  return match?.slice(COOKIE_NAME.length + 1);
}

export function createNorthwindBackend(): NorthwindBackend {
  const sessions = new Map<string, Session>();
  const app = express();

  app.use((req, res, next) => {
    // Public: only /login is unauthenticated.
    if (req.path === '/login') return next();
    const token = tokenFrom(req);
    const session = token ? sessions.get(token) : undefined;
    if (!session) {
      res.status(401).json({ error: 'no session' });
      return;
    }
    (req as Request & { session: Session }).session = session;
    next();
  });

  // The app's own sign-in: username + password → session cookie.
  app.post('/login', express.json(), (req, res) => {
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const account = typeof username === 'string' ? ACCOUNTS[username] : undefined;
    if (!account || password !== account.password) {
      res.status(401).json({ error: 'bad credentials' });
      return;
    }
    const token = randomUUID();
    sessions.set(token, { user: username as string, customerId: account.customerId });
    res.json({ cookie: `${COOKIE_NAME}=${token}` });
  });

  app.get('/api/products', (_req, res) => {
    res.json(PRODUCTS);
  });

  app.get('/api/orders', (req, res) => {
    const { customerId } = (req as Request & { session: Session }).session;
    res.json(ORDERS[customerId] ?? []); // scoped to the cookie's user
  });

  app.get('/api/whoami', (req, res) => {
    res.json((req as Request & { session: Session }).session);
  });

  return {
    app,
    login(user, customerId) {
      const token = randomUUID();
      sessions.set(token, { user, customerId });
      return `${COOKIE_NAME}=${token}`;
    },
    invalidate(cookieValue) {
      const token = cookieValue.slice(COOKIE_NAME.length + 1);
      sessions.delete(token);
    },
  };
}
