// Chốt link bịa (14/10): agent có TRANG NGUỒN chỉ được gửi link có nguyên văn trong trang đó.
// Gốc: jennie-support gửi "Instagram: https://www.instagram.com/jennieuyenchu/" — trang Jennie không có link này;
// Instagram trả 200 cho mọi đường dẫn nên không kiểm sống/chết được → kiểm theo danh sách trang nguồn.
// Thêm agent = thêm 1 dòng AGENT_LINK_SOURCES.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** agent → [trang nguồn (tương đối PROJECT_ROOT), gốc site của chính trang]. */
export const AGENT_LINK_SOURCES: Record<string, { file: string; siteOrigin: string }> = {
  'jennie-support': { file: 'jennie-web/index.html', siteOrigin: 'https://jennie.yinyangmasters.com' },
};

export interface LinkAllowlist {
  urls: Set<string>;
  siteOrigin: string;
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;

function normalize(url: string): string {
  return url.replace(/[.,!?;:…]+$/, '').replace(/\/+$/, '').toLowerCase();
}

export function allowedLinksFromHtml(html: string, siteOrigin: string): LinkAllowlist {
  // MỌI link trong trang (href + JSON-LD sameAs …), không chỉ href — 14/10 chỉ đọc href nên chặn oan Instagram thật.
  const urls = new Set<string>();
  for (const m of html.matchAll(URL_RE)) urls.add(normalize(m[0]));
  return { urls, siteOrigin: normalize(siteOrigin) };
}

function isAllowed(url: string, allow: LinkAllowlist): boolean {
  const n = normalize(url);
  if (n === allow.siteOrigin || n.startsWith(allow.siteOrigin + '/') || n.startsWith(allow.siteOrigin + '#')) return true;
  return allow.urls.has(n);
}

/** Bỏ nguyên DÒNG có link không nằm trong danh sách (để khỏi sót nhãn trơ "Instagram:"). */
export function stripUnlistedLinks(text: string, allow: LinkAllowlist): { text: string; removed: string[] } {
  const removed: string[] = [];
  const kept = text.split('\n').filter((line) => {
    const bad = (line.match(URL_RE) || []).filter((u) => !isAllowed(u, allow));
    removed.push(...bad);
    return bad.length === 0;
  });
  return { text: removed.length ? kept.join('\n').trim() : text, removed };
}

const cache = new Map<string, { at: number; allow: LinkAllowlist | null }>();

/** Danh sách link của agent (đọc lại trang mỗi 5'); null = agent không có trang nguồn / đọc lỗi (không chặn). */
export function loadAgentLinkAllowlist(slug: string, projectRoot: string): LinkAllowlist | null {
  const src = AGENT_LINK_SOURCES[slug];
  if (!src) return null;
  const hit = cache.get(slug);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.allow;
  let allow: LinkAllowlist | null = null;
  try {
    allow = allowedLinksFromHtml(readFileSync(join(projectRoot, src.file), 'utf8'), src.siteOrigin);
  } catch (err) {
    console.warn(`[Router/links] ${slug}: không đọc được trang nguồn ${src.file} — bỏ qua chốt link`, err);
  }
  cache.set(slug, { at: Date.now(), allow });
  return allow;
}
