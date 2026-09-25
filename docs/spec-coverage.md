# Specification coverage

What einvoice-ae supports from PINT AE Billing 1.0.4, and how each rule is handled. Rule IDs are those of the official Schematron (`ibr-…` from the PINT layer, `…-ae` and `aligned-ibrp-…` from the UAE layer).

## Documents and business cases

| Area | Supported | Notes |
| --- | --- | --- |
| Document types | Invoice 380 and 480, CreditNote 381 and 81 | Self-billing (389, 261) is a separate specification and not supported. |
| VAT categories | S (5 %), Z, E (with exemption reason code), O, AE | N (standard rate additional VAT, margin scheme) is not supported. |
| Transaction types (BTAE-02) | Free trade zone, deemed supply, summary invoice, continuous supply, disclosed agent billing, e-commerce, exports | Profit margin scheme is not supported (needs category N). |
| Parties | Seller and buyer with endpoint, TRN, TIN (seller), legal registration (TL, EID, PAS, CD), trading name, address, contact; beneficiary (BTAE-01); principal (BTAE-14) | Payee and tax representative parties are not modelled. |
| Predefined endpoints | 9900000097, 9900000098, 9900000099 | |
| Lines | Quantity (any decimals), unit code, net and gross price, price base quantity, line allowances and charges (fixed or percentage), item identifiers, HS code, service accounting code, item type, reverse-charge goods type, item attributes, line period, order line reference | |
| Document level | Allowances and charges (fixed or percentage) in every supported category, prepaid amount, rounding amount | |
| Currency | AED, or any ISO 4217 currency with an AED exchange rate; AED line and total amounts (BTAE-08, BTAE-10, BTAE-20, IBT-111) | |
| References | Buyer reference, purchase and sales order, contract, project, customs reference (BTAE-21), preceding invoices (credit notes) | Attachments and despatch or receipt advice references are not modelled. |
| Delivery | Date, location identifier, address, party name, Incoterms (BTAE-22) | |
| Payment | Payment means with account, card (masked number only: the last four digits and at most the first six, as the Peppol BIS guidance on the card number and PCI DSS allow; a full number is refused with `CARD_NUMBER_NOT_MASKED`) or neither; payment terms | |

## How rules are handled

**Checked on input, with the rule ID in the error.** The input checks mirror these rules:

`aligned-ibrp-032`, `aligned-ibrp-037`, `aligned-ibrp-057`, `aligned-ibrp-058`, `aligned-ibrp-s-09` (per-line rounding guard), `ibr-001-ae`, `ibr-002-ae`, `ibr-005-ae`, `ibr-006-ae`, `ibr-007-ae`, `ibr-010-ae`, `ibr-011-ae`, `ibr-012-ae`, `ibr-013-ae`, `ibr-016`, `ibr-022`, `ibr-023`, `ibr-025`, `ibr-029`, `ibr-030`, `ibr-031`, `ibr-033`, `ibr-036`, `ibr-038`, `ibr-041`, `ibr-042`, `ibr-043`, `ibr-044`, `ibr-055-ae`, `ibr-057`, `ibr-066`, `ibr-073`, `ibr-077`, `ibr-079`, `ibr-080`, `ibr-081`, `ibr-083`, `ibr-085`, `ibr-086`, `ibr-101-ae`, `ibr-103-ae`, `ibr-114-ae`, `ibr-115-ae`, `ibr-119`, `ibr-122-ae`, `ibr-124-ae`, `ibr-125-ae`, `ibr-127-ae`, `ibr-128-ae`, `ibr-131-ae`, `ibr-132-ae`, `ibr-134-ae`, `ibr-135-ae`, `ibr-136-ae`, `ibr-137-ae`, `ibr-138-ae`, `ibr-139-ae`, `ibr-141-ae`, `ibr-142-ae`, `ibr-143-ae`, `ibr-144-ae`, `ibr-145-ae`, `ibr-146-ae`, `ibr-147-ae`, `ibr-148-ae`, `ibr-150-ae`, `ibr-151-ae`, `ibr-152-ae`, `ibr-157-ae`, `ibr-158-ae`, `ibr-159-ae`, `ibr-160-ae`, `ibr-166-ae`, `ibr-167-ae`, `ibr-168-ae`, `ibr-169-ae`, `ibr-172-ae`, `ibr-173-ae`, `ibr-174-ae`, `ibr-176-ae`, `ibr-177-ae`, `ibr-183-ae`, `ibr-184-ae`, `ibr-185-ae`, `ibr-186-ae`, `ibr-191-ae`, `ibr-192-ae`, `ibr-cl-01`, `ibr-cl-04`, `ibr-cl-10`, `ibr-cl-14`, `ibr-cl-15`, `ibr-cl-16`, `ibr-cl-19`, `ibr-cl-20`, `ibr-cl-21`, `ibr-cl-23`, `ibr-cl-25`, `ibr-cl-26`, `ibr-co-19`, `ibr-co-20`, `ibr-co-26`.

**Satisfied by construction.** The builder always writes these correctly, so no input can break them:

- Identification: `aligned-ibrp-001-ae`, `aligned-ibrp-002-ae`, `ibr-154-ae` (eight flags), `ibr-193-ae` (UUID written or generated).
- Totals: `ibr-co-10` to `ibr-co-16`, `ibr-012` to `ibr-015`, two decimals for `ibr-091` and `ibr-121` to `ibr-125`.
- VAT breakdown: one breakdown per category (`aligned-ibrp-s-01`, `-z-01`, `-e-01`, `-o-01`, `-ae-01-ae`), taxable and tax amounts (`-s-08`, `-s-09`, `-z-08`, `-z-09`, `-e-08`, `-e-09`, `-o-08`, `-o-09`, `-ae-08-ae`, `-ae-09-ae`), rates by category (`ibr-190-ae`, `ibr-119-ae`, `ibr-120-ae`, `ibr-121-ae`, `aligned-ibrp-o-11-ae`, `-s-05` to `-s-07`, `-z-05` to `-z-07`, `-e-05` to `-e-07`, `-o-05` to `-o-07`, `-ae-05-ae` to `-ae-07`).
- Lines: gross price and price discount (`ibr-126-ae`, `aligned-ibrp-004`), base quantity unit (`ibr-088`), AED line amounts (`ibr-104-ae`, `ibr-162-ae`, `ibr-163-ae`, `ibr-165-ae`, `ibr-194-ae`).
- Currency: `ibr-126`, `ibr-053`, `ibr-084`, `ibr-140-ae`, `ibr-153-ae`, `ibr-175-ae`.
- Format: no empty elements (`ibr-079`), dates and times (`ibr-073`, `ibr-119`), at most one note and one of each single-occurrence element (`ibr-sr-…`).

**Exercised against the official validator.** `corpus/invalid/` holds one document per rule for 47 rules; the conformance suite asserts that each fails with exactly that rule ID and passes the UBL 2.1 schema. See `corpus/manifest.json` for the list.

**Known gaps in the published rules.** `ibr-128-ae` does not run on seller or buyer addresses and `ibr-co-14` does not run on credit notes; details and test documents are in [validation-artefacts.md](validation-artefacts.md). The library enforces both.
