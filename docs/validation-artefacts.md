# Validation artefacts

The conformance suite validates documents with third-party files: the PINT AE Schematron (as compiled XSLT), the UBL 2.1 schemas and the Saxon-HE XSLT processor. None of them is committed to this repository. `npm run artefacts:fetch` downloads them from their official sources into `validator/.artefacts/` (git-ignored) and refuses any file whose SHA-256 differs from the value in [`validator/artefacts.lock.json`](../validator/artefacts.lock.json). `docker build` then copies the verified files into the validation image.

## What is used

| Artefact | Version | Source | SHA-256 | Licence position |
| --- | --- | --- | --- | --- |
| PINT AE Billing resources (Schematron `.sch`, compiled `.xslt`, code lists, examples) | PINT AE 1.0.4, PDK 1.4.4 | https://docs.peppol.eu/poac/ae/pint-ae/resources.zip (Last-Modified 7 September 2026) | `1e8b0bd595c672ac9d6fc886ddd0eb8027cb39a1d26bebdcb1ada37b7eee491f` | Copyright OpenPEPPOL AISBL. The BIS forbids redistribution without consent; the Schematron files carry no licence notice. Downloaded, not redistributed. |
| UBL 2.1 schemas (16 files under `xsd/maindoc` and `xsd/common`) | UBL 2.1 OS, 4 November 2013 | https://docs.oasis-open.org/ubl/os-UBL-2.1/ | one value per file in the lock file | Copyright OASIS Open, all rights reserved. Downloaded, not redistributed. |
| Saxon-HE | 12.10 | Maven Central `net.sf.saxon:Saxon-HE` | `b571af282f25d7301059f788b9a149aab8b5cdc14ef3d212dc5425d3dcbb9a97` | MPL-2.0 |
| xmlresolver and xmlresolver-data (Saxon dependency) | 5.3.3 | Maven Central `org.xmlresolver:xmlresolver` | in the lock file | Apache-2.0 |
| Base images | Temurin 25 JDK and JRE (Ubuntu Noble) | Docker Hub `eclipse-temurin`, pinned by digest in `validator/Dockerfile` | image digests | GPLv2 with Classpath Exception (OpenJDK) |

The code values in `src/codelists/generated.ts` are extracted from the Schematron tests by `npm run codelists:sync`. They are lists of codes from public standards (ISO 4217, ISO 3166, UN/ECE Recommendation 20, UNCL 4461, 5189 and 7161, EAS, ISO 6523 ICD) and the PINT AE code lists; the file header records the source archive and its checksum.

## Updating to a new release

1. Read the release notes at https://docs.peppol.eu/poac/ae/pint-ae/specialized-release-notes/.
2. Run `npm run artefacts:fetch`. It stops with a checksum mismatch that shows the expected and actual SHA-256.
3. Download the new archive, review the changes in the Schematron, and put the new SHA-256, version and Last-Modified date in `validator/artefacts.lock.json`.
4. Run `npm run codelists:sync`, `npm run validator:build` and `npm run test:conformance`. Fix the library or the corpus where rules changed, and record the change in `docs/decisions.md`.

The same steps apply to Saxon-HE: change the URL and SHA-256 in the lock file (Maven Central publishes a `.sha256` file next to each jar).

The resources URL has no version in it, so a new release can replace the archive without warning. The scheduled workflow `.github/workflows/artefacts.yml` runs `npm run artefacts:fetch -- --upstream` twice a week: it downloads every file again into a temporary folder and fails when one no longer matches the lock file. That failure is the signal to follow the steps above. Until then, CI keeps validating against the cached, pinned files.

## Observations about the published artefacts

Found while building and testing against PINT AE 1.0.4. Each one can be reproduced with the files in this repository: the corpus documents named below are validated by `npm run test:conformance`, which asserts the exact findings. None of them has been reported to OpenPeppol yet.

1. **Category N is spelled with a Greek letter in the code list.** `Aligned-TaxCategoryCodes.gc` lists the last code as `Ν` (U+039D, Greek capital Nu). The Schematron tests use the Latin `N`. This library uses the Latin letter, which the validator accepts.

2. **ibr-128-ae (emirate code) does not run on seller or buyer addresses.** In `PINT-jurisdiction-aligned-rules.xslt` the templates for `cac:AccountingSupplierParty/cac:Party/cac:PostalAddress` (ibr-143-ae, priority 1036) and `cac:AccountingCustomerParty/cac:Party/cac:PostalAddress` (ibr-144-ae, priority 1037) match those nodes before the `cac:PostalAddress` template of ibr-128-ae (priority 1031) in the same mode, so a seller subdivision such as "Dubai" is not reported. `corpus/gaps/seller-subdivision-not-an-emirate.xml` passes the published validator; the library rejects the equivalent input with ibr-128-ae.

3. **ibr-co-14 and ibr-124 do not run on credit notes.** Their context is `/ubl:Invoice/cac:TaxTotal | /cn:CreditNote/cac:Taxtotal`; the credit note branch has a lower-case `t` and matches nothing. `corpus/gaps/credit-note-total-vat-not-sum-of-breakdown.xml` (total VAT 18.40, breakdown 18.50) passes the published validator. The library always writes a total equal to its breakdown.

4. **One official example fails the UBL 2.1 schema.** `trn-creditnote/example/Volume-discount-credit-note.xml` places a line-level `cac:DiscrepancyResponse` before `cac:OrderLineReference`; the schema requires the opposite order (error `cvc-complex-type.2.4.a` at line 185). The other 29 published examples pass the XSD and both Schematron layers. The conformance suite checks all 30 so that a corrected example is noticed.

5. **Volume discount credit notes and ibr-055-ae.** The BIS says the preceding invoice reference is optional for reason VD. Checked with the validator in this repository: a 381 credit note whose only reason code is VD fails ibr-055-ae when it also has a billing reference. Because the rule compares the sequence of reason codes with `!=`, the same credit note passes once a second reason code is added. The published VD example has two reason codes and no billing reference. `corpus/observations/vd-credit-note-with-billing-reference.xml` fails with exactly ibr-055-ae, and `vd-credit-note-with-billing-reference-and-second-reason.xml` has no findings. See ADR-016.

6. **Currency of the line AED amounts in the Exports example.** The BIS text asks for BTAE-08 and BTAE-10 in AED; the Exports example states them in USD. See ADR-006.

7. **Two rules evaluate amounts in binary floating point.** ibr-147-ae and ibr-131-ae / ibr-146-ae apply arithmetic to untyped values, so XPath uses `xs:double`. At half-fil ties the result can differ from decimal rounding: for 1.05 × 36.90 = 38.745, `corpus/valid/allowances-and-charges.xml` shows that 38.74 is accepted, and `corpus/observations/line-amount-decimal-half-up-tie.xml` shows that 38.75 is rejected by ibr-147-ae (with ibr-co-10, because the lines then no longer add up to the total). See ADR-004.

8. **Compilation warnings.** Saxon-HE 12.10 reports warning SXWN9032 for the `u:slack` and `u:abn` functions in the compiled stylesheets (they use `xsl:value-of` where `xsl:sequence` is expected). The warnings do not change results; the validator suppresses warnings and prints only compilation errors.
