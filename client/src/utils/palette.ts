import { rank, type FuzzyMatch } from './fuzzy';

export type PaletteGroup = 'Ask AI' | 'Actions' | 'Pages' | 'Repositories' | 'Tasks';

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

export interface PaletteResult {
  item: PaletteItem;
  match: FuzzyMatch;
}

const GROUP_ORDER: PaletteGroup[] = ['Ask AI', 'Actions', 'Pages', 'Repositories', 'Tasks'];

/** Filters and ranks palette entries; with an empty query, returns actions and pages first in a stable order. */
export function searchPalette(items: PaletteItem[], query: string): PaletteResult[] {
  const ranked = rank(items, query, (i) => `${i.label} ${i.keywords ?? ''} ${i.hint ?? ''}`, 40);
  if (query.trim()) return ranked.map(({ item, match }) => ({ item, match }));
  return ranked
    .map(({ item, match }) => ({ item, match }))
    .sort((a, b) => GROUP_ORDER.indexOf(a.item.group) - GROUP_ORDER.indexOf(b.item.group));
}
