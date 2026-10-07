import { describe, expect, test } from 'vitest';
import { briefDescription, splitImageRefs } from './approvalBrief';

// Option A approval rows (7 Oct 2026): the request and ticket summary as readable text.
describe('approval brief text', () => {
  test('image markers become a picture list, not text', () => {
    expect(splitImageRefs('Price is $1059 instead of $916 [Image: pasted-image-1.png]')).toEqual({
      text: 'Price is $1059 instead of $916',
      names: ['pasted-image-1.png'],
    });
    expect(splitImageRefs('')).toEqual({ text: '', names: [] });
  });

  test('the description loses the pasted-source footer and stacked blank lines', () => {
    const ticket = { descriptionText: 'Request: a work phone.\n\n \n\n Next step: order it\n\n — Source material (pasted) — \n [Image: screenshot-1.png]' };
    expect(briefDescription(ticket)).toBe('Request: a work phone.\n\nNext step: order it');
    expect(briefDescription(null)).toBe('');
  });
});
