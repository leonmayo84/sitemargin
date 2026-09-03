// supabase/functions/_shared/tiers.ts
//
// Single source of truth for what SiteMargin's paid tiers cost and how
// they're billed — imported by both create-checkout (to build the PayFast
// request) and payfast-itn (to decide how a completed payment should be
// recorded). Keeping this in one place is what stops the price shown to
// customers from silently drifting away from what PayFast actually charges
// — which is exactly what happened before this file existed: Contractor
// was advertised everywhere as R199/month but this backend was quietly
// charging R249/month.
//
// These amounts must match what's advertised in both frontend copies of
// the pricing page — src/App.jsx (the gate screen's checkoutPrice cards)
// and sitemargin-site/pricing.html. If you change a price, update all
// three places, not just this one.

export type Tier = {
  amount: string;      // PayFast wants a plain string, 2 decimal places
  label: string;       // shown on PayFast's hosted checkout page and receipts
  recurring: boolean;  // true = monthly subscription, false = once-off charge
};

export const TIERS: Record<string, Tier> = {
  contractor: { amount: "199.00", label: "SiteMargin — Contractor plan", recurring: true },
  firm: { amount: "399.00", label: "SiteMargin — Company plan", recurring: true },
  // Once-off: R899 for permanent access to a single project, not a monthly
  // charge — see the `recurring: false` handling in both functions below.
  homeowner: { amount: "899.00", label: "SiteMargin — Home Owner plan", recurring: false },
};
