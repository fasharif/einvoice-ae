import { describe, expect, it } from 'vitest';
import { isPredefinedEndpoint, isValidTin, isValidTrn, isValidUaeEndpoint } from '../../src/identifiers.js';
import { passesAllowanceChargeRule, passesLineNetAmountRule } from '../../src/xpath-emulation.js';
import { containsInvalidXmlCharacter, element, escapeAttribute, escapeText, serialise, textElement } from '../../src/xml.js';

describe('UAE identifiers', () => {
  it.each(['100000000100003', '198765432102003', '134567890123003'])('accepts TRN %s', (trn) => {
    expect(isValidTrn(trn)).toBe(true);
  });

  it.each([
    ['too short', '10000000010003'],
    ['too long', '1000000001000003'],
    ['does not start with 1', '200000000100003'],
    ['does not end with 03', '100000000100004'],
    ['contains letters', '10000000010A003'],
  ])('rejects a TRN that is %s', (_why, trn) => {
    expect(isValidTrn(trn)).toBe(false);
  });

  it('checks the TIN format and nothing more (no checksum is defined)', () => {
    expect(isValidTin('1000000001')).toBe(true);
    expect(isValidTin('1987654321')).toBe(true);
    expect(isValidTin('2000000001')).toBe(false);
    expect(isValidTin('100000001')).toBe(false);
  });

  it('knows the three predefined endpoints', () => {
    expect(['9900000097', '9900000098', '9900000099'].every(isPredefinedEndpoint)).toBe(true);
    expect(isPredefinedEndpoint('9900000096')).toBe(false);
    expect(isValidUaeEndpoint('9900000099')).toBe(true);
    expect(isValidUaeEndpoint('1000000002')).toBe(true);
    expect(isValidUaeEndpoint('100000000200003')).toBe(false);
  });
});

describe('XML writer', () => {
  it('escapes text and attributes', () => {
    expect(escapeText('A & B <c> "d"')).toBe('A &amp; B &lt;c&gt; "d"');
    expect(escapeAttribute('say "hi"\n\tnow')).toBe('say &quot;hi&quot;&#10;&#9;now');
  });

  it('detects characters XML 1.0 cannot carry', () => {
    expect(containsInvalidXmlCharacter('ok\ttext\n')).toBe(false);
    expect(containsInvalidXmlCharacter('bell\u0007')).toBe(true);
    expect(containsInvalidXmlCharacter('￾')).toBe(true);
  });

  it('serialises deterministically and skips missing children', () => {
    const xml = serialise(element('root', [textElement('a', 'x & y', { id: '1' }), undefined, false, element('b', [textElement('c', '2')])]));
    expect(xml).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<root>\n  <a id="1">x &amp; y</a>\n  <b>\n    <c>2</c>\n  </b>\n</root>\n');
  });

  it('refuses to write an empty element (rule ibr-079)', () => {
    expect(() => serialise(element('root', [textElement('a', '  ')]))).toThrow('would be empty');
    expect(() => serialise(element('root', [element('b', [])]))).toThrow('would be empty');
  });

  it('refuses invalid characters in text', () => {
    expect(() => serialise(element('root', [textElement('a', 'x\u0000')]))).toThrow('Invalid XML character');
  });
});

describe('emulation of the double-precision rules', () => {
  it('accepts an exact line amount', () => {
    expect(
      passesLineNetAmountRule({
        lineExtensionAmount: '1850.00',
        quantity: '10',
        priceAmount: '185.00',
        baseQuantity: '1',
        chargeAmounts: [],
        allowanceAmounts: [],
      }),
    ).toBe(true);
  });

  it('reproduces a case where binary rounding differs from decimal half-up', () => {
    // 1.05 m3 x 36.90 = 38.745 exactly, so decimal half-up gives 38.75. As doubles the
    // product is just below 38.745, so the official rule computes 38.74 and rejects 38.75.
    const args = { quantity: '1.05', priceAmount: '36.90', baseQuantity: '1', chargeAmounts: [], allowanceAmounts: [] };
    expect(1.05 * 36.9 * 100).toBeLessThan(3874.5);
    expect(passesLineNetAmountRule({ ...args, lineExtensionAmount: '38.75' })).toBe(false);
    expect(passesLineNetAmountRule({ ...args, lineExtensionAmount: '38.74' })).toBe(true);
  });

  it('checks allowance amounts against base x percent', () => {
    expect(passesAllowanceChargeRule({ amount: '262.15', baseAmount: '10486.00', percent: '2.5' })).toBe(true);
    expect(passesAllowanceChargeRule({ amount: '262.16', baseAmount: '10486.00', percent: '2.5' })).toBe(false);
  });
});
