# Design decisions

Short records of the choices behind einvoice-ae. Each one states the context, the decision and its consequences.

---

## ADR-001: Scope is PINT AE Billing 1.0.4, invoices and credit notes

**Context.** The UAE publishes several specifications at docs.peppol.eu/poac/ae: PINT AE Billing, PINT AE Self-billing and the Tax Data Document. The latest Billing release is 1.0.4 (release notes dated 2026-06-02, published in PDK 1.4.4 on 2026-07-29).

**Decision.** Support PINT AE Billing 1.0.4: Invoice types 380 (tax invoice) and 480 (out of scope of tax), CreditNote types 381 and 81, with the identifiers `urn:peppol:pint:billing-1@ae-1` and `urn:peppol:bis:billing` from section 5.1.1 of the BIS. Self-billing (389, 261) and category N with the profit margin scheme are out of scope (see ADR-005).

**Consequences.** The library is precise about one specification version. A new release means reviewing the release notes, updating `validator/artefacts.lock.json` and re-running the conformance suite.

---

## ADR-002: Money is integer minor units; quantities and rates are decimal text

**Context.** Binary floating point cannot represent 0.1 exactly. TopFlow Hub (ADR-006 in that project) already computes in integer fils for the same reason.

**Decision.** Every amount in the input and in the results is an integer number of hundredths of the document currency (fils for AED). Quantities, percentages and exchange rates are decimal strings parsed into scaled BigInt values. Each product (quantity × price, base × percent, amount × rate) is computed exactly and rounded once, half away from zero.

**Consequences.** Totals are reproducible to the fil. Hundredths are used for every currency because PINT AE allows at most two decimals for document amounts (ibr-091, ibr-121 to ibr-125); prices with finer precision are expressed through the price base quantity (for example 4.50 per 10 pieces).

---

## ADR-003: VAT per category by default, per-line VAT as an option with a guard

**Context.** The BIS defines the VAT of a category as taxable amount × rate / 100 (IBT-117). Rule aligned-ibrp-s-09 accepts a difference of up to 0.02. Some systems, TopFlow Hub among them, compute VAT per line and sum it.

**Decision.** `vatRounding: 'category'` (default) rounds once per category. `vatRounding: 'line'` sums the rounded VAT of each line plus VAT on document-level charges minus allowances, and throws `VAT_ROUNDING_DRIFT` (citing aligned-ibrp-s-09) if the result drifts more than 0.02 from the category calculation.

**Consequences.** Systems with per-line VAT can issue invoices whose VAT equals their stored VAT (the TopFlow Hub example reconciles to the fil) without producing documents the validator rejects. Long invoices with many small lines may need category rounding.

---

## ADR-004: Where the official rules use binary arithmetic, emit the value they accept

**Context.** Most PINT AE rules cast to `xs:decimal` and compare exactly. Two do not: ibr-147-ae (line net = quantity × price / base quantity ± allowances and charges) and ibr-131-ae / ibr-146-ae (amount = base × percent / 100) apply arithmetic to untyped values, which XPath promotes to `xs:double`. For 1.05 × 36.90 = 38.745 the exact half-up result is 38.75, but the double product is just below 38.745, so the validator computes 38.74 and rejects 38.75.

**Decision.** `src/xpath-emulation.ts` re-evaluates those two rules with JavaScript numbers (the same IEEE 754 doubles, and `Math.round` rounds half towards positive infinity like `fn:round`). The calculation computes the exact half-up value, checks it with the emulation and, only when it fails, uses the neighbouring value the rule accepts. If neither neighbour passes, it throws `LINE_AMOUNT_ROUNDING`.

**Consequences.** Generated documents pass the official validator even at half-fil ties. The allowances-and-charges corpus document contains the 1.05 × 36.90 line and the conformance suite confirms 38.74 is accepted and, with an observation document, that 38.75 is rejected. In that rare case the line amount differs by one fil from exact decimal rounding, which is documented here and tested.

---

## ADR-005: VAT rates are fixed by the category; category N is not supported

