// catalog-media-source.ts — Option A (OD-1, chị Jennie chốt 29/08): dựng MediaLibrary cho agent
// `sales-closer` TRỰC TIẾP từ product-catalog-index.json (SSOT nội dung + media sản phẩm), thay vì
// đọc file trung gian agents/sales-closer/media-library.json.
//
// SSOT thiết kế: crypto-pattern-scanner/docs/plans_reports/
//   2026-08-29-SALES-CLOSER-MEDIA-SOURCE-SSOT_ARCHITECTURE_PLAN.md §5.1 (Codex approve R3).
//
// deriveTags/strip-accents PHẢI khớp BYTE-FOR-BYTE với Python
//   crypto-pattern-scanner/scripts/sync_media_library_from_sales_closer_catalog.py
// (hàm derive_tags/strip_accents_lower). Parity gate §6.1 (test catalog-derive-parity) shell-out
// `python … --emit-tags` TƯƠI rồi so per-id — lệch 1 id = FAIL. KHÔNG sửa 1 bên mà quên bên kia.
import { readFileSync, existsSync } from 'node:fs';
import { resolve as pathResolve } from 'node:path';
import type { MediaLibrary, MediaLibraryItem } from './types.js';

const MIN_TAG_LEN = 6;

// Đường catalog: cùng PROJECT_ROOT với router.ts (same-disk cross-repo, xem plan §5.1 "Hợp đồng
// runtime XUYÊN-REPO"). Truyền projectRoot vào để test override được.
export function catalogPath(projectRoot: string): string {
  return pathResolve(
    projectRoot,
    'memory', 'sops', 'DOC-HTML', 'reference_and_policies', 'product-catalog-index.json',
  );
}

// Khớp Python strip_accents_lower: NFKD + bỏ combining marks + đ/Đ→d + lowercase.
// ⚠️ KHÁC stripAccentsLower (NFD) trong router.ts dùng cho match customer-text — hàm NÀY chỉ cho
// derive tags (parity với Python). NFKD (không phải NFD) vì Python dùng NFKD; \p{M} bỏ mọi combining
// mark (tương đương unicodedata.combining(ch)!=0). đ/Đ không bị NFKD tách nên xử riêng như Python.
export function stripAccentsForDerive(s: string): string {
  const norm = s.normalize('NFKD').replace(/\p{M}/gu, '');
  return norm.replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
}

// Khớp Python derive_tags: mỗi phrase → strip-accent → [^a-z0-9]+ thành '_' → strip '_' → collapse
// '_' → giữ nếu ≥MIN_TAG_LEN ký tự và chưa thấy (dedupe, giữ thứ tự xuất hiện).
export function deriveTags(covers: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(covers)) return out;
  for (const phrase of covers) {
    if (typeof phrase !== 'string') continue;
    let norm = stripAccentsForDerive(phrase);
    norm = norm.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    norm = norm.replace(/_+/g, '_');
    if (norm.length >= MIN_TAG_LEN && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

// Catalog entry (shape rộng) → MediaLibraryItem. description = catalog.description ĐẦY ĐỦ (KHÔNG
// summary — Deviation D-1: 134/134 item live dùng description byte-for-byte, summary còn rác
// "[E2E Tested]"). tags derive từ covers. mimeType để router.ts itemToMediaFiles tự suy qua đuôi file.
export function buildMediaItemFromCatalogEntry(entry: Record<string, any>): MediaLibraryItem {
  const description = (entry.description || '').trim();
  return {
    id: entry.id,
    name: entry.name,
    type: (entry.type as MediaLibraryItem['type']) || 'image',
    mimeType: entry.mimeType || 'application/octet-stream',
    path: entry.path ?? null,
    all_images: Array.isArray(entry.all_images) ? entry.all_images : undefined,
    url: entry.url ?? null,
    description,
    tags: deriveTags(entry.covers),
    language: 'vi',
  };
}

// Đọc product-catalog-index.json → MediaLibrary cho agent CSKH (sales-closer, yinyang-support). Null-safe GIỐNG
// loadMediaLibrary gốc (file thiếu/parse lỗi → null, caller degrade an toàn — plan §5.1 "hành vi khi file thiếu/hỏng").
// allowTypes: chỉ giữ entry có `type` thuộc tập này (yinyang-support chỉ gửi ảnh crystal, không gửi ảnh Edge/Scanner).
export function loadSalesCloserMediaFromCatalog(
  projectRoot: string,
  agentSlug: string = 'sales-closer',
  allowTypes: ReadonlySet<string> | null = null,
): MediaLibrary | null {
  const p = catalogPath(projectRoot);
  if (!existsSync(p)) return null;
  let catalog: any;
  try {
    catalog = JSON.parse(readFileSync(p, 'utf-8'));
  } catch (err: any) {
    console.warn(`[Router/media] Failed to parse catalog ${p}:`, err?.message);
    return null;
  }
  // FAIL-CLOSED (Codex P5-R2 [high]): catalog parse-được nhưng items rỗng/không-array ({}, {"items":
  // null}, {"items":[]}) = KHÔNG coi là load thành công. Trả null để loadMediaLibrary fallback sang
  // media-library.json — nếu coerce thành [] rồi trả MediaLibrary 0-item thì cache 60s = câm media
  // dù fallback còn dùng được. sales-closer LUÔN có sản phẩm; 0 item = catalog hỏng, KHÔNG hợp lệ.
  if (!Array.isArray(catalog?.items) || catalog.items.length === 0) {
    console.error(`[Router/media] ⚠️ catalog items rỗng/không phải array (${p}) — trả null để fallback media-library.json`);
    return null;
  }
  const rawItems = catalog.items;
  // Duplicate id: prompt render + parseMediaMarkers (lib.items.find) resolve về item ĐẦU → id trùng
  // = gửi nhầm ảnh câm (Codex P5-R1 [medium]). Catalog audit (product_catalog_index_audit.py) đã bắt
  // dup, nhưng loader phải TỰ phòng: giữ item ĐẦU cho mỗi id + cảnh báo TO (không im lặng ăn trùng).
  const seenIds = new Set<string>();
  const items: MediaLibraryItem[] = [];
  for (const e of rawItems) {
    if (!e || !e.id) continue;
    if (allowTypes && !allowTypes.has(String(e.type || ''))) continue;
    if (seenIds.has(e.id)) {
      console.error(`[Router/media] ⚠️ DUPLICATE id trong catalog: '${e.id}' — bỏ bản sau, giữ bản đầu. Sửa catalog.`);
      continue;
    }
    seenIds.add(e.id);
    items.push(buildMediaItemFromCatalogEntry(e));
  }
  if (items.length === 0) {
    // Tất cả entry thiếu id / bị lọc hết → cũng fail-closed để fallback (thay vì cache 0-item câm).
    console.error(`[Router/media] ⚠️ catalog 0 item hợp lệ sau lọc (${p}) — trả null để fallback`);
    return null;
  }
  return {
    agent_slug: agentSlug,
    version: String(catalog?.version || 'catalog'),
    description:
      `Media library cho ${agentSlug} — đọc` + ' TRỰC TIẾP từ product-catalog-index.json (Option A, ' +
      'transform-on-read). KHÔNG sửa file này; sửa catalog.',
    items,
    instructions_for_agent:
      'Khi user hỏi/quan tâm sản phẩm cụ thể, dùng [[SEND_MEDIA: id]] trong reply để tự động đính ' +
      'kèm ảnh. Marker sẽ bị xoá khỏi text hiển thị cho khách.',
  };
}
