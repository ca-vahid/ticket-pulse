/** @vitest-environment jsdom */
import { beforeEach, describe, expect, test } from 'vitest';
import { firstWord, forgetPhrases, ownPhrases, phrasesFor, rememberSentText, splitPhrases, suggestCompletion } from './composerPhrases';

beforeEach(() => localStorage.clear());

describe('splitPhrases', () => {
  test('keeps sentences worth offering again, drops links, code, markers and scraps', () => {
    const text = 'Hi Rita,\nThanks for the details. I have pushed the firmware update to your dock tonight.\nSee https://kb.example.com/dock for the steps.\n[Image: pasted-image-1.png]\nOK.\n- Please restart the laptop before you leave today.';
    expect(splitPhrases(text)).toEqual([
      'Thanks for the details.',
      'I have pushed the firmware update to your dock tonight.',
      'Please restart the laptop before you leave today.',
    ]);
  });
});

describe('what was sent is remembered, per person, in this browser', () => {
  test('most used first; the requester\'s first name becomes whoever the ticket is for', () => {
    rememberSentText('Hi Rita, thanks for getting back to me.\nI will let you know once the vendor replies.', { firstName: 'Rita' });
    rememberSentText('I will let you know once the vendor replies.', { firstName: 'Sam' });
    expect(ownPhrases()[0]).toBe('I will let you know once the vendor replies.');
    const forSam = phrasesFor({ firstName: 'Sam' });
    expect(forSam).toContain('Hi Sam, thanks for getting back to me.');
    expect(forSam.join(' ')).not.toContain('Rita');
    // No name on the ticket: a phrase that needs one is not offered.
    expect(phrasesFor({ firstName: '' }).join(' ')).not.toContain('{{name}}');
  });

  test('templates and quick notes are offered after the person\'s own phrases, without repeats', () => {
    rememberSentText('Please restart the laptop before you leave today.');
    const all = phrasesFor({ extraTexts: ['Please restart the laptop before you leave today. Could you tell me the model of the device?'] });
    expect(all).toEqual(['Please restart the laptop before you leave today.', 'Could you tell me the model of the device?']);
  });

  test('"Forget them" empties the store', () => {
    rememberSentText('Please restart the laptop before you leave today.');
    forgetPhrases();
    expect(ownPhrases()).toEqual([]);
  });
});

describe('suggestCompletion', () => {
  const phrases = ['I will let you know once the vendor replies.', 'I will push the update tonight.', 'Could you tell me the model of the device?'];
  test('offers the rest of the first phrase that starts the same way, whatever the capitals', () => {
    expect(suggestCompletion('I wil', phrases)).toBe('l let you know once the vendor replies.');
    expect(suggestCompletion('i will p', phrases)).toBe('ush the update tonight.');
    expect(suggestCompletion('Thanks. Could you', phrases)).toBe(' tell me the model of the device?');
  });
  test('needs a few letters, a match, and something left to offer', () => {
    expect(suggestCompletion('I w', phrases)).toBeNull();
    expect(suggestCompletion('Nothing like it', phrases)).toBeNull();
    expect(suggestCompletion('I will push the update tonight.', phrases)).toBeNull();
    expect(suggestCompletion('', phrases)).toBeNull();
  });
  test('Ctrl+Right takes one word', () => {
    expect(firstWord(' tell me the model')).toBe(' tell');
    expect(firstWord('l let you know')).toBe('l');
  });
});
