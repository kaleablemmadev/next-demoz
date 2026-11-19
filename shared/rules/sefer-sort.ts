// Pure sorting rule for offers. Sefers never decide matching; they only order the results.

export type SeferInfo = {
    id: string;
    subCity: string;
    nearbyIds: string[]; // sefers that are close to this one
};

// Higher is better.
export const RANK = {
    SAME_SEFER: 3,
    NEARBY_SEFER: 2,
    SAME_SUB_CITY: 1,
    OTHER: 0,
} as const;

// Sefers that are not approved yet count as unknown, so only the sub-city is used.
export function seferRank(args: {
    tutorSefer: SeferInfo | null;
    offerSefer: SeferInfo | null;
    tutorSubCity: string;
    offerSubCity: string;
}): number {
    const { tutorSefer, offerSefer, tutorSubCity, offerSubCity } = args;

    if (tutorSefer && offerSefer) {
        if (tutorSefer.id === offerSefer.id) return RANK.SAME_SEFER;
        if (tutorSefer.nearbyIds.includes(offerSefer.id)) return RANK.NEARBY_SEFER;
    }

    return tutorSubCity === offerSubCity ? RANK.SAME_SUB_CITY : RANK.OTHER;
}

// Orders offers best first: sefer rank, then newest. Salary and other factors can be added here later.
export function sortOffers<T extends { rank: number; postedAt: Date }>(offers: T[]): T[] {
    return [...offers].sort((a, b) => {
        if (b.rank !== a.rank) return b.rank - a.rank;
        return b.postedAt.getTime() - a.postedAt.getTime();
    });
}