**Context.** The UAE has one standard rate. Rule ibr-190-ae requires every S rate to be 5. Categories also differ in whether a rate is written: E and O lines carry none (aligned-ibrp-e-05, aligned-ibrp-o-05), document-level E and AE items must state 0 (aligned-ibrp-e-06/07, aligned-ibrp-ae-06/07), AE lines must state a rate (aligned-ibrp-ae-05-ae). Category N (standard rate additional VAT) is only meaningful with the profit margin scheme and carries VAT outside the document totals.

**Decision.** The input names a category only; the library writes the rate the rules require. The AE breakdown uses the line rate (5) and includes document-level AE items stated at 0, as the published examples do. N and the profit margin flag are rejected with `UNSUPPORTED`.

**Consequences.** Callers cannot produce an inconsistent rate. Margin-scheme sellers cannot use this version of the library.

---

## ADR-006: Line amounts in AED follow the BIS text

**Context.** Section 3.1.1 of the BIS requires the VAT line amount (BTAE-08) and the line amount payable (BTAE-10) in AED, whatever the currency of the invoice. The published Exports example states them in USD. The rules do not check the currency of `cac:ItemPriceExtension` (ibr-126 exempts it).

**Decision.** Follow the text: BTAE-08 and BTAE-10 are always in AED. For a foreign-currency document each amount is converted with the exchange rate (BTAE-04) and rounded half away from zero. The AED total VAT (IBT-111) and total with VAT (BTAE-20) are converted the same way.

**Consequences.** Foreign-currency documents carry the AED values the text asks for and still pass validation (see the foreign-currency and zero-rated-export corpus documents).

---

## ADR-007: Validation artefacts are downloaded and pinned, not committed

**Context.** The copyright statement of the PINT AE BIS says the document may not be modified or redistributed without the prior consent of OpenPEPPOL AISBL. The Schematron and XSLT files carry no licence notice; some example files carry an Apache-2.0 header. The UBL 2.1 schema files carry an OASIS copyright notice with all rights reserved.

**Decision.** Do not commit any of these files. `npm run artefacts:fetch` downloads them from the official sources into the git-ignored `validator/.artefacts/` and checks each against a SHA-256 value in `validator/artefacts.lock.json`. The Saxon-HE and xmlresolver jars are fetched the same way from Maven Central. See [validation-artefacts.md](validation-artefacts.md).

**Consequences.** The repository contains no third-party specification files. The official resources URL is not versioned, and the archive there was last modified on 7 September 2026, weeks after the 1.0.4 release, with no new version number. When the file changes, the checksum check fails with a message that explains what to do; that is intended, because the rules may have changed.

So that such a change does not fail every pull request, the CI conformance job restores the verified files from its cache. A scheduled workflow (`.github/workflows/artefacts.yml`, twice a week) keeps that cache in use and downloads the files again, so an upstream change fails that workflow only. A fresh clone without the cache still fails until the lock file is updated. GitHub turns off scheduled workflows in a public repository after 60 days without activity, so the check needs re-enabling after a quiet period.

---

## ADR-008: Java runs only in a Docker image with Saxon-HE 12.10

**Context.** The official Schematron is published as compiled XSLT 2.0, which needs an XSLT 2.0 processor. Java is not installed on the development host.

**Decision.** `validator/Dockerfile` compiles a single Java program (`Validator.java`, compiled with `-Xlint:all -Werror`) on Temurin 25 and runs it on the Temurin 25 JRE. It validates each document against the UBL 2.1 XSD (JAXP, secure processing, no DOCTYPE) and runs both Schematron layers with Saxon-HE s9api, compiling the stylesheets once per run. Output is JSON. The container runs with `--network none`, a memory limit and a non-root user. Saxon-HE 12.10 is used rather than 13.0 (published to Maven Central in May 2026) because 12.x is the line the Peppol validation tools have used; moving is a one-line change in the lock file.

**Consequences.** CI and developers run exactly the same validation. The image has no network dependency at build time because the artefacts are fetched and verified on the host first.

