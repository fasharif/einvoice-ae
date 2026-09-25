/**
 * Demo parties for the test corpus and examples.
 *
 * Every identifier here is made up. The TRNs and TINs follow the formats the rules check
 * (TRN: 15 digits, starting with 1, ending with 03; TIN: 10 digits starting with 1) but
 * use runs of zeros so they are easy to recognise as placeholders. Every demo document
 * carries the note below.
 */
import type { Buyer, PaymentMeans, Seller } from '../src/index.js';

export const DEMO_NOTE = 'DEMO - not a tax invoice';

export const demoSeller: Seller = {
  name: 'Demo Irrigation Supplies LLC',
  tradingName: 'Demo Irrigation',
  endpoint: { id: '1000000001' },
  trn: '100000000100003',
  legalRegistration: { id: 'DEMO-TL-000001', type: 'TL', authority: 'Demo Licensing Authority' },
  legalForm: 'Limited Liability Company',
  address: {
    street: '1 Demo Street',
    additionalStreet: 'Unit 1',
    city: 'Dubai',
    postalZone: '00000',
    subdivision: 'DXB',
    country: 'AE',
  },
  contact: { name: 'Demo Accounts', telephone: '+971 4 000 0000', email: 'accounts@demo.invalid' },
};

export const demoBuyer: Buyer = {
  name: 'Demo Landscaping Contractors LLC',
  tradingName: 'Demo Landscaping',
  endpoint: { id: '1000000002' },
  trn: '100000000200003',
  legalRegistration: { id: 'DEMO-TL-000002', type: 'TL', authority: 'Demo Licensing Authority' },
  address: { street: '2 Demo Road', city: 'Abu Dhabi', subdivision: 'AUH', country: 'AE' },
  contact: { name: 'Demo Purchasing', email: 'purchasing@demo.invalid' },
};

/** A buyer in Oman that is not registered in Peppol: uses the predefined export endpoint. */
export const demoExportBuyer: Buyer = {
  name: 'Demo Gulf Farms SAOC',
  endpoint: { id: '9900000099' },
  address: { street: '3 Demo Way', city: 'Muscat', subdivision: 'Muscat Governorate', country: 'OM' },
};

export const demoCreditTransfer: PaymentMeans = {
  code: '30',
  name: 'Credit transfer',
  account: { id: 'AE000000000000000000001', name: 'Demo Irrigation Supplies LLC', financialInstitutionId: 'DEMOAEAD' },
};
