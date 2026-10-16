/** Counting uses transcript tokens, never substring matches (e.g. Java). */
export const JA_PATTERN = /(?<![\p{L}\p{N}_])ja(?![\p{L}\p{N}_])/giu;
const VARIANT_PATTERN = /(?<![\p{L}\p{N}_])(?:ja|yeah|ya)(?![\p{L}\p{N}_])/giu;
const STOP = /[.!?…][\s\u0022'”’)]*$/u;

export function findTokens(text, includeVariants = false) {
  return [...String(text || '').matchAll(new RegExp(includeVariants ? VARIANT_PATTERN : JA_PATTERN))]
    .map(match => ({ index: match.index, length: match[0].length, word: match[0] }));
}

export function formatTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  return `${minutes.toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}

/** Unicode words, including contractions; case and surrounding punctuation are ignored. */
export function wordFrequency(words) {
  const counts = new Map();
  let total = 0;
  for (const token of words) {
    const text = typeof token === 'string' ? token : token.word;
    for (const match of String(text || '').normalize('NFKC').matchAll(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)) {
      const word = match[0].toLocaleLowerCase('en').replaceAll('’', "'");
      counts.set(word, (counts.get(word) || 0) + 1);
      total++;
    }
  }
  return { total, unique: counts.size, entries: [...counts].map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word)) };
}

/** Each overlapping audio window owns a disjoint interval, so repeated ja's survive. */
export function extractChunk(data, { offset = 0, from = 0, to = Infinity, id = 'chunk' } = {}) {
  const rawWords = Array.isArray(data.words) ? data.words : [];
  const words = rawWords.filter(w => typeof w.word === 'string' && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w, i) => ({ word: w.word, start: offset + w.start, end: offset + w.end, id: `${id}-${i}`, approximate: false }))
    .filter(w => (w.start + w.end) / 2 >= from && (w.start + w.end) / 2 < to);
  if (words.length || rawWords.length) return words;
  // A segment-only response remains useful, but its token times are explicitly approximate.
  return (data.segments || []).flatMap((segment, s) => {
    const tokens = String(segment.text || '').match(/\S+/gu) || [];
    const length = Math.max(0, Number(segment.end) - Number(segment.start));
    return tokens.map((word, i) => ({ word, start: offset + Number(segment.start) + length * i / tokens.length,
      end: offset + Number(segment.start) + length * (i + 1) / tokens.length, id: `${id}-s${s}-${i}`, approximate: true }));
  }).filter(w => Number.isFinite(w.start) && (w.start + w.end) / 2 >= from && (w.start + w.end) / 2 < to);
}

export function getMatches(words, { includeVariants = false, endOnly = false } = {}) {
  return words.flatMap((word, index) => {
    const next = words[index + 1];
    const gap = next ? next.start - word.end : 0;
    // Word-level Whisper responses often omit punctuation. This is a reviewable heuristic.
    const sentenceEnd = STOP.test(word.word) || gap >= 0.65;
    if (endOnly && !sentenceEnd) return [];
    const context = words.slice(Math.max(0, index - 7), Math.min(words.length, index + 5)).map(w => w.word.trim()).join(' ');
    return findTokens(word.word, includeVariants).map((token, tokenIndex) => ({
      id: `${word.id}-m${tokenIndex}`, word: token.word, start: word.start, end: word.end,
      context, sentenceEnd, approximate: word.approximate,
    }));
  });
}

export function histogram(matches, duration, bins = 30) {
  const counts = new Array(bins).fill(0);
  const width = Math.max(1, duration) / bins;
  for (const match of matches) counts[Math.min(bins - 1, Math.max(0, Math.floor(match.start / width)))]++;
  return counts;
}

export function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

export function buildCsv({ title, matches, adjustment, duration, transcript, demo = false, words = [] }) {
  const rows = [ ['Lecture', title], ['Source', demo ? 'Sample demo - not a real recording' : 'OpenAI Whisper'],
    ['Duration seconds', duration.toFixed(2)], ['Automatic matches', matches.length], ['Manual adjustment', adjustment],
    ['Final count', Math.max(0, matches.length + adjustment)], [], ['Time', 'Seconds', 'Word', 'Context', 'Timing'] ];
  for (const match of matches) rows.push([formatTime(match.start), match.start.toFixed(2), match.word, match.context, match.approximate ? 'Approximate' : 'Word timestamp']);
  const frequency = wordFrequency(words);
  rows.push([], ['Total words', frequency.total], ['Unique words', frequency.unique], ['Word', 'Occurrences']);
  for (const entry of frequency.entries) rows.push([entry.word, entry.count]);
  rows.push([], ['Transcript'], [transcript]);
  return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
