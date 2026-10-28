// Chốt link bịa (14/10): agent trả lời khách chỉ được gửi link/email có nguyên văn trong file nguồn của nó.
// Gốc: chị Jennie "agent hay bịa link". Đo 30 ngày (14/10): sales-closer gửi gemral.com/product/tu-duy-trieu-phu (404).
// Không kiểm sống/chết bằng HTTP được (Instagram trả 200 mọi đường dẫn) → kiểm theo danh sách nguồn.
// Thêm agent = thêm 1 dòng AGENT_LINK_SOURCES.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LINK_REGISTRY = 'memory/sops/DOC-HTML/reference_and_policies/REF-PRODUCT-CATALOG.md';

interface LinkSource {
  /** File nguồn thêm (tương đối PROJECT_ROOT). */
  files: string[];
  /** true = cộng các file agent đang nạp trong agents/<slug>/sop/_INLINE.json (agent đổi nguồn thì chốt đổi theo). */
  inline: boolean;
  /** Gốc site của chính agent — mọi đường dẫn dưới gốc này đều hợp lệ (trang tĩnh nhỏ, tự kiểm soát). */
  siteOrigin: string | null;
}

export const AGENT_LINK_SOURCES: Record<string, LinkSource> = {
  // Trang Jennie + bảng link chung (khách hỏi Gemral thì được đưa link forum/Telegram/app — chị chốt 14/10).
  // 29/10: trang Jennie chuyển từ jennie-web/index.html (đã xoá 28/10) sang yinyang-web/content/jennie/copy.json —
  // đọc qua _INLINE.json (inline: true) để file nguồn đổi thì chốt đổi theo, không trỏ cứng file chết.
  'jennie-support': { files: [LINK_REGISTRY], inline: true, siteOrigin: 'https://jennie.yinyangmasters.com' },
  'sales-closer': { files: [LINK_REGISTRY], inline: true, siteOrigin: null },
  'yinyang-support': { files: [LINK_REGISTRY], inline: true, siteOrigin: null },
  'edge-sales-closer': { files: [LINK_REGISTRY], inline: true, siteOrigin: null },
};

/** Link hệ thống tự sinh, luôn hợp lệ: ảnh/tệp kho Supabase công khai (media gửi khách). */
const TRUSTED_PREFIXES = ['https://pgfkbcnzqozzkohwbgbk.supabase.co/storage/v1/object/public/'];

export interface LinkAllowlist {
  urls: Set<string>;
  emails: Set<string>;
  siteOrigin: string | null;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gi;

function normalize(url: string): string {
  return url.replace(/[.,!?;:…]+$/, '').replace(/\/+$/, '').toLowerCase();
}

/** Bỏ đoạn ngôn ngữ đầu đường dẫn (/vi/, /en/, /zh/…): agent hay thêm vào link gốc, link vẫn đúng. */
function stripLocale(n: string): string {
  return n.replace(/^(https?:\/\/[^/]+)\/(?:vi|en|zh|ja|ko|fr|de|es)(?=\/|$)/, '$1');
}

export function allowedLinksFromHtml(html: string, siteOrigin: string | null): LinkAllowlist {
  // MỌI link trong nguồn (href + JSON-LD sameAs + JSON …), không chỉ href — 14/10 chỉ đọc href nên chặn oan Instagram thật.
  const urls = new Set<string>();
  for (const m of html.matchAll(URL_RE)) urls.add(stripLocale(normalize(m[0])));
  const emails = new Set<string>();
  for (const m of html.matchAll(EMAIL_RE)) emails.add(m[0].toLowerCase());
  return { urls, emails, siteOrigin: siteOrigin ? normalize(siteOrigin) : null };
}

function isAllowed(url: string, allow: LinkAllowlist): boolean {
  const n = normalize(url);
  if (TRUSTED_PREFIXES.some((p) => n.startsWith(p))) return true;
  const o = allow.siteOrigin;
  if (o && (n === o || n.startsWith(o + '/') || n.startsWith(o + '#'))) return true;
  return allow.urls.has(stripLocale(n));
}

/** Bỏ nguyên DÒNG có link/email không nằm trong danh sách (để khỏi sót nhãn trơ "Instagram:"). */
export function stripUnlistedLinks(text: string, allow: LinkAllowlist): { text: string; removed: string[] } {
  const removed: string[] = [];
  const kept = text.split('\n').filter((line) => {
    // Email: bỏ phần URL trước để "x@y" trong link (vd youtube.com/@x) không bị đọc thành email.
    const badEmails = (line.replace(URL_RE, ' ').match(EMAIL_RE) || []).filter((e) => !allow.emails.has(e.toLowerCase()));
    const bad = [...(line.match(URL_RE) || []).filter((u) => !isAllowed(u, allow)), ...badEmails];
    removed.push(...bad);
    return bad.length === 0;
  });
  return { text: removed.length ? kept.join('\n').trim() : text, removed };
}

function inlineFiles(slug: string, projectRoot: string): string[] {
  const raw = JSON.parse(readFileSync(join(projectRoot, 'agents', slug, 'sop', '_INLINE.json'), 'utf8'));
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && !x.startsWith('_note')) : [];
}

const cache = new Map<string, { at: number; allow: LinkAllowlist | null }>();

/** Danh sách link của agent (đọc lại mỗi 5'); null = agent chưa đăng ký / không đọc được file nào (không chặn). */
export function loadAgentLinkAllowlist(slug: string, projectRoot: string): LinkAllowlist | null {
  const src = AGENT_LINK_SOURCES[slug];
  if (!src) return null;
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.allow;
  let files = [...src.files];
  if (src.inline) {
    try { files = [...inlineFiles(slug, projectRoot), ...files]; }
    catch (err) { console.warn(`[Router/links] ${slug}: không đọc được sop/_INLINE.json`, err); }
  }
  const texts: string[] = [];
  for (const f of files) {
    try { texts.push(readFileSync(join(projectRoot, f), 'utf8')); }
    catch { console.warn(`[Router/links] ${slug}: thiếu file nguồn link ${f}`); }
  }
  const allow = texts.length ? allowedLinksFromHtml(texts.join('\n'), src.siteOrigin) : null;
  cache.set(slug, { at: Date.now(), allow });
  return allow;
}
