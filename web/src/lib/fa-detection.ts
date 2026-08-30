// Financial Advisor domain detection
// Instead of AI, we use simple domain matching

export const FA_EMAIL_DOMAINS = [
  // Major Wirehouses
  'edwardjones.com',
  'ml.com',
  'merrilllynch.com',
  'morganstanley.com',
  'morganstanleypwm.com',
  'ubs.com',
  'wellsfargoadvisors.com',
  'wellsfargo.com',

  // Independent Broker-Dealers
  'lpl.com',
  'lplfinancial.com',
  'raymondjames.com',
  'rjf.com',
  'ameriprise.com',
  'commonwealth.com',
  'cetera.com',
  'ceteraadvisors.com',

  // Custodians / Large RIAs
  'schwab.com',
  'fidelity.com',
  'fidelityinvestments.com',
  'troweprice.com',
  'vanguard.com',
  'blackrock.com',

  // Insurance / Wealth Management
  'northwesternmutual.com',
  'nm.com',
  'principal.com',
  'massmutual.com',
  'prudential.com',
  'newyorklife.com',
  'transamerica.com',
  'lincolnfinancial.com',

  // Regional Firms
  'stifel.com',
  'janney.com',
  'bairdwealth.com',
  'rwbaird.com',
  'hilliard.com',
  'dadavidson.com',
]

export function isLikelyFinancialAdvisor(emails: string[]): boolean {
  return emails.some((email) =>
    FA_EMAIL_DOMAINS.some((domain) =>
      email.toLowerCase().endsWith(`@${domain}`)
    )
  )
}

export function detectFADomain(email: string): string | null {
  const lowerEmail = email.toLowerCase()
  for (const domain of FA_EMAIL_DOMAINS) {
    if (lowerEmail.endsWith(`@${domain}`)) {
      return domain
    }
  }
  return null
}

// Auto-detect FA contacts from a batch
export function detectFinancialAdvisors(
  contacts: { id: string; emails: { email: string }[] }[]
): { id: string; matchedDomain: string }[] {
  const matches: { id: string; matchedDomain: string }[] = []

  for (const contact of contacts) {
    for (const emailObj of contact.emails || []) {
      const domain = detectFADomain(emailObj.email)
      if (domain) {
        matches.push({ id: contact.id, matchedDomain: domain })
        break // Only match once per contact
      }
    }
  }

  return matches
}
