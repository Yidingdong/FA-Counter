import test from 'node:test';
import assert from 'node:assert/strict';
import { findTokens, extractChunk, getMatches, histogram, formatTime, buildCsv, wordFrequency } from '../public/core.mjs';

const word = (text, start, end, id = `w-${start}`) => ({ word: text, start, end, id, approximate: false });

function readCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; i < text.length; i++) {
    const character = text[i];
    if (character === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (character === '\r' && text[i + 1] === '\n' && !quoted) {
      row.push(cell); rows.push(row); row = []; cell = ''; i++;
    } else cell += character;
  }
  row.push(cell); rows.push(row);
  assert.equal(quoted, false, 'CSV must close every quoted cell');
  return rows;
}

test('counts whole Unicode-delimited ja tokens, including sentence fillers and rapid repetition', () => {
  const text = 'ja Ja. !ja ja? ja ja Java Jahr ja2 2ja _ja ja_ ájas äja jaä';
  const tokens = findTokens(text);
  assert.deepEqual(tokens.map(token => token.word), ['ja', 'Ja', 'ja', 'ja', 'ja', 'ja']);
  for (const token of tokens) assert.equal(text.slice(token.index, token.index + token.length), token.word);
  assert.equal(findTokens('“ja”, (JA); ja!').length, 3);
  assert.deepEqual(findTokens(null), []);
});

test('yeah and ya are opt-in and still require whole word boundaries', () => {
  const text = 'ja yeah Yeah YA ya yacht yeah2 áyeah';
  assert.deepEqual(findTokens(text).map(token => token.word), ['ja']);
  assert.deepEqual(findTokens(text, true).map(token => token.word), ['ja', 'yeah', 'Yeah', 'YA', 'ya']);
});

test('half-open ownership intervals remove overlap duplicates while preserving separate nearby jas', () => {
  const first = extractChunk({ words: [
    { word: 'ja', start: 11.2, end: 11.3 },
    { word: 'ja', start: 11.45, end: 11.55 },
    { word: 'ja', start: 11.6, end: 11.7 },
  ] }, { from: 0, to: 11.5, id: 'first' });
  const second = extractChunk({ words: [
    { word: 'ja', start: 0.2, end: 0.3 },
    { word: 'ja', start: 0.45, end: 0.55 },
    { word: 'ja', start: 0.6, end: 0.7 },
  ] }, { offset: 11, from: 11.5, to: 22.5, id: 'second' });
  const matches = getMatches([...first, ...second]);
  assert.equal(matches.length, 3);
  assert.deepEqual(matches.map(match => Number(match.start.toFixed(2))), [11.2, 11.45, 11.6]);
  assert.equal(new Set(matches.map(match => match.id)).size, 3);
  assert.ok(matches.every(match => match.approximate === false));
});

test('word timestamps are offset globally and invalid words cannot create matches', () => {
  const words = extractChunk({ words: [
    { word: 'ja', start: 0, end: 0.2 },
    { word: 'ja', start: 0.8, end: 1 },
    { word: 'ja', start: '1', end: 1.2 },
    { word: null, start: 1.2, end: 1.4 },
  ] }, { offset: 30, from: 30.5, to: 32, id: 'offset' });
  assert.equal(words.length, 1);
  assert.equal(words[0].start, 30.8);
  assert.equal(words[0].end, 31);
});

test('segment fallback supplies approximate timestamps and applies ownership after offset', () => {
  const words = extractChunk({ segments: [{ text: 'One ja ja.', start: 0, end: 3 }] },
    { offset: 10, from: 11, to: 13, id: 'fallback' });
  assert.deepEqual(words.map(item => [item.word, item.start, item.end, item.approximate]), [
    ['ja', 11, 12, true], ['ja.', 12, 13, true],
  ]);
  assert.equal(getMatches(words).length, 2);
  assert.ok(getMatches(words).every(match => match.approximate));
});

test('sentence-end mode accepts closing punctuation or a pause and rejects ordinary/final bare ja', () => {
  const words = [word('ja', 0, 0.1), word('continues', 0.2, 0.4),
    word('ja?"', 0.5, 0.6), word('ja', 0.7, 0.8),
    word('next', 1.6, 1.8), word('ja', 1.9, 2)];
  assert.equal(getMatches(words).length, 4);
  const endMatches = getMatches(words, { endOnly: true });
  assert.deepEqual(endMatches.map(match => match.start), [0.5, 0.7]);
  assert.ok(endMatches.every(match => match.sentenceEnd));
  assert.equal(getMatches([word('yeah.', 0, 1)], { endOnly: true }).length, 0);
  assert.equal(getMatches([word('yeah.', 0, 1)], { endOnly: true, includeVariants: true }).length, 1);
});

