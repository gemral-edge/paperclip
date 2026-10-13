import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { splitIntoHumanMessages, splitSentences, MAX_MESSAGES } from '../channels/human-message-split.js';

const here = dirname(fileURLToPath(import.meta.url));
const channels = join(here, '..', 'channels');

// Real reply from 14/10 (yinyang-support, cskh-shopify) that went out as ONE bubble.
const REAL_REPLY = [
  'Dạ em chào bạn ạ. Để bàn làm việc thì bên em có mẫu Duyên Khởi Thạch (trụ thạch anh hồng tự nhiên) size chuẩn 5-8cm rất gọn gàng và xinh xắn, giá là 750.000đ ạ. Ngoài ra bên em còn có Ngũ Quang Thạch (trụ thạch anh hồng phủ ánh aura) giá 880.000đ bạn nha.',
  'Đơn giao về Hà Nội thường mất khoảng 5-7 ngày bạn nhé.',
  'https://yinyang-web.vercel.app/vi/products/duyen-khoi-thach',
  '[[SEND_MEDIA: duyen-khoi-thach]]',
].join('\n\n');

describe('splitIntoHumanMessages', () => {
  it('honours [[MSG_BREAK]]', () => {
    expect(splitIntoHumanMessages('Dạ chào chị ạ\n[[MSG_BREAK]]\nChị cần em hỗ trợ gì ạ?')).toEqual([
      'Dạ chào chị ạ',
      'Chị cần em hỗ trợ gì ạ?',
    ]);
  });

  it('turns blank-line paragraphs into separate messages', () => {
    const out = splitIntoHumanMessages(REAL_REPLY);
    expect(out.length).toBeGreaterThanOrEqual(4);
    expect(out).toContain('https://yinyang-web.vercel.app/vi/products/duyen-khoi-thach');
    expect(out).toContain('[[SEND_MEDIA: duyen-khoi-thach]]');
  });

  it('cuts a long paragraph into pieces of at most 2 sentences', () => {
    const out = splitIntoHumanMessages(REAL_REPLY);
    for (const piece of out) expect(splitSentences(piece).length).toBeLessThanOrEqual(2);
  });

  it('keeps a short paragraph intact', () => {
    expect(splitIntoHumanMessages('Hi there! Those tools belong to gemral.com.')).toEqual([
      'Hi there! Those tools belong to gemral.com.',
    ]);
  });

  it('does not cut on abbreviations or prices', () => {
    expect(splitSentences('Giao về TP. HCM mất 1-3 ngày ạ. Phí ship 30.000đ.')).toEqual([
      'Giao về TP. HCM mất 1-3 ngày ạ.',
      'Phí ship 30.000đ.',
    ]);
  });

  it('keeps a list in one message', () => {
    const list = 'Bên em có:\n- Duyên Khởi Thạch 750.000đ. Rất hợp bàn làm việc.\n- Ngũ Quang Thạch 880.000đ. Ánh aura đẹp.\n- Trụ thạch anh trắng. Giá tốt nhất.';
    expect(splitIntoHumanMessages(list)).toEqual([list]);
  });

  it('never sends more than MAX_MESSAGES bubbles', () => {
    const many = Array.from({ length: 12 }, (_, i) => `Tin số ${i + 1}.`).join('\n\n');
    expect(splitIntoHumanMessages(many).length).toBe(MAX_MESSAGES);
  });
});

describe('multi-message wiring (side-channel must be SET, not only read)', () => {
  const router = readFileSync(join(channels, 'router.ts'), 'utf-8');
  const consumer = readFileSync(join(channels, 'consumer.ts'), 'utf-8');

  it('router uses the splitter and sets + bridges _messageChunks', () => {
    expect(router).toMatch(/splitIntoHumanMessages\(preSplit\)/);
    expect(router).toMatch(/\(config as any\)\._messageChunks\s*=/);
    expect(router).toMatch(/\(originalMsg as any\)\._messageChunks\s*=/);
  });

  it('consumer keeps public replies single and dedupes each chunk', () => {
    expect(consumer).toMatch(/isPublicReply/);
    expect(consumer).toMatch(/dedupeKey: `\$\{chunkDedupeBase\}:c\$\{i\}`/);
  });
});
