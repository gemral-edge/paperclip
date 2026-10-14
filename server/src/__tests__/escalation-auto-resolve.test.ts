// 14/10 TK-20261014-001: phiếu agent_silent mở 13:18 nhưng bot đã trả lời cùng tin lúc 14:47 → phiếu vẫn mở,
// nhắc 18:00 báo sai "khách đang chờ". Bot gửi được câu trả lời ⇒ đóng phiếu "khách chưa nhận gì" của phiên.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const filters: Array<[string, string, unknown]> = [];
const updates: Array<{ id: unknown; row: any }> = [];
let openRows: any[] = [];

vi.mock('../channels/zalo-personal/supabase.js', () => {
  const builder = () => {
    let pendingUpdate: any = null;
    const b: any = {
      select: () => b,
      eq: (k: string, v: unknown) => {
        filters.push(['eq', k, v]);
        if (pendingUpdate && k === 'id') updates.push({ id: v, row: pendingUpdate });
        return b;
      },
      in: (k: string, v: unknown) => { filters.push(['in', k, v]); return b; },
      limit: () => b,
      update: (row: any) => { pendingUpdate = row; return b; },
      then: (res: (v: any) => void) => res(pendingUpdate ? { error: null } : { data: openRows }),
    };
    return b;
  };
  return { supabase: { from: () => builder(), rpc: async () => ({ data: 1, error: null }) } };
});

import { AUTO_RESOLVE_ON_REPLY_REASONS, autoResolveNoReplyTickets } from '../channels/crm/escalation-handler.js';

describe('autoResolveNoReplyTickets', () => {
  beforeEach(() => { filters.length = 0; updates.length = 0; openRows = []; });

  it('chỉ lọc phiếu agent_silent/agent_output_corrupted đang mở của đúng phiên', async () => {
    await autoResolveNoReplyTickets('zalo-x:1:1', 'sales-closer');
    expect(filters).toContainEqual(['eq', 'source_session_key', 'zalo-x:1:1']);
    expect(filters).toContainEqual(['in', 'metadata->>escalation_reason', [...AUTO_RESOLVE_ON_REPLY_REASONS]]);
    expect(AUTO_RESOLVE_ON_REPLY_REASONS).toEqual(['agent_silent', 'agent_output_corrupted']);
  });

  it('đóng phiếu mở với ghi chú + timeline', async () => {
    openRows = [{ id: 't1', ticket_number: 'TK-1', metadata: { escalation_reason: 'agent_silent' }, timeline: [] }];
    const n = await autoResolveNoReplyTickets('zalo-x:1:1', 'sales-closer');
    expect(n).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].row.status).toBe('resolved');
    expect(updates[0].row.metadata.escalation_reason).toBe('agent_silent');
    expect(updates[0].row.metadata.resolved_by).toBe('auto:reply_delivered');
    expect(updates[0].row.timeline).toHaveLength(1);
  });

  it('sessionKey rỗng ⇒ không làm gì', async () => {
    expect(await autoResolveNoReplyTickets('', 'x')).toBe(0);
    expect(filters).toHaveLength(0);
  });
});
