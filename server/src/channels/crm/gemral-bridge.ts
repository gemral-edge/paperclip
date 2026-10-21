// Gemral Data Bridge — enrich CRM customer with Gemral App data
// READ-ONLY from Gemral tables (profiles, course_enrollments, affiliate_profiles, etc.)

import { supabase } from '../zalo-personal/supabase.js';

export interface GemralData {
  is_app_user: boolean;
  chatbot_tier: string;
  scanner_tier: string;
  course_tier: string;
  tier_expires: { chatbot?: string; scanner?: string };
  courses_enrolled: Array<{ id: string; title: string; progress: number }>;
  total_courses: number;
  is_affiliate: boolean;
  affiliate_role?: string;
  affiliate_tier?: string;
  affiliate_code?: string;
  affiliate_total_sales?: number;
  affiliate_commission?: number;
  affiliate_balance?: number;
  is_kol: boolean;
  kol_status?: string;
  kol_followers?: number;
  shopify_orders_count: number;   // tên giữ nguyên: Shopify + lõi commerce (YSC-007)
  shopify_total_spent: number;    // VND: Shopify + đơn commerce VND đã trả
  commerce_orders_count?: number;
  commerce_total_usd?: number;
  app_registered_at?: string;
  last_synced_at: string;
}

/**
 * Match CRM customer → Gemral profile by phone or email.
 * Phone normalization: +84xxx → 0xxx and vice versa.
 *
 * UNIQUENESS GUARD: only auto-links when EXACTLY ONE profile matches. If a
 * phone/email matches 2+ profiles we return null instead of silently picking
 * one — picking the wrong profile would expose another customer's data (the
 * #1 risk in the identity-centralization plan). Ambiguous matches fall through
 * to the next key, then to manual review.
 */
export async function matchGemralUser(
  phone?: string | null,
  email?: string | null,
): Promise<string | null> {
  if (phone) {
    const normalized = normalizePhone(phone);
    if (normalized) {
      const altPhone = normalized.startsWith('0')
        ? '+84' + normalized.slice(1)
        : '0' + normalized.slice(3);

      const { data } = await supabase
        .from('profiles')
        .select('id')
        .or(`phone.eq.${normalized},phone.eq.${altPhone}`)
        .limit(2);

      if (data && data.length === 1) return data[0].id;
      if (data && data.length > 1) {
        console.warn(`[GemralBridge] Phone khớp ${data.length} profiles — bỏ qua auto-link (chống lộ data nhầm)`);
      }
    }
  }

  if (email) {
    const { data } = await supabase
      .from('profiles')
      .select('id')
      .eq('email', email.toLowerCase())
      .limit(2);

    if (data && data.length === 1) return data[0].id;
    if (data && data.length > 1) {
      console.warn(`[GemralBridge] Email khớp ${data.length} profiles — bỏ qua auto-link (chống lộ data nhầm)`);
    }
  }

  return null;
}

/**
 * Enrich CRM customer with all Gemral data (profiles, courses, affiliate, Shopify).
 * Saves result to crm_customers.gemral_data JSONB.
 */