test('CSV round-trips quotes, commas and embedded newlines and clearly labels sample data', () => {
  const title = 'Lecture, "materials"';
  const transcript = 'First line: "ja"\r\nSecond, line.';
  const context = 'He said "ja",\nthen continued';
  const match = { word: 'ja', start: 62.25, end: 62.5, context, approximate: true };
  const csv = buildCsv({ title, matches: [match], adjustment: -4, duration: 90.5, transcript, demo: true });
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const rows = readCsv(csv);
  assert.deepEqual(rows.find(row => row[0] === 'Lecture'), ['Lecture', title]);
  assert.deepEqual(rows.find(row => row[0] === 'Source'), ['Source', 'Sample demo - not a real recording']);
  assert.deepEqual(rows.find(row => row[0] === 'Final count'), ['Final count', '0']);
  assert.deepEqual(rows.find(row => row[0] === '01:02'), ['01:02', '62.25', 'ja', context, 'Approximate']);
  assert.deepEqual(rows.at(-1), [transcript]);
  const real = readCsv(buildCsv({ title, matches: [{ ...match, approximate: false }], adjustment: 1,
    duration: 90.5, transcript }));
  assert.deepEqual(real.find(row => row[0] === 'Source'), ['Source', 'OpenAI Whisper']);
  assert.equal(real.find(row => row[0] === '01:02').at(-1), 'Word timestamp');
});

test('histogram clamps edge timestamps and keeps every match exactly once', () => {
  assert.deepEqual(histogram([{ start: -0.1 }, { start: 0 }, { start: 2.49 }, { start: 2.5 },
    { start: 9.99 }, { start: 10 }, { start: 100 }], 10, 4), [3, 1, 0, 3]);
  assert.deepEqual(histogram([], 0, 4), [0, 0, 0, 0]);
  assert.deepEqual(histogram([{ start: 0 }], 0, 4), [1, 0, 0, 0]);
  assert.equal(formatTime(-3), '00:00');
  assert.equal(formatTime(3661.9), '61:01');
});


test('all-word frequency retains stopwords, German letters and numbers across word objects or strings', () => {
  const frequency = wordFrequency(['the and the', { word: 'I’m' }, { word: "I'M" }, 'über', 'ÜBER',
    { word: 'Straße' }, 'STRAßE', '2026 2026', '!!!', '']);
  assert.equal(frequency.total, 11);
  assert.equal(frequency.unique, 6);
  assert.deepEqual(Object.fromEntries(frequency.entries.map(entry => [entry.word, entry.count])), {
    '2026': 2, "i'm": 2, 'straße': 2, 'the': 2, 'über': 2, 'and': 1,
  });
  assert.equal(frequency.entries.reduce((sum, entry) => sum + entry.count, 0), frequency.total);
  assert.deepEqual(wordFrequency([]), { total: 0, unique: 0, entries: [] });
});

test('frequency normalizes English contractions, Unicode compatibility and punctuation', () => {
  const frequency = wordFrequency(["can't can’t CAN'T", "John's John’s", '“Ja!” ＪＡ', 'u\u0308ber, über.', '123; 123?']);
  const counts = new Map(frequency.entries.map(entry => [entry.word, entry.count]));
  assert.equal(frequency.total, 11);
  assert.equal(frequency.unique, 5);
  assert.equal(counts.get("can't"), 3);
  assert.equal(counts.get("john's"), 2);
  assert.equal(counts.get('ja'), 2);
  assert.equal(counts.get('über'), 2);
  assert.equal(counts.get('123'), 2);
});

test('frequency ranks by occurrences then alphabetically for equal counts', () => {
  assert.deepEqual(wordFrequency(['banana banana apple apple cherry date date date']).entries, [
    { word: 'date', count: 3 }, { word: 'apple', count: 2 },
    { word: 'banana', count: 2 }, { word: 'cherry', count: 1 },
  ]);
});

test('CSV includes frequencies for every transcribed word along with total and unique counts', () => {
  const rows = readCsv(buildCsv({ title: 'Words', matches: [], adjustment: 0, duration: 3,
    transcript: 'The the ja! And ja.', words: ['The', 'the', 'ja!', 'And', 'ja.'] }));
  assert.deepEqual(rows.find(row => row[0] === 'Total words'), ['Total words', '5']);
  assert.deepEqual(rows.find(row => row[0] === 'Unique words'), ['Unique words', '3']);
  const frequencyHeader = rows.findIndex(row => row[0] === 'Word' && row[1] === 'Occurrences');
  assert.ok(frequencyHeader > 0);
  assert.deepEqual(rows.slice(frequencyHeader + 1, frequencyHeader + 4), [['ja', '2'], ['the', '2'], ['and', '1']]);
});
