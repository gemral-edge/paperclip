// create_order (YSC-004, plan crypto-pattern-scanner 2026-10-21-YINYANG-SHOPIFY-FLOWS-TO-COMMERCE-CORE §5.1):
// CSKH tạo đơn THẬT trên lõi commerce qua edge fn commerce-admin `order.create` (giá tính server-side, VietQR).
// Thay create_order cũ (agent tự điền giá, chỉ ghi crm_orders) và create_shopify_order (Shopify đã đóng).
// KHÔNG có cách đánh dấu đã trả tiền: tiền về chỉ qua casso-webhook.
import * as fs from 'fs';
import { createHash } from 'crypto';

const FN_URL = `${(process.env.GEMRAL_SUPABASE_URL || 'https://pgfkbcnzqozzkohwbgbk.supabase.co').replace(/\/+$/, '')}/functions/v1/commerce-admin`;

/** commerce-admin chỉ nhận khoá backend (sb_secret). Tiến trình MCP stdio của agent không có biến này → đọc server/.env. */
function backendKey(): string {
  if (process.env.SB_SECRET_BACKEND) return process.env.SB_SECRET_BACKEND;
  const candidates = [process.env.PAPERCLIP_ENV_PATH, 'C:/Users/Jennie Chu/Desktop/Projects/paperclip/server/.env']
    .filter(Boolean) as string[];
  for (const p of candidates) {
    try {
      for (const raw of fs.readFileSync(p, 'utf-8').split(/\r?\n/)) {
        const m = /^\s*SB_SECRET_BACKEND\s*=\s*(.+?)\s*$/.exec(raw);
        if (m) return m[1].replace(/^["']|["']$/g, '');
      }
    } catch { /* thử file kế */ }
  }
  return '';
}

interface ItemIn { ref?: unknown; variant_id?: unknown; slug?: unknown; shopify_variant_id?: unknown; quantity?: unknown; qty?: unknown }

/** Cùng khách + cùng hàng + cùng ngày (giờ VN) = cùng đơn — agent gọi lại ở lượt sau không ra đơn thứ 2. */
export function deriveIdemKey(who: string, items: { ref: string; qty: number }[], now = new Date()): string {
  const day = new Date(now.getTime() + 7 * 3600_000).toISOString().slice(0, 10);
  const sig = items.map((i) => `${i.ref}x${i.qty}`).sort().join(',');
  return `cskh:${createHash('sha256').update(`${who.toLowerCase()}|${sig}|${day}`).digest('hex').slice(0, 32)}`;
}

export function normalizeItems(raw: unknown, fallbackRef?: unknown, fallbackQty?: unknown): { ref: string; qty: number }[] {
  const list: ItemIn[] = Array.isArray(raw) && raw.length ? raw as ItemIn[]
    : fallbackRef != null ? [{ ref: fallbackRef, quantity: fallbackQty }] : [];
  return list.slice(0, 20).map((i) => ({
    ref: String(i.ref ?? i.variant_id ?? i.slug ?? i.shopify_variant_id ?? '').trim(),
    qty: Math.max(1, Math.trunc(Number(i.quantity ?? i.qty ?? 1)) || 1),
  })).filter((i) => i.ref);
}

export interface CommerceProductHit {
  id?: string;
  ref: string; // slug — truyền thẳng vào create_order items[].ref
  title: string;
  title_en?: string | null;
  subtitle?: string | null;
  kind: string;
  price_vnd: number | null;
  variants: { variant_id: string; sku: string | null; option: string | null; price_vnd: number | null; in_stock: boolean | null }[];
  url: string;
}

/** Bỏ dấu tiếng Việt → slug, để "thach anh tim" / "thạch anh tím" đều khớp slug. */
export function toSlugish(q: string): string {
  return q.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Mọi SP đang bán trên Yinyang (published + site yinyang) — 1 nơi map dữ liệu lõi → hit (YSC-005, YSC-034). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function listCommerceProducts(supabase: any): Promise<CommerceProductHit[]> {
  const { data, error } = await supabase.from('commerce_products')
    .select('id, slug, kind, commerce_product_i18n(lang, title, subtitle), commerce_variants(id, sku, active, stock, option_values, position, commerce_prices(currency, amount_minor, active, recurring_interval))')
    .eq('status', 'published').contains('sites', ['yinyang']).limit(2000);
  if (error) throw new Error(`commerce products: ${error.message}`);
  const web = (process.env.YINYANG_WEB_URL || 'https://yinyangmasters.com').replace(/\/+$/, '');
  return (data ?? []).map((p: any) => {
    const t = (lang: string) => (p.commerce_product_i18n ?? []).find((i: any) => i.lang === lang);
    const variants = (p.commerce_variants ?? []).filter((v: any) => v.active)
      .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0))
      .map((v: any) => {
        const pr = (v.commerce_prices ?? []).find((x: any) => x.currency === 'vnd' && x.active && !x.recurring_interval);
        const ov = v.option_values?.title;
        return { variant_id: v.id, sku: v.sku ?? null, option: typeof ov === 'string' ? ov : ov?.vi ?? ov?.en ?? null,
          price_vnd: pr ? Number(pr.amount_minor) : null, in_stock: v.stock == null ? null : v.stock > 0 };
      });
    const prices = variants.map((v: { price_vnd: number | null }) => v.price_vnd).filter((x: number | null): x is number => x != null);
    return { id: p.id, ref: p.slug, title: t('vi')?.title ?? t('en')?.title ?? p.slug, title_en: t('en')?.title ?? null,
      subtitle: t('vi')?.subtitle ?? t('en')?.subtitle ?? null, kind: String(p.kind), variants,
      price_vnd: prices.length ? Math.min(...prices) : null, url: `${web}/vi/products/${p.slug}` };
  });
}

/**
 * Tìm SP đang bán trên Yinyang ở lõi commerce (YSC-005): mọi từ của từ khoá (bỏ dấu) có trong slug hoặc tiêu đề vi/en.
 * Chỉ `published` + `'yinyang' = any(sites)`; giá VND đang active, không tính gói tháng.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function searchCommerceProducts(supabase: any, query: string, limit = 5): Promise<CommerceProductHit[]> {
  const q = String(query ?? '').replace(/[%,()*\\]/g, ' ').trim().slice(0, 80);
  if (!q) return [];
  const tokens = toSlugish(q).split('-').filter(Boolean);
  if (!tokens.length) return [];
  const all = await listCommerceProducts(supabase);
  const hits = all.filter((h) => {
    const hay = `-${toSlugish([h.ref, h.title, h.title_en ?? ''].join(' '))}-`;
    return tokens.every((t) => hay.includes(t));
  });
  const qs = toSlugish(q);
  const rank = (h: CommerceProductHit) => (toSlugish(h.title).includes(qs) ? 0 : 1) + (h.price_vnd == null ? 2 : 0);
  return hits.sort((a, b) => rank(a) - rank(b) || a.title.length - b.title.length).slice(0, Math.min(Math.max(limit, 1), 20));
}

const fmtVnd = (n: number) =>`${Math.round(n).toLocaleString('vi-VN')}đ`;

export async function handleCommerceCreateOrder(args: any, agentSlug?: string | null): Promise<string> {
  const items = normalizeItems(args.items, args.variant_id ?? args.slug, args.quantity);
  if (!items.length) return JSON.stringify({ success: false, error: 'Thiếu sản phẩm: items=[{ref, quantity}] (ref = slug hoặc mã variant từ search_product)' });
  const email = typeof args.email === 'string' && args.email.trim() ? args.email.trim() : undefined;
  const phone = String(args.shipping_phone ?? args.customer_phone ?? args.phone ?? '').trim() || undefined;
  const who = String(args.customer_id ?? email ?? phone ?? '').trim();
  if (!who) return JSON.stringify({ success: false, error: 'Cần email hoặc SĐT khách để tạo đơn' });
  const key = backendKey();
  if (!key) return JSON.stringify({ success: false, error: 'Thiếu SB_SECRET_BACKEND (paperclip/server/.env)' });

  const body = {
    action: 'order.create',
    items: items.map((i) => ({ ref: i.ref, qty: i.qty })),
    email,
    name: args.shipping_name ?? args.name,
    phone,
    shipping_address: {
      line1: args.shipping_address1 ?? args.shipping_address ?? args.line1,
      line2: args.shipping_address2 ?? args.line2,
      city: args.shipping_city ?? args.city ?? args.province,
    },
    note: args.customer_note ?? args.note,
    agent: agentSlug || args.agent || 'crm-mcp',
    idem_key: typeof args.idem_key === 'string' && args.idem_key ? args.idem_key : deriveIdemKey(who, items),
    locale: 'vi',
    ...(args.livemode === false ? { livemode: false } : {}),
  };
  let res: Response;
  try {
    res = await fetch(FN_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return JSON.stringify({ success: false, error: `Không gọi được commerce-admin: ${(e as Error).message}` });
  }
  const j = await res.json().catch(() => ({})) as { ok?: boolean; data?: any; error?: string };
  if (!res.ok || !j.ok) return JSON.stringify({ success: false, error: j.error ?? `HTTP ${res.status}` });
  const d = j.data;
  if (d.paid) {
    return JSON.stringify({ success: true, duplicate: true, order_number: d.order_number, status: d.status,
      note: 'Đơn này khách đã thanh toán — không tạo thêm.' });
  }
  return JSON.stringify({
    success: true,
    duplicate: !!d.reused,
    order_number: d.order_number,
    total: fmtVnd(d.total_vnd),
    transfer_code: d.transfer_code,
    bank: d.bank,
    qr_url: d.qr_url,
    pay_url: d.pay_url,
    expires_at: d.expires_at,
    note: `Gửi khách: chuyển ${fmtVnd(d.total_vnd)} tới ${d.bank?.name} ${d.bank?.account_number} (${d.bank?.account_name}), `
      + `nội dung CK đúng "${d.transfer_code}" (KHÔNG tự đổi), hoặc quét QR / mở ${d.pay_url}. Hạn 24 giờ. `
      + 'Hệ thống tự xác nhận khi tiền về — KHÔNG báo khách "đã nhận tiền" trước khi hệ thống xác nhận.',
  });
}
