import { Loader2 } from 'lucide-react';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <Loader2 role="status" aria-label={label} className="h-4 w-4 animate-spin text-muted" />;
}
