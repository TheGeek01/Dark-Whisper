// whisper-stream writes some text that nobody said: stock phrases on silence or noise, and the
// end of a sentence it already sent when it transcribes an overlapping window again. With
// paragraphs split at pauses, each would otherwise become a paragraph of its own.

// Compared after normalizeSpeech.
const FILLERS = new Set([
  'thank you',
  'thank you very much',
  'thank you so much',
  'thanks',
  'thanks for watching',
  'thank you for watching',
  'thanks for listening',
  'thank you for listening',
  'please subscribe',
  'you',
  'bye',
  'bye bye',
]);

// A repeat must be at least this many words before it is matched against the end of earlier
// text; a short word like "yes" legitimately ends many sentences.
const MIN_SUFFIX_WORDS = 3;

export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function isFillerText(text: string): boolean {
  const words = normalizeSpeech(text);
  return words === '' || FILLERS.has(words);
}

// The same words again, or the tail of a recent line sent again.
export function repeatsRecent(text: string, recent: readonly string[]): boolean {
  const words = normalizeSpeech(text);
  if (words === '') return true;
  const longEnough = words.split(' ').length >= MIN_SUFFIX_WORDS;
  return recent.some((line) => {
    const earlier = normalizeSpeech(line);
    return earlier === words || (longEnough && earlier.endsWith(` ${words}`));
  });
}
