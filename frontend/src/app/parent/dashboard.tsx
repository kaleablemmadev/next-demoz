import { useState } from 'react';
import { useRouter } from 'expo-router';
import { clearSession } from '@/features/auth/services/session';
import {
    SafeAreaView,
    ScrollView,
    StatusBar,
    StyleSheet,
    Text,
    Pressable,
    View,
} from 'react-native';
import { colors } from '@/theme/colors';

export default function ParentDashboard() {
    const router = useRouter();
    const [loggingOut, setLoggingOut] = useState(false);

    const handleLogout = async () => {
        setLoggingOut(true);
        try {
            await clearSession();
            router.replace('/');
        } catch (error) {
            console.error('Logout failed', error);
        } finally {
            setLoggingOut(false);
        }
    };

    return (
        <SafeAreaView style={styles.safeArea}>
            <StatusBar barStyle="dark-content" />
            <ScrollView contentContainerStyle={styles.content}>
                <View style={styles.header}>
                    <View>
                        <Text style={styles.brand}>Next Tutor</Text>
                        <Text style={styles.greeting}>Parent Portal</Text>
                    </View>

                    <Pressable
                        style={styles.logoutButton}
                        onPress={handleLogout}
                        disabled={loggingOut}
                    >
                        <Text style={styles.logoutText}>Logout</Text>
                    </Pressable>
                </View>

                <View style={styles.welcomeCard}>
                    <Text style={styles.welcomeEyebrow}>DASHBOARD</Text>
                    <Text style={styles.welcomeTitle}>Manage your children&apos;s learning.</Text>
                    <Text style={styles.welcomeText}>
                        Post tutoring offers and connect with verified local tutors near you.
                    </Text>
                </View>
            </ScrollView>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    safeArea: { flex: 1, backgroundColor: colors.background },
    content: { padding: 20, paddingBottom: 32 },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: 24,
    },
    brand: { color: colors.primary, fontSize: 22, fontWeight: '800' },
    greeting: { color: colors.text, fontSize: 13, marginTop: 3 },
    logoutButton: {
        backgroundColor: colors.softOrange,
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: '#F6D8C6',
        shadowColor: '#C86E47',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.12,
        shadowRadius: 12,
    },
    logoutText: { color: '#C44C3B', fontWeight: '700', fontSize: 13 },
    welcomeCard: {
        backgroundColor: colors.primary,
        borderRadius: 28,
        padding: 22,
        marginBottom: 28,
        shadowColor: '#B6532A',
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 0.18,
        shadowRadius: 18,
    },
    welcomeEyebrow: { color: '#FFE0CF', fontSize: 10, fontWeight: '800', letterSpacing: 1.5 },
    welcomeTitle: { color: '#FFFFFF', fontSize: 22, fontWeight: '800', marginTop: 10 },
    welcomeText: { color: '#FFF0E8', fontSize: 14, marginTop: 8, lineHeight: 20 },
});