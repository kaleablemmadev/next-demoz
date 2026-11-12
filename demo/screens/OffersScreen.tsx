import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { mockAgencies, mockOffers } from '../data/mock-offers';
import { Chip } from '../components/Chip';
import { areasNear } from '../../shared/rules/nearby-areas';
import type { Offer, Tutor } from '../../shared/types';

type Tab = 'ALL' | 'FOR_YOU';
const ALL_AREAS = 'ALL';

const agencyName = (agencyId: string) =>
    mockAgencies.find((a) => a.id === agencyId)?.name ?? 'Unknown agency';

function OfferCard({ offer }: { offer: Offer }) {
    const isOpen = offer.status === 'OPEN';

    return (
        <View style={styles.card}>
            <View style={styles.row}>
                <Text style={styles.title}>{offer.title}</Text>
                <Text style={[styles.badge, isOpen ? styles.open : styles.closed]}>{isOpen ? 'Open' : 'Closed'}</Text>
            </View>
            <Text style={styles.agency}>{agencyName(offer.agencyId)}</Text>
            <Text style={styles.detail}>{offer.subject} · {offer.gradeLevel} · {offer.subCity}</Text>
            <Text style={styles.detail}>{offer.sessionsPerWeek} sessions a week</Text>
            <Text style={styles.salary}>{offer.monthlySalaryEtb.toLocaleString()} ETB / month</Text>
        </View>
    );
}

export function OffersScreen({ tutor }: { tutor: Tutor }) {
    const [tab, setTab] = useState<Tab>('ALL');
    const [subCity, setSubCity] = useState<string>(tutor.subCity);

    const subCities = useMemo(() => Array.from(new Set(mockOffers.map((o) => o.subCity))), []);

    // "All offers" starts at the tutor's own sub-city and can be changed.
    const allOffers = useMemo(
        () => mockOffers.filter((o) => subCity === ALL_AREAS || o.subCity === subCity),
        [subCity]
    );

    // Matches the tutor's home area, nearby areas, subjects and grades. Sorted by salary only.
    const offersForYou = useMemo(() => {
        const areas = areasNear(tutor.subCity);
        return mockOffers
            .filter(
                (o) =>
                    areas.includes(o.subCity) &&
                    tutor.subjects.includes(o.subject) &&
                    tutor.grades.includes(o.gradeLevel)
            )
            .sort((a, b) => b.monthlySalaryEtb - a.monthlySalaryEtb);
    }, [tutor]);

    const shown = tab === 'ALL' ? allOffers : offersForYou;

    return (
        <View style={styles.screen}>
            <Text style={styles.greeting}>Hello, {tutor.fullName}</Text>

            <View style={styles.tabs}>
                <Pressable onPress={() => setTab('ALL')} style={[styles.tab, tab === 'ALL' && styles.tabActive]}>
                    <Text style={[styles.tabText, tab === 'ALL' && styles.tabTextActive]}>All offers</Text>
                </Pressable>
                <Pressable onPress={() => setTab('FOR_YOU')} style={[styles.tab, tab === 'FOR_YOU' && styles.tabActive]}>
                    <Text style={[styles.tabText, tab === 'FOR_YOU' && styles.tabTextActive]}>Offers for you</Text>
                </Pressable>
            </View>

            {tab === 'ALL' ? (
                <View style={styles.filterRow}>
                    <Chip label="All areas" active={subCity === ALL_AREAS} onPress={() => setSubCity(ALL_AREAS)} />
                    {subCities.map((c) => (
                        <Chip key={c} label={c} active={subCity === c} onPress={() => setSubCity(c)} />
                    ))}
                </View>
            ) : (
                <Text style={styles.note}>
                    Matches your subjects, grades and nearby areas. Highest salary first.
                </Text>
            )}

            <FlatList
                data={shown}
                keyExtractor={(offer) => offer.id}
                renderItem={({ item }) => <OfferCard offer={item} />}
                contentContainerStyle={styles.list}
                ListEmptyComponent={<Text style={styles.empty}>No offers match this filter.</Text>}
            />
        </View>
    );
}

const styles = StyleSheet.create({
    screen: { flex: 1 },
    greeting: { fontSize: 22, fontWeight: '700', color: '#0F2A4A', marginHorizontal: 16, marginTop: 8 },
    tabs: { flexDirection: 'row', margin: 16, backgroundColor: '#E5ECF6', borderRadius: 12, padding: 4 },
    tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: 10 },
    tabActive: { backgroundColor: '#FFFFFF' },
    tabText: { fontSize: 14, fontWeight: '600', color: '#4B5563' },
    tabTextActive: { color: '#0F2A4A' },
    filterRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, marginBottom: 8 },
    note: { fontSize: 13, color: '#4B5563', paddingHorizontal: 16, marginBottom: 8 },
    list: { paddingHorizontal: 16, paddingBottom: 24, gap: 12 },
    card: { backgroundColor: '#FFFFFF', borderRadius: 14, padding: 16, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2 },
    row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    title: { fontSize: 17, fontWeight: '700', color: '#0F2A4A', flex: 1, marginRight: 8 },
    badge: { fontSize: 12, fontWeight: '700', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, overflow: 'hidden' },
    open: { backgroundColor: '#D7F5E3', color: '#106B3A' },
    closed: { backgroundColor: '#E5E7EB', color: '#4B5563' },
    agency: { fontSize: 14, color: '#2563EB', marginTop: 6, fontWeight: '600' },
    detail: { fontSize: 14, color: '#4B5563', marginTop: 4 },
    salary: { fontSize: 16, fontWeight: '700', color: '#0F2A4A', marginTop: 10 },
    empty: { textAlign: 'center', color: '#6B7280', marginTop: 32 },
});