export async function enrichWithGemralData(
  customerId: string,
  gemralUserId: string,
): Promise<GemralData> {
  // 1. Profile — tiers, role
  const { data: profile } = await supabase
    .from('profiles')
    .select('chatbot_tier, scanner_tier, course_tier, role, chatbot_tier_expires_at, scanner_tier_expires_at, created_at')
    .eq('id', gemralUserId)
    .single();

  // 2. Course enrollments
  const { data: enrollments } = await supabase
    .from('course_enrollments')
    .select('course_id, progress_percentage, is_active')
    .eq('user_id', gemralUserId)
    .eq('is_active', true);

  // Fetch course titles
  const courseIds = (enrollments || []).map(e => e.course_id);
  const courseTitles: Record<string, string> = {};
  if (courseIds.length > 0) {
    const { data: courses } = await supabase
      .from('courses')
      .select('id, title')
      .in('id', courseIds);
    for (const c of courses || []) {
      courseTitles[c.id] = c.title;
    }
  }

  // 3. Affiliate profile
  const { data: affiliate } = await supabase
    .from('affiliate_profiles')
    .select('role, ctv_tier, referral_code, total_sales, total_commission, available_balance, is_active')
    .eq('user_id', gemralUserId)
    .maybeSingle();

  // 4. KOL application
  const { data: kolApp } = await supabase
    .from('partnership_applications')
    .select('application_type, status, total_followers')
    .eq('user_id', gemralUserId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  // 5. Shopify orders (match by email)
  const { data: customer } = await supabase
    .from('crm_customers')
    .select('email')
    .eq('id', customerId)
    .single();

  let shopifyCount = 0;
  let shopifySpent = 0;
  if (customer?.email) {
    const { data: shopifyData, count } = await supabase
      .from('shopify_orders')
      .select('total_price', { count: 'exact' })
      .eq('email', customer.email);
    shopifyCount = count || 0;
    shopifySpent = (shopifyData || []).reduce(
      (sum: number, o: any) => sum + (parseFloat(o.total_price) || 0), 0,
    );
  }

  // 5b. YSC-007: đơn cửa hàng Yinyang mới (lõi commerce, từ 21/10/2026) — chỉ đơn thật đã trả tiền.
  // Cộng vào 2 trường cũ (đơn vị VND như Shopify) để mọi nơi đang đọc tổng chi không phải đổi; USD tách riêng.
  let commerceCount = 0;
  let commerceUsdMinor = 0;
  if (customer?.email) {
    const { data: co, error: coErr } = await supabase
      .from('commerce_orders')
      .select('total_minor, currency')
      .eq('email', String(customer.email).trim().toLowerCase())
      .eq('livemode', true)
      .in('status', ['paid', 'fulfilled', 'partially_refunded']);
    if (coErr) console.warn(`[GemralBridge] commerce orders lookup failed: ${coErr.message}`);
    for (const o of co || []) {
      commerceCount++;
      if (o.currency === 'vnd') shopifySpent += Number(o.total_minor) || 0;
      else commerceUsdMinor += Number(o.total_minor) || 0;
    }
    shopifyCount += commerceCount;
  }

  // 6. Build GemralData
  const gemralData: GemralData = {
    is_app_user: !!profile,
    chatbot_tier: profile?.chatbot_tier || 'free',
    scanner_tier: profile?.scanner_tier || 'free',
    course_tier: profile?.course_tier || 'free',
    tier_expires: {
      chatbot: profile?.chatbot_tier_expires_at || undefined,
      scanner: profile?.scanner_tier_expires_at || undefined,
    },
    courses_enrolled: (enrollments || []).map(e => ({
      id: e.course_id,
      title: courseTitles[e.course_id] || e.course_id,
      progress: e.progress_percentage || 0,
    })),
    total_courses: (enrollments || []).length,
    is_affiliate: !!affiliate?.is_active,
    affiliate_role: affiliate?.role,
    affiliate_tier: affiliate?.ctv_tier,
    affiliate_code: affiliate?.referral_code,
    affiliate_total_sales: affiliate?.total_sales ? Number(affiliate.total_sales) : undefined,
    affiliate_commission: affiliate?.total_commission ? Number(affiliate.total_commission) : undefined,
    affiliate_balance: affiliate?.available_balance ? Number(affiliate.available_balance) : undefined,
    is_kol: kolApp?.application_type === 'kol' && kolApp?.status === 'approved',
    kol_status: kolApp?.status,
    kol_followers: kolApp?.total_followers,
    shopify_orders_count: shopifyCount,
    shopify_total_spent: shopifySpent,
    commerce_orders_count: commerceCount,
    commerce_total_usd: commerceUsdMinor / 100,
    app_registered_at: profile?.created_at,
    last_synced_at: new Date().toISOString(),
  };

  // 7. Save to CRM customer
  await supabase.from('crm_customers').update({
    gemral_user_id: gemralUserId,
    gemral_data: gemralData,
    updated_at: new Date().toISOString(),
  }).eq('id', customerId);

  console.log(`[GemralBridge] Enriched ${customerId}: app_user=${gemralData.is_app_user}, courses=${gemralData.total_courses}, affiliate=${gemralData.is_affiliate}`);

  return gemralData;
}

function normalizePhone(phone: string): string {
  let cleaned = phone.replace(/[\s\-\(\)\.]/g, '');
  if (cleaned.startsWith('+84')) cleaned = '0' + cleaned.slice(3);
  if (cleaned.startsWith('84') && cleaned.length === 11) cleaned = '0' + cleaned.slice(2);
  return cleaned;
}