---

## ADR-009: Code lists come from the Schematron, with a drift check

**Context.** The library should accept exactly the codes the validator accepts. The genericode files and the Schematron tests are both published, but they are not identical (see validation-artefacts.md: the category N code).

**Decision.** `npm run codelists:sync` extracts the literal value lists from the relevant assert tests (for example ibr-cl-23 for unit codes, ibr-128-ae for emirates) into `src/codelists/generated.ts`. CI runs it with `--check` and fails when the committed file differs.

**Consequences.** The input checks cannot disagree with the validator about a code. Names for PINT AE codes (used in messages) are kept by hand in `src/codelists/pint-ae.ts` with the source recorded, and the input checks read those lists; a unit test (`test/unit/codelists.test.ts`) fails when their codes differ from the generated lists, so an upstream change reaches the checks as well.

---

## ADR-010: Input checks mirror the official rules; the Schematron stays the authority

**Context.** A rejection from an Accredited Service Provider is slow and expensive to diagnose. The official rules exist only as Schematron.

**Decision.** `validateInvoiceInput` and `validateCreditNoteInput` check the typed input before any XML is built and return every problem with a path, a code and, where one exists, the rule ID it mirrors (for example `seller.trn INVALID_TRN ibr-132-ae`). Identifier formats are checked only as far as the specification defines them: TRN 15 digits starting with 1 and ending with 03 (ibr-132-ae), TIN 10 digits starting with 1 (ibr-148-ae); no checksum is invented. The conformance suite then validates generated documents with the real rules.

**Consequences.** Mistakes surface in the caller's code with the rule ID. Some checks are stricter than the published validator where a rule does not run as intended (ADR-011).

---

## ADR-011: A corpus of valid, broken and gap documents

**Context.** The spec requires valid documents for several scenarios and one broken document per important rule, each failing with exactly that rule.

**Decision.** `corpus/scenarios.ts` builds 17 valid documents with the library. `corpus/broken.ts` derives 47 broken documents with minimal text mutations; where a single change would break two rules, the mutation also adjusts dependent totals. `corpus/gaps.ts` holds two documents that break a rule's intent but pass the published validator, and `corpus/observations.ts` three documents that reproduce observations about the published rules (docs/validation-artefacts.md). Files are generated (`npm run corpus:generate`) and committed; a unit test fails when they differ from the library output, and the conformance suite asserts the exact set of failed rule IDs for each file.

**Consequences.** Each broken document documents one rule. Changes in the library output show up as a diff in reviewable XML.

---

## ADR-012: No runtime dependencies; a small deterministic XML writer

**Context.** An invoicing library sits in finance systems where every dependency is a supply-chain risk. UBL generation needs only element and attribute output.

**Decision.** The published package has no runtime dependencies. `src/xml.ts` writes elements with a fixed attribute order, two-space indentation and LF line ends, escapes text and attributes, rejects characters XML 1.0 cannot carry and refuses empty elements (ibr-079). Element order follows the UBL 2.1 schema sequences, which differ between Invoice and CreditNote.

**Consequences.** The same input always gives the same bytes, so SHA-256 fingerprints are stable. The writer is intentionally limited to what UBL documents need.

---

## ADR-013: Issued documents are fingerprinted and frozen; corrections are credit notes

**Context.** A tax invoice must not change after issue; the UAE model corrects invoices with credit notes only (BIS section 1.5.4).

**Decision.** Built documents are deep-frozen. `issueDocument` checks that the record's type, number, UUID, issue date, currency, total and line quantities match its XML, records the SHA-256 of the exact UTF-8 bytes and deep-freezes the record. `DocumentLedger`:

- issues idempotently: the same number and bytes return the stored record, and a different document under an issued number is refused;
- refuses `update` and `delete`, and re-checks the fingerprint on read;
- accepts a credit note only when it references exactly one invoice in the ledger (a volume discount credit note references none), in the same currency, not dated before it, and does not take the credited total above the invoice total;
- runs `issue` calls one at a time, because the check and the insert are otherwise separated by awaits and two concurrent credit notes could both pass.

