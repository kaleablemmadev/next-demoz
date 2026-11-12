// Pure rule: which Addis Ababa sub-cities count as "nearby" for matching.
// Each pair is a pair of neighbouring sub-cities. Check this list with local knowledge before launch.

const NEIGHBOUR_PAIRS: [string, string][] = [
    ['Bole', 'Yeka'],
    ['Bole', 'Kirkos'],
    ['Bole', 'Nifas Silk-Lafto'],
    ['Kirkos', 'Arada'],
    ['Kirkos', 'Lideta'],
    ['Kirkos', 'Nifas Silk-Lafto'],
    ['Yeka', 'Nifas Silk-Lafto'],
    ['Arada', 'Lideta'],
    ['Arada', 'Addis Ketema'],
    ['Lideta', 'Addis Ketema'],
    ['Addis Ketema', 'Kolfe Keranio'],
    ['Kolfe Keranio', 'Gulele'],
    ['Kolfe Keranio', 'Akaki Kaliti'],
];

const neighbours = new Map<string, Set<string>>();

for (const [a, b] of NEIGHBOUR_PAIRS) {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    if (!neighbours.has(b)) neighbours.set(b, new Set());
    neighbours.get(a)!.add(b);
    neighbours.get(b)!.add(a);
}

// The home sub-city plus its neighbours.
export function areasNear(subCity: string): string[] {
    return [subCity, ...Array.from(neighbours.get(subCity) ?? [])];
}

// Every sub-city that appears in the neighbour list, for registration options.
export const KNOWN_SUB_CITIES: string[] = Array.from(neighbours.keys()).sort();