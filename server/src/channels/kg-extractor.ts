// Knowledge Graph Entity Extraction — LLM-powered extraction from chat
// Primary: 9router (localhost:20128, cx/gpt-5.4)
// KHÔNG fallback sang provider khác (luật 22/10): 9router lỗi ⇒ log + bỏ qua lượt trích xuất.

import { supabase } from './zalo-personal/supabase.js';
import type { KGExtractionResult } from './kg-types.js';

const NINEROUTER_BASE = 'http://localhost:20128/v1';
const NINEROUTER_TUNNEL = 'https://rgswgsv.9router.com/v1';
// Khoá 9router đọc từ env NINEROUTER_API_KEY (paperclip/server/.env) — CẤM viết thẳng vào mã (repo public).
const NINEROUTER_MODEL = 'cx/gpt-5.4';

const EXTRACTION_PROMPT = `Trích xuất entities và relations từ đoạn hội thoại.
Trả về JSON format:

{
  "entities": [
    {
      "external_id": "customer:tran-thang",
      "entity_type": "person",
      "name": "Trần Thắng",
      "description": "Khách hàng quan tâm Trading Starter",
      "confidence": 0.9
    }
  ],
  "relations": [
    {
      "source": "customer:tran-thang",
      "target": "product:trading-starter",
      "relation_type": "interested_in",
      "confidence": 0.85
    }
  ]
}

Entity types: person, product, concept, event, organization
Relation types: interested_in, purchased, asked_about, complained_about, referred_by, belongs_to
Chỉ extract entities CÓ THẬT trong hội thoại. Confidence: 1.0=nói rõ ràng, 0.7=suy luận.
Trả về JSON ONLY, không text khác.`;

async function callNineRouter(message: string): Promise<string> {
  const apiKey = (process.env.NINEROUTER_API_KEY || '').trim();
  if (!apiKey) throw new Error('NINEROUTER_API_KEY chưa đặt');
  // Try localhost first, then tunnel
  for (const baseUrl of [NINEROUTER_BASE, NINEROUTER_TUNNEL]) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: NINEROUTER_MODEL,
          messages: [
            { role: 'system', content: EXTRACTION_PROMPT },
            { role: 'user', content: message },
          ],
          max_tokens: 1024,
          temperature: 0.1,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        console.warn(`[KG Extract] 9router ${baseUrl} returned ${res.status}`);
        continue;
      }

      const data = await res.json() as any;
      return data.choices?.[0]?.message?.content || '';
    } catch (err: any) {
      console.warn(`[KG Extract] 9router ${baseUrl} failed:`, err.message);
      continue;
    }
  }
  throw new Error('9router unavailable');
}

function parseExtractionResult(raw: string): KGExtractionResult {
  // Extract JSON from potential markdown code blocks
  let cleaned = raw.trim();
  const jsonMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) cleaned = jsonMatch[1].trim();

  const parsed = JSON.parse(cleaned);
  return {
    entities: (parsed.entities || []).filter((e: any) => e.confidence >= 0.75),
    relations: (parsed.relations || []).filter((r: any) => r.confidence >= 0.75),
  };
}

async function extractEntities(
  customerMessage: string,
  agentReply: string,
  agentSlug?: string,
): Promise<KGExtractionResult> {
  const context = [
    `Agent: ${agentSlug || 'unknown'}`,
    `Tin nhắn khách: "${customerMessage}"`,
    `Agent trả lời: "${agentReply}"`,
  ].join('\n');

  let raw: string;
  try {
    raw = await callNineRouter(context);
  } catch (err: any) {
    // Không fallback provider khác — lỗi nguyên + log 1 dòng, bỏ qua lượt trích xuất (không crash server).
    console.warn('[KG Extract] 9router lỗi, bỏ qua lượt này (không fallback):', err.message);
    return { entities: [], relations: [] };
  }

  try {
    return parseExtractionResult(raw);
  } catch (err: any) {
    console.warn('[KG Extract] JSON parse failed:', err.message);
    return { entities: [], relations: [] };
  }
}

async function ingestExtractionResult(result: KGExtractionResult): Promise<void> {
  // Upsert entities
  for (const e of result.entities) {
    await supabase
      .from('kg_entities')
      .upsert(
        {
          external_id: e.external_id,
          entity_type: e.entity_type,
          name: e.name,
          description: e.description || null,
          confidence: e.confidence,
          source: 'chat',
        },
        { onConflict: 'external_id' },
      );
  }

  // Upsert relations (resolve external_ids to UUIDs)
  for (const r of result.relations) {
    const { data: src } = await supabase
      .from('kg_entities')
      .select('id')
      .eq('external_id', r.source)
      .single();
    const { data: tgt } = await supabase
      .from('kg_entities')
      .select('id')
      .eq('external_id', r.target)
      .single();

    if (src && tgt) {
      await supabase
        .from('kg_relations')
        .upsert(
          {
            source_entity_id: src.id,
            target_entity_id: tgt.id,
            relation_type: r.relation_type,
            confidence: r.confidence,
            source: 'chat',
          },
          { onConflict: 'source_entity_id,target_entity_id,relation_type' },
        );
    }
  }
}

/**
 * Fire-and-forget extraction wrapper.
 * Called from consumer.ts after agent reply — never blocks chat flow.
 */
export function extractEntitiesAsync(
  customerMessage: string,
  agentReply: string,
  agentSlug?: string,
): void {
  setTimeout(async () => {
    try {
      const result = await extractEntities(customerMessage, agentReply, agentSlug);
      if (result.entities.length > 0 || result.relations.length > 0) {
        await ingestExtractionResult(result);
        console.log(
          `[KG Extract] Ingested ${result.entities.length} entities, ${result.relations.length} relations`,
        );
      }
    } catch (err: any) {
      console.warn('[KG Extract] Async extraction failed:', err.message);
    }
  }, 0);
}