Storage is pluggable through `DocumentStore`. How credit notes are built is ADR-019.

**Consequences.** The rules are enforced in one place, and a test issues credit notes concurrently to prove the cap holds. Credit notes that reference several invoices are refused, because the document does not say how its total is split between them. The serialisation covers one ledger object in one process. The in-memory store is for tests and demos; a production store must be insert-only and, when several processes share it, must make the checks atomic with the insert (a transaction that locks the invoice row, or a credited-total column with a CHECK constraint).

---

## ADR-014: Provider client with idempotency keys, full-jitter backoff and signed callbacks

**Context.** There is no standard ASP API. Network calls fail; a lost response must not create a second submission.

**Decision.** `AccreditedServiceProvider` defines `submit` and `getStatus`. `HttpAspClient`:

- sends the document number, percent-encoded as UTF-8, as `Idempotency-Key` and the SHA-256 as `X-Document-SHA256`;
- requires https unless the provider runs on this machine, because every request carries the API key;
- times out each attempt, retries network errors, timeouts, 408, 425, 429 and 5xx with exponential backoff and full jitter, and never retries other 4xx or a request that cannot be sent as built;
- waits as long as `Retry-After` asks, and when that is longer than `retry.maxDelayMs` stops with `AspUnavailableError.retryAfterMs`, so the caller can reschedule. A 409 means the number was used for different content.

Status callbacks are signed with HMAC-SHA256 over the timestamp and body and checked in constant time; timestamps outside a 300-second window are refused. The handler remembers each signature for that window: an exact repeat gets the answer of the first delivery, and waits for it while the application is still handling the report. After a 413 it closes the connection instead of reading the rest of the body. `MockAspServer` implements the same API with failure injection for tests, and sends callbacks only to hosts on this machine unless configured otherwise.

**Consequences.** Retrying a submission is safe. The replay memory is per process, and a provider can deliver the same report twice with fresh signatures, so the application's report handler must still be idempotent. Adapting to a real provider means implementing the interface for its API; the retry policy and callback verification can be reused.

---

## ADR-015: Tooling versions chosen for Node.js 20 support

**Context.** The library supports Node.js 20 and later. TypeScript 7 is current, but typescript-eslint 8.70 supports TypeScript below 6.1. Vitest 5 requires Node.js 22.

**Decision.** TypeScript 6.0.3, Vitest 4.1.11, `@types/node` 20, all pinned exactly with a lockfile. Dependabot ignores the updates that would break this (documented in `.github/dependabot.yml`).

**Consequences.** Unit tests run on Node.js 20, 22 and 24 in CI and the package is smoke-tested on Node.js 20. The TypeScript and Vitest majors move when their constraints change.

---

## ADR-016: Volume discount credit notes follow the published rule, not the BIS text

**Context.** The BIS says the preceding invoice reference is optional for volume discount (VD) credit notes. Rule ibr-055-ae as published passes a 381 credit note when it has a billing reference and a reason other than VD, or no billing reference and reason VD. A credit note whose only reason is VD and which has a billing reference fails; tested with the validator in this repository.

**Decision.** For reason VD the library requires that no preceding invoice is given and cites ibr-055-ae.

**Consequences.** Generated VD credit notes pass the published validator. If the rule is corrected upstream, this check can be relaxed.

---

## ADR-017: Provider tests use a configurable port range and close every connection

**Context.** The provider tests start real HTTP servers. They must run next to other local services and in CI, and the retry tests count attempts exactly, so an unexpected network error would make them fail.

**Decision.** Provider tests listen on a configurable port range, `EINVOICE_AE_TEST_PORTS` (default 58801-58809), taking ports in rotation. Test servers answer with `Connection: close`, so a pooled socket from an earlier test cannot reach a later server on the same port and cause an extra retry.

**Consequences.** Tests do not collide with other services, and the retry counts they assert are stable; another machine or CI can choose a different range.

---

## ADR-018: The TopFlow Hub mapping reconstructs the list price and takes missing data as options

