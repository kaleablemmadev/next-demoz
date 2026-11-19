export type SubCityId =
    | 'Addis Ketema'
    | 'Akaki Kaliti'
    | 'Arada'
    | 'Bole'
    | 'Gulele'
    | 'Kirkos'
    | 'Kolfe Keranio'
    | 'Ledeta' // kept in aliases below; canonical spelling below is 'Lideta'
    | 'Lemi Kura'
    | 'Lideta'
    | 'Nifas Silk-Lafto'
    | 'Yeka';

export type CanonicalSubCity = Exclude<SubCityId, 'Ledeta'>;
export type SubCityZone = 'inner' | 'outer';

export const SUB_CITY_ZONE: Record<CanonicalSubCity, SubCityZone> = {
    'Addis Ketema': 'inner',
    'Arada': 'inner',
    'Lideta': 'inner',
    'Kirkos': 'inner',
    'Gulele': 'outer',
    'Yeka': 'outer',
    'Lemi Kura': 'outer',
    'Bole': 'outer',
    'Nifas Silk-Lafto': 'outer',
    'Akaki Kaliti': 'outer',
    'Kolfe Keranio': 'outer',
};

const ALIAS_TO_CANONICAL: Record<string, CanonicalSubCity> = {
    'addis ketema': 'Addis Ketema',
    'akaki kaliti': 'Akaki Kaliti',
    'akaky kaliti': 'Akaki Kaliti',
    'akaki kality': 'Akaki Kaliti',
    'arada': 'Arada',
    'bole': 'Bole',
    'gulele': 'Gulele',
    'gullele': 'Gulele',
    'kirkos': 'Kirkos',
    'kolfe keranio': 'Kolfe Keranio',
    'kolfe keraniyo': 'Kolfe Keranio',
    'kolfe keraneo': 'Kolfe Keranio',
    'lemi kura': 'Lemi Kura',
    'lemikura': 'Lemi Kura',
    'lideta': 'Lideta',
    'ledeta': 'Lideta',
    'nifas silk-lafto': 'Nifas Silk-Lafto',
    'nifas silk lafto': 'Nifas Silk-Lafto',
    'nefas silk-lafto': 'Nifas Silk-Lafto',
    'nefas silk lafto': 'Nifas Silk-Lafto',
    'yeka': 'Yeka',
};

export function normalizeSubCity(input: string): CanonicalSubCity | null {
    const key = input.trim().toLowerCase().replace(/\s+/g, ' ');
    return ALIAS_TO_CANONICAL[key] ?? null;
}

// Undirected pairs of directly bordering sub-cities across all 11 sub-cities.
const NEIGHBOUR_PAIRS: ReadonlyArray<readonly [CanonicalSubCity, CanonicalSubCity]> = [
    // Inner core connections
    ['Addis Ketema', 'Arada'],
    ['Addis Ketema', 'Lideta'],
    ['Arada', 'Lideta'],
    ['Arada', 'Kirkos'],
    ['Lideta', 'Kirkos'],

    // North & East (Gulele, Yeka, Lemi Kura, Bole)
    ['Gulele', 'Addis Ketema'],
    ['Gulele', 'Arada'],
    ['Gulele', 'Yeka'],
    ['Yeka', 'Arada'],
    ['Yeka', 'Kirkos'],
    ['Yeka', 'Bole'],
    ['Yeka', 'Lemi Kura'],
    ['Lemi Kura', 'Bole'],

    // South & West (Bole, Nifas Silk-Lafto, Akaki Kaliti, Kolfe Keranio)
    ['Bole', 'Kirkos'],
    ['Bole', 'Nifas Silk-Lafto'],
    ['Bole', 'Akaki Kaliti'],
    ['Nifas Silk-Lafto', 'Kirkos'],
    ['Nifas Silk-Lafto', 'Lideta'],
    ['Nifas Silk-Lafto', 'Kolfe Keranio'],
    ['Nifas Silk-Lafto', 'Akaki Kaliti'],
    ['Kolfe Keranio', 'Gulele'],
    ['Kolfe Keranio', 'Addis Ketema'],
    ['Kolfe Keranio', 'Lideta'],
];

const adjacency = new Map<CanonicalSubCity, Set<CanonicalSubCity>>();

for (const subCity of Object.keys(SUB_CITY_ZONE) as CanonicalSubCity[]) {
    adjacency.set(subCity, new Set());
}

for (const [a, b] of NEIGHBOUR_PAIRS) {
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
}

export const KNOWN_SUB_CITIES: CanonicalSubCity[] = (
    Object.keys(SUB_CITY_ZONE) as CanonicalSubCity[]
).sort();

export function getDirectNeighbours(subCity: string): CanonicalSubCity[] {
    const canonical = normalizeSubCity(subCity);
    if (!canonical) return [];
    return Array.from(adjacency.get(canonical) ?? []);
}

export interface NearbyOptions {
    /** 1 = direct border neighbours; 2 = includes neighbours-of-neighbours */
    maxHops?: 1 | 2;
    includeSelf?: boolean;
}

/**
 * Returns sub-cities within `maxHops` borders of `subCity`.
 * Returns `[]` if `subCity` is unrecognized so callers can distinguish
 * invalid input from valid results.
 */
export function areasNear(
    subCity: string,
    options: NearbyOptions = {},
): string[] {
    const canonical = normalizeSubCity(subCity);
    if (!canonical) return [];

    const { maxHops = 1, includeSelf = true } = options;
    const visited = new Set<CanonicalSubCity>([canonical]);
    let frontier = new Set<CanonicalSubCity>([canonical]);

    for (let hop = 1; hop <= maxHops; hop++) {
        const nextFrontier = new Set<CanonicalSubCity>();
        for (const current of frontier) {
            for (const next of adjacency.get(current) ?? []) {
                if (!visited.has(next)) {
                    visited.add(next);
                    nextFrontier.add(next);
                }
            }
        }
        frontier = nextFrontier;
    }

    if (!includeSelf) {
        visited.delete(canonical);
    }

    return Array.from(visited);
}
