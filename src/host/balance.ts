import type { Context } from '@deepseek-ai/cordis';
import { BALANCE_PATH, readCnyBalance, type CnyBalance } from '../shared/balance.ts';

/** One Platform wallet row as DSH's account service projects it. */
interface AccountWallet {
  readonly currency: 'CNY' | 'USD';
  readonly balance: string;
}

/** `AccountDetails['balance']` — independent query outcome, no credential crosses it. */
interface AccountBalanceDetails {
  readonly status: 'ready' | 'failed';
  readonly value?: readonly AccountWallet[];
  readonly bonusWallets?: readonly AccountWallet[];
}

/** The subset of the Host-only account service this route consumes. */
interface AccountService {
  getBalance(client: {
    version: string;
    locale: string;
    timezoneOffsetSeconds: number;
  }): Promise<AccountBalanceDetails | null>;
}

/** Parse one decimal money string into integer cents, rejecting anything else. */
function centsOf(text: string): number | undefined {
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? Math.round(value * 100) : undefined;
}

/**
 * Account-login wallet balance, read through DSH's own account service.
 * Signed-in users have no API key, so this is the only balance their login can
 * report: normal wallets are top-up funds and bonus wallets are granted funds.
 * Returns null when the host has no account service, nobody is signed in, or
 * the read fails — the route stays credential-free either way.
 */
export async function readAccountBalance(ctx: Context): Promise<CnyBalance | null> {
  const account = ctx.get('deepseekAccount') as AccountService | undefined;
  if (!account || typeof account.getBalance !== 'function') return null;
  const details = await account.getBalance({
    version: '0.10.6-fork.1',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  });
  if (!details || details.status !== 'ready') return null;
  const sumCny = (wallets: readonly AccountWallet[] | undefined): number | undefined => {
    let total = 0;
    let seen = false;
    for (const wallet of wallets ?? []) {
      if (wallet.currency !== 'CNY') continue;
      const value = centsOf(wallet.balance);
      if (value === undefined) return undefined;
      total += value;
      seen = true;
    }
    return seen ? total : undefined;
  };
  const toppedUp = sumCny(details.value);
  const granted = sumCny(details.bonusWallets);
  if (toppedUp === undefined && granted === undefined) return null;
  const money = (value: number): string => (value / 100).toFixed(2);
  return {
    total: money((toppedUp ?? 0) + (granted ?? 0)),
    granted: money(granted ?? 0),
    toppedUp: money(toppedUp ?? 0),
  };
}

interface LoaderEntry {
  readonly disabled?: boolean;
  readonly options?: { readonly name?: string; readonly config?: { apiKeyEnv?: string; baseURL?: string } };
}

/** Resolve the same reference as DSH's official API-key provider, only on Host. */
export async function readBalanceKey(ctx: Context): Promise<string | undefined> {
  const loader = ctx.get('loader') as { entries(): Iterable<LoaderEntry> } | undefined;
  const entry = loader && [...loader.entries()].find(entry => entry.disabled !== true
    && entry.options?.name === '@deepseek-ai/dsh-llm-deepseek-api-key');
  if (!entry) return undefined;
  const config = entry.options?.config;
  const environment = ctx.get('launchEnvironment') as { get(name: string): { value: string } | undefined } | undefined;
  const baseURL = config?.baseURL ?? (environment ? environment.get('DEEPSEEK_BASE_URL')?.value
    : process.env['DEEPSEEK_BASE_URL']) ?? 'https://api.deepseek.com/anthropic';
  // A custom endpoint's credential must never be sent to the official API.
  if (new URL(baseURL).origin !== 'https://api.deepseek.com') return undefined;
  const ref = config?.apiKeyEnv ?? 'DEEPSEEK_API_KEY';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return undefined;
  const credentials = ctx.get('credentials') as { resolve(ref: string): Promise<{ value: string } | undefined> } | undefined;
  const key = credentials ? (await credentials.resolve(ref))?.value
    : environment ? environment.get(ref)?.value : process.env[ref];
  return key?.trim() || undefined;
}

/** Authenticated renderer route; only normalized balances leave the Host. */
export function mountDeepSeekBalance(ctx: Context, isEnabled: () => boolean): void {
  ctx.inject(['connection'], injected => {
    if (!isEnabled()) return;
    const connection = injected.get('connection') as { fetch: { register(route: {
      path: string; methods: readonly string[]; requestBody: 'buffered';
      fetch(request: Request): Promise<Response>;
    }): () => Promise<void> } } | undefined;
    if (!connection) return;
    ctx.effect(() => connection.fetch.register({
      path: BALANCE_PATH, methods: ['GET'], requestBody: 'buffered',
      fetch: async request => {
        const reply = (state: string, balance: unknown = null) => Response.json({ state, balance }, {
          headers: { 'cache-control': 'no-store' },
        });
        if (!isEnabled()) return reply('unconfigured');
        try {
          const key = await readBalanceKey(injected);
          if (!key) {
            // Account login carries no API key: report the Platform wallet instead.
            const account = await readAccountBalance(ctx).catch(() => null);
            return account ? reply('ready', account) : reply('unconfigured');
          }
          const response = await fetch('https://api.deepseek.com/user/balance', {
            headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
            redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
          });
          if (response.status === 401 || response.status === 403) return reply('unauthorized');
          if (!response.ok) return reply('error');
          const balance = readCnyBalance(await response.json());
          return reply(balance ? 'ready' : 'no-cny', balance);
        } catch {
          // Never forward upstream bodies or exceptions that might contain credentials.
          return reply('error');
        }
      },
    }), 'deepseek: balance route');
  });
}