**Context.** TopFlow Hub stores the discounted unit price and the discount rate on order lines, not the list price; the list price is on the quotation the B2B order came from (`QuotationItem.listPrice`). It does not store the buyer's Peppol endpoint or the authority that issued the buyer's trade licence. Several fields are nullable in its Prisma schema: the order's organisation, payment method and structured delivery address, and the organisation's legal name, TRN, trade licence number and email.

**Decision.** `examples/topflow-order.ts` mirrors that nullability in its types and invoices only orders with status DELIVERED. It takes the list prices from the quotation when they are passed. Otherwise it recovers them from TopFlow Hub's discount formula, and refuses the order when it cannot recover them exactly; the comments in the file explain the search. A missing TRN or licence number is left out. Other missing data, a refunded order and an order with only a free-text address (unless `buyerAddress` is given) are refused with a message that names the field. The buyer's endpoint and licence authority are options. Every stored line amount, VAT amount and total is reconciled with the built invoice before use.

**Consequences.** The invoice shows the gross price and discount the customer saw, or the mapping stops instead of guessing. Missing master data is explicit in the mapping options rather than invented.

---

## ADR-019: Partial credit notes are pro-rated on the cumulative credited quantity

**Context.** A credit note may correct part of an invoice: some lines, or part of a line's quantity. Allowances, charges and VAT are not amounts per unit. Copied into each partial credit note, they are applied again: two half credits of a 10 x 100.00 line with a 50.00 allowance came to 945.00 instead of 997.50, and the rest could not be credited. Rounding each part on its own does not add up either: an invoice VAT of 47.51 splits into two halves of 23.755, each rounded to 23.76.

**Decision.** `creditNoteFor` builds the credit note from the original invoice input. A credit note that takes a line from quantity c0 to c1 of Q invoiced carries round(A x c1 / Q) - round(A x c0 / Q) of each line allowance and charge A. Document-level allowances and charges follow the credited share of the line amounts in their VAT category, and the VAT of category S follows the credited share of the taxable amount; the credit note states that VAT (`standardRatedVat`, within the 0.02 tolerance of aligned-ibrp-s-09). When quantity x price of the credited part rounds differently from its share (2.5 x 3.33 = 8.325, or a half-fil tie under ADR-004), the difference, a few fils at most, becomes a document-level allowance or charge in that category with a fixed reason. `creditNoteFor` also refuses a date before the invoice and a quantity above what earlier credit notes left (`DocumentLedger.creditedQuantities`), and chooses type 81 when only exempt or out-of-scope lines of a tax invoice are credited, because a 381 needs another line (ibr-151-ae).

**Consequences.** The parts telescope: however an invoice is split, its credit notes add up to it exactly, in every total and every VAT breakdown amount. A unit test checks the sums for random invoices split at random, and the conformance suite runs seeded random invoices and their partial credit notes through the official validator. A partial credit note can carry a rounding allowance or charge of a few fils that its reader must understand. A credit note built another way is only held to the ledger's cap on the total.

---

## ADR-020: A rejected document is replaced under a new number

**Context.** An Accredited Service Provider can reject a submitted document, for example when its own checks fail or the buyer cannot be reached. The client sends the document number as the idempotency key, so the provider answers 409 to different content under that number, and `DocumentLedger` refuses a different document under an issued number. A credit note cannot correct a document that was never delivered.

**Decision.** A rejected document keeps its number: it stays in the ledger, issued and unchanged, and the application keeps the rejection report next to it. The corrected document is issued under a new number and submitted like any other. The ledger does not record delivery status; that belongs to the application's submission records, which the status reports and callbacks feed.

**Consequences.** A number always means one document, for the ledger and for the provider, and the audit trail keeps the rejected one. Each rejection leaves a gap in the number sequence; whether such a gap needs explaining is a question for the seller's tax adviser or provider, not for this library. The ledger would still accept a credit note against a rejected invoice, so the application must not issue one. The flow is tested against the mock provider and shown by `npm run example:submit`.
