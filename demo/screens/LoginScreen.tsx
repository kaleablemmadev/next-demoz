import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { DemoAccount } from '../data/demo-tutors';
import type { Tutor } from '../../shared/types';

type Props = {
    accounts: DemoAccount[];
    onLogin: (tutor: Tutor) => void;
    onRegister: () => void;
};

export function LoginScreen({ accounts, onLogin, onRegister }: Props) {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [error, setError] = useState<string | null>(null);

    function submit() {
        const account = accounts.find((a) => a.username === username.trim().toLowerCase());

        // Same message for an unknown username and a wrong password, as in the real backend.
        if (!account || account.password !== password) {
            setError('Invalid username or password');
            return;
        }

        const { password: _password, ...tutor } = account;
        onLogin(tutor);
    }

    return (
        <View style={styles.screen}>
            <Text style={styles.heading}>Sign in</Text>

            <TextInput
                style={styles.input}
                placeholder="Username"
                autoCapitalize="none"
                value={username}
                onChangeText={setUsername}
            />
            <TextInput
                style={styles.input}
                placeholder="Password"
                secureTextEntry
                value={password}
                onChangeText={setPassword}
            />

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable style={styles.button} onPress={submit}>
                <Text style={styles.buttonText}>Sign in</Text>
            </Pressable>

            <Pressable onPress={onRegister}>
                <Text style={styles.link}>New tutor? Create an account</Text>
            </Pressable>

            <View style={styles.hint}>
                <Text style={styles.hintTitle}>Demo accounts (fictional)</Text>
                <Text style={styles.hintText}>
                    {accounts.map((a) => a.username).join(', ')} · password: demo1234
                </Text>
            </View>
        </View>
    );
}

const styles = StyleSheet.create({
    screen: { flex: 1, padding: 24, justifyContent: 'center', gap: 12, backgroundColor: '#F4F7FB' },
    heading: { fontSize: 26, fontWeight: '700', color: '#0F2A4A', marginBottom: 8 },
    input: { backgroundColor: '#FFFFFF', borderRadius: 10, borderWidth: 1, borderColor: '#D1D5DB', padding: 12, fontSize: 15 },
    error: { color: '#B91C1C', fontSize: 14 },
    button: { backgroundColor: '#0F2A4A', borderRadius: 10, padding: 14, alignItems: 'center' },
    buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
    link: { color: '#2563EB', textAlign: 'center', fontWeight: '600', marginTop: 4 },
    hint: { marginTop: 24, padding: 12, borderRadius: 10, backgroundColor: '#FFE8A3' },
    hintTitle: { fontWeight: '700', color: '#5C4300' },
    hintText: { color: '#5C4300', marginTop: 4 },
});