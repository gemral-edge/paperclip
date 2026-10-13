// Human-style multi-message split for customer chat replies (chị Jennie 14/10/2026:
// "viết câu ngắn lại, gửi tin enter nhiều lần, mỗi lần 1-2 câu ngắn — 1 đoạn dài giống AI").
//
// The prompt already asks agents to separate messages with [[MSG_BREAK]], but Gemini Flash
// often ignores it and returns blank-line paragraphs instead. This is the router-side
// guarantee (prompt = intent, router = enforcement — same pattern as scrubBannedPhrases):
//   1. honour [[MSG_BREAK]] the agent emitted;
//   2. a blank line between paragraphs = a new message;
//   3. a long paragraph with ≥3 sentences is cut into groups of ≤2 sentences;
//   4. never more than MAX_MESSAGES bubbles (shortest adjacent pairs are re-joined).
// Lists (lines starting with -, •, *, 1.) stay in one message. Markers ([[SEND_MEDIA: …]])
// stay inside the piece they were written in.

const MSG_BREAK_RE = /\[\[\s*MSG_BREAK\s*\]\]/gi;
const PARAGRAPH_RE = /\n[ \t]*\n+/;
const LIST_LINE_RE = /^\s*(?:[-•*]|\d+[.)])\s+/m;

export const MAX_SENTENCES_PER_MESSAGE = 2;
export const LONG_PARAGRAPH_CHARS = 160;
export const MAX_MESSAGES = 6;

// Short tokens that end with "." but do not end a sentence ("TP. HCM", "Mr. Smith", "e.g. x").
const ABBREVIATIONS = new Set(['tp', 'mr', 'mrs', 'ms', 'dr', 'st', 'vs', 'eg', 'ie', 'no', 'q', 'p', 'tx', 'h']);

function isAbbreviation(wordBefore: string): boolean {
  const w = wordBefore.replace(/[^\p{L}]/gu, '').toLowerCase();
  if (!w) return false;
  if (ABBREVIATIONS.has(w)) return true;
  // All-caps token of ≤3 letters ("TP", "Q", "U.S") — almost always an abbreviation.
  return w.length <= 3 && wordBefore.replace(/[^\p{L}]/gu, '') === wordBefore.replace(/[^\p{L}]/gu, '').toUpperCase();
}

/** Split one paragraph into sentences. Conservative: only cuts before an uppercase letter or digit. */
export function splitSentences(paragraph: string): string[] {
  const out: string[] = [];
  const boundary = /([.!?…]+["”’')\]]*)\s+(?=[\p{Lu}\d"“(])/gu;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(paragraph)) !== null) {
    const endOfPunct = m.index + m[1].length;
    const before = paragraph.slice(start, m.index);
    const lastWord = (before.match(/(\S+)$/) || ['', ''])[1];
    if (m[1] === '.' && isAbbreviation(lastWord)) continue;
    out.push(paragraph.slice(start, endOfPunct).trim());
    start = m.index + m[0].length;
  }
  const tail = paragraph.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

function splitParagraph(paragraph: string): string[] {
  if (paragraph.length <= LONG_PARAGRAPH_CHARS || LIST_LINE_RE.test(paragraph)) return [paragraph];
  const sentences = splitSentences(paragraph);
  if (sentences.length <= MAX_SENTENCES_PER_MESSAGE) return [paragraph];
  const pieces: string[] = [];
  for (let i = 0; i < sentences.length; i += MAX_SENTENCES_PER_MESSAGE) {
    pieces.push(sentences.slice(i, i + MAX_SENTENCES_PER_MESSAGE).join(' '));
  }
  return pieces;
}

function capMessages(pieces: string[], max: number): string[] {
  const out = [...pieces];
  while (out.length > max) {
    let best = 0;
    for (let i = 1; i < out.length - 1; i++) {
      if (out[i].length + out[i + 1].length < out[best].length + out[best + 1].length) best = i;
    }
    out.splice(best, 2, `${out[best]}\n${out[best + 1]}`);
  }
  return out;
}

/** Returns the reply as an ordered list of chat messages (raw text, markers kept). */
export function splitIntoHumanMessages(text: string, max: number = MAX_MESSAGES): string[] {
  if (!text) return [text];
  const pieces: string[] = [];
  for (const segment of text.split(MSG_BREAK_RE)) {
    for (const para of segment.split(PARAGRAPH_RE)) {
      const trimmed = para.trim();
      if (!trimmed) continue;
      pieces.push(...splitParagraph(trimmed));
    }
  }
  if (pieces.length === 0) return [''];
  return capMessages(pieces, max);
}
