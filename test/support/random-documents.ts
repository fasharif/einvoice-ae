/**
 * Seeded random invoices and partial credit splits, for property tests. The same seed
 * always gives the same documents, so a failure can be reproduced exactly.
 *
 * Inputs cover categories S, Z, E, O and AE, whole and decimal quantities, price base
 * quantities, gross prices, fixed and percentage line and document-level allowances and
 * charges (including a charge in a category no line uses), per-line VAT rounding and
 * documents in USD with an exchange rate.
 */
import { DEMO_NOTE, demoBuyer, demoCreditTransfer, demoSeller } from '../../corpus/demo-parties.js';
import {
  type CreditNoteDetails,
  type DocumentAllowanceCharge,
  type InvoiceInput,
  type LineAllowanceCharge,
  type LineInput,
  type SupportedTaxCategory,
} from '../../src/index.js';

/** Mulberry32: a small, fast, seedable pseudo-random generator. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Picker {
  constructor(readonly random: () => number) {}

  int(min: number, max: number): number {
    return min + Math.floor(this.random() * (max - min + 1));
  }

  chance(probability: number): boolean {
    return this.random() < probability;
  }

  one<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }
}

const UNIT_CODES = ['H87', 'MTR', 'XRO', 'C62', 'KGM'] as const;

function decimalText(units: number, scale: number): string {
  const text = String(units).padStart(scale + 1, '0');
  return scale === 0 ? text : `${text.slice(0, -scale)}.${text.slice(-scale)}`.replace(/\.?0+$/, '');
}

function randomQuantity(p: Picker): string {
  if (p.chance(0.6)) return String(p.int(1, 50));
  const scale = p.int(1, 3);
  return decimalText(p.int(1, 20 * 10 ** scale), scale);
}

function randomLine(p: Picker, index: number, category: SupportedTaxCategory): LineInput {
  const quantity = randomQuantity(p);
  const unitPrice = p.int(1, 50_000);
  const priceBaseQuantity = p.chance(0.2) ? p.one(['10', '12', '2.5']) : undefined;
  const estimate = Math.max(1, Math.round((Number(quantity) * unitPrice) / Number(priceBaseQuantity ?? '1')));
  const allowances: LineAllowanceCharge[] = [];
  const charges: LineAllowanceCharge[] = [];
  if (p.chance(0.3)) {
    allowances.push(
      p.chance(0.5)
        ? { amount: p.int(0, Math.floor(estimate / 5)), reason: 'Project rebate' }
        : { percent: decimalText(p.int(100, 1500), 2), baseAmount: estimate, reasonCode: '95', reason: 'Discount' },
    );
  }
  if (p.chance(0.2)) charges.push({ amount: p.int(1, 5_000), reasonCode: 'CG', reason: 'Cutting to length' });
  const tax: LineInput['tax'] = category === 'E' ? { category, exemptionReasonCode: 'DL8.46.2' } : { category };
  return {
    id: String(index + 1),
    quantity,
    unitCode: p.one(UNIT_CODES),
    unitPrice,
    ...(p.chance(0.2) ? { grossUnitPrice: unitPrice + p.int(0, 1_000) } : {}),
    ...(priceBaseQuantity !== undefined ? { priceBaseQuantity } : {}),
    ...(allowances.length > 0 ? { allowances } : {}),
    ...(charges.length > 0 ? { charges } : {}),
    item: {
      name: `Demo item ${index + 1}`,
      description: `Made-up item ${index + 1} for a property test`,
      ...(category === 'AE' ? { standardItemId: { id: '00000000000017', scheme: '0160' }, reverseChargeGoods: 'DL8.48.8.2' as const } : {}),
    },
    tax,
  };
}

/** A random tax invoice (380). Some inputs are refused by the library; callers skip those. */
export function randomInvoiceInput(p: Picker, n: number): InvoiceInput {
  const categories: SupportedTaxCategory[] = Array.from({ length: p.int(1, 5) }, () =>
    p.one<SupportedTaxCategory>(['S', 'S', 'S', 'Z', 'E', 'O', 'AE']),
  );
  if (!categories.some((c) => c !== 'E' && c !== 'O')) categories[0] = 'S';
  const lines = categories.map((category, index) => randomLine(p, index, category));
  const used = new Set(categories);
  const allowances: DocumentAllowanceCharge[] = [];
  const charges: DocumentAllowanceCharge[] = [];
  if (used.has('S') && p.chance(0.35)) {
    allowances.push(
      p.chance(0.5)
        ? { amount: p.int(1, 2_000), reason: 'Loyalty discount', tax: { category: 'S' } }
        : { percent: decimalText(p.int(50, 500), 2), baseAmount: p.int(100, 50_000), reasonCode: '95', reason: 'Discount', tax: { category: 'S' } },
    );
  }
  if (p.chance(0.35)) {
    const category = p.one<SupportedTaxCategory>(used.has('S') ? ['S', 'Z', 'O'] : ['Z', 'O']);
    charges.push({ amount: p.int(100, 20_000), reasonCode: 'FC', reason: 'Delivery', tax: { category } });
  }
  const foreign = p.chance(0.2);
  const id = `DEMO-RND-${String(n).padStart(4, '0')}`;
  return {
    id,
    uuid: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
    issueDate: '2026-09-01',
    dueDate: '2026-10-01',
    note: DEMO_NOTE,
    currency: foreign ? 'USD' : 'AED',
    ...(foreign ? { exchangeRate: '3.6725' } : {}),
    seller: demoSeller,
    buyer: demoBuyer,
    paymentMeans: [demoCreditTransfer],
    ...(allowances.length > 0 ? { allowances } : {}),
    ...(charges.length > 0 ? { charges } : {}),
    ...(p.chance(0.3) ? { vatRounding: 'line' as const } : {}),
    lines,
  };
}

/**
 * Splits an invoice into two to four credit notes: random quantities of random lines,
 * then "all" for whatever remains. Quantities keep the scale of the invoiced quantity.
 */
export function randomCreditSplit(p: Picker, input: InvoiceInput): NonNullable<CreditNoteDetails['lines']>[] {
  const remaining = new Map<string, { units: number; scale: number }>(
    input.lines.map((line, i) => {
      const text = String(line.quantity);
      const scale = text.includes('.') ? (text.split('.')[1] ?? '').length : 0;
      return [line.id ?? String(i + 1), { units: Number(text.replace('.', '')), scale }];
    }),
  );
  const steps: NonNullable<CreditNoteDetails['lines']>[] = [];
  const partialSteps = p.int(1, 3);
  for (let s = 0; s < partialSteps; s += 1) {
    const open = [...remaining].filter(([, r]) => r.units > 0);
    if (open.length === 0) break;
    const chosen = open.filter(() => p.chance(0.6));
    const pick = chosen.length > 0 ? chosen : [p.one(open)];
    steps.push(
      pick.map(([lineId, r]) => {
        const units = p.int(1, r.units);
        r.units -= units;
        return { lineId, quantity: decimalText(units, r.scale) };
      }),
    );
  }
  if ([...remaining.values()].some((r) => r.units > 0)) steps.push('all');
  return steps;
}
