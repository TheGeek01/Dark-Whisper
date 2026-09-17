import { isFillerText, normalizeSpeech, repeatsRecent } from '../services/liveFilter';

describe('liveFilter', () => {
  it('compares words without case or punctuation', () => {
    expect(normalizeSpeech("  Thank you... I'm DONE! ")).toBe('thank you im done');
    expect(normalizeSpeech('.')).toBe('');
  });

  it('recognises what whisper-stream writes on silence', () => {
    for (const text of ['Thank you.', 'thank you', 'Thanks for watching!', 'you', ' You ', '.', '...', 'Bye.']) {
      expect(isFillerText(text)).toBe(true);
    }
  });

  it('keeps real speech, including short answers', () => {
    for (const text of ['Yes.', 'Okay.', 'Thank you, that helps.', 'you know what I mean', 'Stop testing.']) {
      expect(isFillerText(text)).toBe(false);
    }
  });

  it('spots the same line sent again', () => {
    expect(repeatsRecent('Testing one, two, three.', ['testing one two three'])).toBe(true);
    expect(repeatsRecent('Testing one, two.', ['Testing one, two, three.'])).toBe(false);
  });

  it('spots the end of a recent line sent again, if it is more than a word or two', () => {
    const recent = ["well what's going on with this quick note thing anyway that's the end of it"];
    expect(repeatsRecent('end of it.', recent)).toBe(true);
    expect(repeatsRecent('of it', recent)).toBe(false);
    expect(repeatsRecent('the start of it', recent)).toBe(false);
    expect(repeatsRecent('end of it', [])).toBe(false);
  });
});
