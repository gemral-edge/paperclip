import { describe, it, expect } from 'vitest';
import { handleCheckEdgeAccess } from '../crm/edge-access.js';

type Rows = Record<string, any>;
// Minimal chainable supabase mock: every builder resolves to the table's canned result.
function mockDb(tables: Rows) {
  const calls: Array<{ table: string; filters: any[] }> = [];
  const from = (table: string) => {
    const rec = { table, filters: [] as any[] };
    calls.push(rec);
    const res = tables[table] ?? { data: null, error: null };
    const b: any = {
      select: () => b,
      eq: (c: string, v: any) => { rec.filters.push([c, v]); return b; },
      ilike: (c: string, v: any) => { rec.filters.push([c, v]); return b; },
      is: () => b, order: () => b, limit: () => b,
      maybeSingle: () => Promise.resolve(res),
      then: (ok: any, ko: any) => Promise.resolve(res).then(ok, ko),
    };
    return b;
  };
  return { db: { from } as any, calls };
}
const ctx = (db: any, verified: string | null) =>
  ({ supabase: db, agentSlug: 'edge-sales-closer', sessionKey: 's', verifiedCustomerId: verified, channelName: 'cskh-internal' });

const base = {
  crm_customers: { data: { id: 'c1', email: 'A@x.com', shopify_customer_email: null, gemral_user_id: 'u1' }, error: null },
  edge_subscriptions: { data: { plan: 'pro', status: 'trialing', billing_interval: 'month', provider: 'stripe', current_period_end: '2026-11-10T00:00:00Z', updated_at: 'x' }, error: null },
  edge_subscription_history: { data: [{ plan_before: 'free', plan_after: 'pro', status_before: null, status_after: 'trialing', reason: 'webhook', changed_at: 't' }], error: null },
  profiles: { data: { scanner_tier: 'tier1', scanner_tier_expires_at: null }, error: null },
  edge_api_keys: { data: null, error: null, count: 2 },
};

describe('check_edge_access', () => {
  it('returns plan, trial flag, history, tier, key presence without secrets', async () => {
    const { db } = mockDb(base);
    const r = await handleCheckEdgeAccess({ customer_id: 'c1' }, ctx(db, 'c1'));
    expect(r.ok).toBe(true);
    const d: any = r.data;
    expect(d.edge_subscription).toMatchObject({ plan: 'pro', status: 'trialing', is_trial: true, billing_interval: 'month' });
    expect(d.recent_plan_changes).toHaveLength(1);
    expect(d.scanner_tier).toBe('tier1');
    expect(d.has_active_api_key).toBe(true);
    expect(JSON.stringify(d)).not.toMatch(/key_hash|provider_sub_id|provider_customer_id/);
  });
  it('verified customer wins over a different customer_id arg', async () => {
    const { db, calls } = mockDb(base);
    await handleCheckEdgeAccess({ customer_id: 'OTHER' }, ctx(db, 'c1'));
    expect(calls.find((c) => c.table === 'crm_customers')!.filters).toContainEqual(['id', 'c1']);
  });
  it('refuses an email that is not the customer\'s own', async () => {
    const { db } = mockDb(base);
    const r = await handleCheckEdgeAccess({ email: 'victim@y.com' }, ctx(db, 'c1'));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('email_mismatch');
  });
  it('accepts own email case-insensitively', async () => {
    const { db } = mockDb(base);
    expect((await handleCheckEdgeAccess({ email: 'a@X.com' }, ctx(db, 'c1'))).ok).toBe(true);
  });
  it('reports unlinked when no gemral user can be resolved', async () => {
    const { db } = mockDb({ ...base, crm_customers: { data: { id: 'c1', email: null, shopify_customer_email: null, gemral_user_id: null }, error: null } });
    const r = await handleCheckEdgeAccess({}, ctx(db, 'c1'));
    expect(r.ok).toBe(true);
    expect((r.data as any).linked).toBe(false);
  });
  it('handles customer without Edge subscription', async () => {
    const { db } = mockDb({ ...base, edge_subscriptions: { data: null, error: null } });
    const r = await handleCheckEdgeAccess({}, ctx(db, 'c1'));
    expect((r.data as any).edge_subscription).toBeNull();
  });
  it('errors when no customer id at all', async () => {
    const { db } = mockDb(base);
    expect((await handleCheckEdgeAccess({}, ctx(db, null))).error).toBe('missing_customer_id');
  });
});
