import { useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { demoAccounts, type DemoAccount } from './data/demo-tutors';
import { LoginScreen } from './screens/LoginScreen';
import { RegisterScreen } from './screens/RegisterScreen';
import { OffersScreen } from './screens/OffersScreen';
import { StyleSheet, Pressable, Text, View } from 'react-native';
import type { Application, Tutor } from '../shared/types';

type Screen = 'LOGIN' | 'REGISTER' | 'OFFERS';

export default function App() {
    const [accounts, setAccounts] = useState<DemoAccount[]>(demoAccounts);
    const [screen, setScreen] = useState<Screen>('LOGIN');
    const [tutor, setTutor] = useState<Tutor | null>(null);
    const [applications, setApplications] = useState<Application[]>([]);

    function handleRegistered(newTutor: Tutor, password: string) {
        setAccounts((prev) => [...prev, { ...newTutor, password }]);
        setTutor(newTutor);
        setScreen('OFFERS');
    }

    function handleLogin(loggedIn: Tutor) {
        setTutor(loggedIn);
        setScreen('OFFERS');
    }

    function handleLogout() {
        setTutor(null);
        setScreen('LOGIN');
    }

    function handleApply(offerId: string) {
        if(!tutor) return;
        setApplications((prev) => {
            const already = prev.some((a) => a.offerId === offerId && a.tutorId === tutor.id);
            if (already) return prev;
            return [
                ...prev,
                {
                    id: `demo-app-${Date.now()}`,
                    offerId,
                    tutorId: tutor.id,
                    status: 'APPLIED',
                    appliedAt: new Date().toISOString().slice(0, 10),
                },
            ];
        });
    }

    return (
        <SafeAreaProvider>
            <SafeAreaView style={styles.screen} edges={['top', 'bottom']}>
                <StatusBar style="dark" />

                <View style={styles.banner}>
                    <Text style={styles.bannerText}>DEMO · all accounts, agencies and offers are fictional</Text>
                </View>

                {screen === 'LOGIN' && (
                    <LoginScreen accounts={accounts} onLogin={handleLogin} onRegister={() => setScreen('REGISTER')} />
                )}

                {screen === 'REGISTER' && (
                    <RegisterScreen
                        existingUsernames={accounts.map((a) => a.username)}
                        onRegistered={handleRegistered}
                        onBack={() => setScreen('LOGIN')}
                    />
                )}

                {screen === 'OFFERS' && tutor && (
                    <>
                        <Pressable onPress={handleLogout} style={styles.logout}>
                            <Text style={styles.logoutText}>Sign out</Text>
                        </Pressable>
                        <OffersScreen tutor={tutor} />
                    </>
                )}
            </SafeAreaView>
        </SafeAreaProvider>
    );
}

const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: '#F4F7FB' },
    banner: { backgroundColor: '#FFE8A3', padding: 10, alignItems: 'center' },
    bannerText: { fontSize: 13, fontWeight: '600', color: '#5C4300' },
    logout: { alignSelf: 'flex-end', marginRight: 16, marginTop: 8 },
    logoutText: { color: '#2563EB', fontWeight: '600' },
});