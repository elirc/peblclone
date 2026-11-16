import { formatMoney, type ContractTerms } from '@meridian/shared';

/**
 * The contract template: terms in, plain-text agreement out.
 *
 * It is a PURE function on purpose. The service snapshots the terms once, at
 * generation time, and stores both the terms and the rendered text; nothing
 * here reads the database or the clock, so the same terms always produce the
 * same document and the template can be unit-tested without Postgres.
 *
 * Two variants, because the legal relationship differs:
 *  - employees get an employment agreement with Meridian as Employer of Record
 *    (probation, paid leave, notice);
 *  - contractors get a services agreement that says, explicitly, that they are
 *    NOT employees (no leave, no payroll deductions, they handle their own tax).
 */
export interface RenderedContract {
  title: string;
  body: string;
}

const EMPLOYER = 'Meridian Global Employment ("Meridian")';

function payDescription(terms: ContractTerms): string {
  const amount = formatMoney(terms.salaryMinor, terms.currency);
  return terms.payBasis === 'annual' ? `${amount} per year` : `${amount} per month`;
}

function days(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}

/** Number the sections in order, so adding or removing one never leaves a gap. */
function numberSections(sections: readonly { heading: string; text: string }[]): string {
  return sections
    .map((s, i) => `${i + 1}. ${s.heading.toUpperCase()}\n${s.text}`)
    .join('\n\n');
}

function employeeAgreement(terms: ContractTerms): RenderedContract {
  const probation =
    terms.probationDays > 0
      ? `The first ${days(terms.probationDays)} of employment are a probationary period.`
      : 'There is no probationary period.';
  const sections = [
    {
      heading: 'Parties',
      text:
        `This Employment Agreement is made between ${EMPLOYER}, acting as Employer of Record ` +
        `in ${terms.countryName}, and ${terms.workerName} (the "Employee").`,
    },
    {
      heading: 'Position and start date',
      text:
        `The Employee is employed as ${terms.jobTitle}. Employment begins on ${terms.startDate} ` +
        `and continues until terminated in accordance with this Agreement.`,
    },
    {
      heading: 'Compensation',
      text:
        `The Employee will be paid a gross salary of ${payDescription(terms)}, payable monthly ` +
        `in ${terms.currency}, less statutory deductions required in ${terms.countryName}.`,
    },
    { heading: 'Probation', text: probation },
    {
      heading: 'Annual leave',
      text: `The Employee is entitled to ${days(terms.annualLeaveDays)} of paid annual leave per calendar year, prorated for partial years.`,
    },
    {
      heading: 'Notice period',
      text: `Either party may terminate this Agreement by giving ${days(terms.noticePeriodDays)} written notice.`,
    },
    {
      heading: 'Governing law',
      text: `This Agreement is governed by the laws of ${terms.countryName} (${terms.countryCode}).`,
    },
    {
      heading: 'Entire agreement',
      text: 'This Agreement is the entire agreement between the parties about its subject matter.',
    },
  ];
  return {
    title: `Employment Agreement — ${terms.workerName}`,
    body: `EMPLOYMENT AGREEMENT\n\n${numberSections(sections)}\n`,
  };
}

function contractorAgreement(terms: ContractTerms): RenderedContract {
  const sections = [
    {
      heading: 'Parties',
      text:
        `This Independent Contractor Agreement is made between ${EMPLOYER} and ` +
        `${terms.workerName} (the "Contractor"), based in ${terms.countryName}.`,
    },
    {
      heading: 'Services',
      text: `The Contractor will provide services as ${terms.jobTitle}, beginning on ${terms.startDate}.`,
    },
    {
      heading: 'Fees',
      text:
        `Meridian will pay the Contractor a fee of ${payDescription(terms)}, invoiced monthly ` +
        `in ${terms.currency}. No taxes or social contributions are withheld.`,
    },
    {
      heading: 'Independent status',
      text:
        'The Contractor is an independent business, not an employee. The Contractor is ' +
        'responsible for their own taxes, insurance and equipment, and is not entitled to ' +
        'paid leave or employee benefits.',
    },
    {
      heading: 'Term and termination',
      text: `Either party may end this Agreement by giving ${days(terms.noticePeriodDays)} written notice.`,
    },
    {
      heading: 'Intellectual property',
      text: 'Work product created for the client under this Agreement is assigned to the client on payment.',
    },
    {
      heading: 'Governing law',
      text: `This Agreement is governed by the laws of ${terms.countryName} (${terms.countryCode}).`,
    },
  ];
  return {
    title: `Independent Contractor Agreement — ${terms.workerName}`,
    body: `INDEPENDENT CONTRACTOR AGREEMENT\n\n${numberSections(sections)}\n`,
  };
}

export function renderContract(terms: ContractTerms): RenderedContract {
  return terms.workerType === 'employee' ? employeeAgreement(terms) : contractorAgreement(terms);
}
