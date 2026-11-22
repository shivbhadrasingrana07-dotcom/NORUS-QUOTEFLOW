export function formatMoney(
  amount: number | null | undefined,
  currency: string = 'INR',
  decimals = 2
): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) {
    return '—';
  }
  const locale = currency === 'INR' ? 'en-IN' : 'en-US';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
}

export function formatPct(val: number | null | undefined, showPlus = true): string {
  if (val === null || val === undefined || Number.isNaN(val)) return '—';
  const sign = showPlus && val > 0 ? '+' : '';
  return `${sign}${val.toFixed(1)}%`;
}

export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function rfqStatusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'collecting':
      return 'Collecting Quotes';
    case 'in_review':
      return 'In Review';
    case 'pending_approval':
      return 'Pending Approval';
    case 'approved':
      return 'Approved';
    case 'awarded':
      return 'Awarded';
    case 'closed':
      return 'Closed';
    default:
      return status;
  }
}
