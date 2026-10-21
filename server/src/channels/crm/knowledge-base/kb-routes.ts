// Knowledge Base API Routes — collections, documents, search, sync

import { Router } from 'express';
import { supabase } from '../../zalo-personal/supabase.js';
import { DocumentProcessor } from './processor.js';
import { listCommerceProducts } from '../commerce-order.js';

const router = Router();
const processor = new DocumentProcessor();

// ═══ Collections ═══

router.get('/collections', async (_req, res) => {
  try {
    const { data, error } = await supabase.from('kb_collections').select('*').order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data || []);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.post('/collections', async (req, res) => {
  try {
    const { name, description, collection_type, chunk_size, chunk_overlap } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Tên bộ sưu tập không được để trống' });

    const { data, error } = await supabase.from('kb_collections')
      .insert({ name: name.trim(), description, collection_type: collection_type || 'document', chunk_size: chunk_size || 500, chunk_overlap: chunk_overlap || 50 })
      .select('*').single();

    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json(data);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.delete('/collections/:id', async (req, res) => {
  try {
    const { error } = await supabase.from('kb_collections').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══ Documents ═══

router.get('/collections/:id/documents', async (req, res) => {
  try {
    const { data } = await supabase.from('kb_documents').select('*').eq('collection_id', req.params.id).order('created_at', { ascending: false });
    res.json(data || []);
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /kb/documents — Add document (text body, not file upload for simplicity)
router.post('/documents', async (req, res) => {
  try {
    const { collection_id, title, content, source_type } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'Nội dung không được để trống' });
    if (!collection_id) return res.status(400).json({ error: 'Chưa chọn bộ sưu tập' });

    const { createHash } = await import('crypto');
    const { data: doc, error } = await supabase.from('kb_documents')
      .insert({
        collection_id, title: title || 'Untitled', source_type: source_type || 'manual',
        raw_content: content, content_hash: createHash('md5').update(content).digest('hex'), status: 'pending',
      })
      .select('*').single();

    if (error) return res.status(400).json({ error: error.message });

    // Process async
    processor.processDocument(doc.id).catch(e => console.error('[KB] Process error:', e.message));

    res.status(201).json({ ...doc, message: 'Đang xử lý tài liệu...' });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// POST /kb/faq — Add FAQ
router.post('/faq', async (req, res) => {
  try {
    const { collection_id, question, answer } = req.body;
    if (!question?.trim() || !answer?.trim()) return res.status(400).json({ error: 'Câu hỏi và trả lời không được để trống' });

    const content = `Câu hỏi: ${question}\nCâu trả lời: ${answer}`;
    const { createHash } = await import('crypto');
    const { data: doc, error } = await supabase.from('kb_documents')
      .insert({
        collection_id, title: question.slice(0, 100), source_type: 'manual',
        raw_content: content, content_hash: createHash('md5').update(content).digest('hex'),
        metadata: { question, answer }, status: 'pending',
      })
      .select('*').single();

    // Insert lỗi phải trả lỗi thật — trước đây trả 201 success dù không lưu được FAQ nào.
    if (error || !doc) return res.status(400).json({ error: error?.message || 'Không lưu được FAQ' });
    processor.processDocument(doc.id).catch(() => {});
    res.status(201).json({ success: true, document: doc });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// DELETE /kb/documents/:id — Delete document and its chunks
router.delete('/documents/:id', async (req, res) => {
  try {
    // Delete chunks first (cascade may not be set up)
    await supabase.from('kb_chunks').delete().eq('document_id', req.params.id);
    const { error } = await supabase.from('kb_documents').delete().eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══ Search ═══

router.post('/search', async (req, res) => {
  try {
    const { query, limit = 5 } = req.body;
    if (!query?.trim()) return res.status(400).json({ error: 'Nhập từ khóa tìm kiếm' });

    // BM25 only search (no embedding if no OpenAI key)
    const { data: results } = await supabase
      .from('kb_chunks')
      .select('id, content, document_id, metadata, kb_documents(title, source_type)')
      .textSearch('search_tokens', query, { type: 'plain' })
      .limit(limit);

    res.json({
      results: (results || []).map((r: any) => ({
        chunk_id: r.id, content: r.content, document_title: (r.kb_documents as any)?.title,
        source_type: (r.kb_documents as any)?.source_type, metadata: r.metadata,
      })),
      query,
    });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// ═══ Sync ═══

// POST /kb/sync/commerce — đồng bộ SP đang bán trên Yinyang (lõi commerce) vào KB (YSC-034, 21/10/2026)
router.post('/sync/commerce', async (_req, res) => {
  try {
    let { data: col } = await supabase.from('kb_collections').select('id').eq('collection_type', 'product').maybeSingle();
    if (!col) {
      const { data } = await supabase.from('kb_collections')
        .insert({ name: 'Sản phẩm Yinyang', description: 'Catalog cửa hàng yinyangmasters.com (lõi commerce)', collection_type: 'product' })
        .select('id').single();
      col = data;
    }
    if (!col) return res.status(500).json({ error: 'Không tạo được bộ sưu tập' });

    const products = await listCommerceProducts(supabase);
    if (!products.length) return res.json({ message: 'Không có sản phẩm nào', count: 0, total: 0 });

    const { createHash } = await import('crypto');
    let count = 0;
    for (const p of products) {
      const price = p.price_vnd != null ? `${p.variants.length > 1 ? 'từ ' : ''}${p.price_vnd.toLocaleString('vi-VN')}₫` : 'Liên hệ';
      const content = [`Sản phẩm: ${p.title}`, p.title_en && p.title_en !== p.title ? `Tên tiếng Anh: ${p.title_en}` : '',
        `Giá: ${price}`, `Loại: ${p.kind}`, p.subtitle ? `Mô tả: ${p.subtitle}` : '', `Mã đặt hàng (create_order ref): ${p.ref}`,
        `Link: ${p.url}`].filter(Boolean).join('\n');
      const hash = createHash('md5').update(content).digest('hex');
      // Dedup theo ĐỊNH DANH SP (source_id = commerce_products.id): đổi giá/mô tả → cập nhật tại chỗ, không đẻ doc trùng
      const { data: existing } = await supabase.from('kb_documents')
        .select('id, content_hash').eq('source_type', 'commerce').eq('source_id', p.id).maybeSingle();
      if (existing) {
        if (existing.content_hash === hash) continue;
        await supabase.from('kb_documents')
          .update({ title: p.title, raw_content: content, content_hash: hash, status: 'pending' }).eq('id', existing.id);
        processor.processDocument(existing.id).catch(() => {});
        count++;
        continue;
      }
      const { data: doc } = await supabase.from('kb_documents')
        .insert({ collection_id: col.id, title: p.title, source_type: 'commerce', source_id: p.id, raw_content: content, content_hash: hash, status: 'pending' })
        .select('id').single();
      if (doc) { processor.processDocument(doc.id).catch(() => {}); count++; }
    }
    res.json({ message: `Đang sync ${count} sản phẩm`, count, total: products.length });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

// Shopify đã đóng (21/10/2026) — 2 route cũ chỉ chỉ đường
router.post('/sync/shopify', (_req, res) => {
  res.status(410).json({ error: 'Shopify đã đóng — dùng POST /kb/sync/commerce', use: '/kb/sync/commerce' });
});
router.post('/sync/courses', (_req, res) => {
  res.status(410).json({ error: 'Shopify đã đóng — khoá học/Tier nằm trong POST /kb/sync/commerce', use: '/kb/sync/commerce' });
});

// ═══ Stats ═══

router.get('/stats', async (_req, res) => {
  try {
    const { count: collections } = await supabase.from('kb_collections').select('*', { count: 'exact', head: true });
    const { count: documents } = await supabase.from('kb_documents').select('*', { count: 'exact', head: true }).eq('status', 'ready');
    const { count: chunks } = await supabase.from('kb_chunks').select('*', { count: 'exact', head: true });
    res.json({ collections: collections || 0, documents: documents || 0, chunks: chunks || 0 });
  } catch (err: any) { res.status(500).json({ error: err.message }); }
});

export default router;
