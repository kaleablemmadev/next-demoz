import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Chip } from '../components/Chip';
import { KNOWN_SUB_CITIES } from '../../shared/rules/nearby-areas';
import type { Tutor } from '../../shared/types';

const SUBJECTS = ['Mathematics', 'Physics', 'English', 'Chemistry'];
const GRADES = ['Grade 4', 'Grade 8', 'Grade 11'];

type Props = {
    existingUsernames: string[];
    onRegistered: (tutor: Tutor, password: string) => void;
    onBack: () => void;
};

export function RegisterScreen({ existingUsernames, onRegistered, onBack }: Props) {
    const [fullName, setFullName] = useState('');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [subCity, setSubCity] = useState<string | null>(null);
    const [subjects, setSubjects] = useState<string[]>([]);
    const [grades, setGrades] = useState<string[]>([]);
    const [error, setError] = useState<string | null>(null);

    const toggle = (list: string[], value: string, set: (v: string[]) => void) =>
        set(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

    function submit() {
        const cleanUsername = username.trim().toLowerCase();

        if (fullName.trim().length < 3) return setError('Enter your full name.');
        if (cleanUsername.length < 3) return setError('Username must be at least 3 characters.');
        if (password.length < 8) return setError('Password must be at least 8 characters.');
        if (!subCity) return setError('Choose your sub-city.');
        if (subjects.length === 0) return setError('Choose at least one subject.');
        if (grades.length === 0) return setError('Choose at least one grade.');

        // Same message whether the username is new or taken, as in the real app's plan.
        if (existingUsernames.includes(cleanUsername)) {
            return setError('We could not create an account with these details. If you already have one, sign in instead.');
        }

        onRegistered(
            {
                id: `demo-new-${Date.now()}`,
                fullName: fullName.trim(),
                username: cleanUsername,
                subCity,
                subjects,
                grades,
            },
            password
        );
    }

    return (
        <ScrollView contentContainerStyle={styles.screen}>
            <Pressable onPress={onBack}>
                <Text style={styles.link}>← Back to sign in</Text>
            </Pressable>

            <Text style={styles.heading}>Create a tutor account</Text>
            <Text style={styles.note}>Demo only · details are kept in memory and reset when the app reloads.</Text>

            <TextInput style={styles.input} placeholder="Full name" value={fullName} onChangeText={setFullName} />
            <TextInput style={styles.input} placeholder="Username" autoCapitalize="none" value={username} onChangeText={setUsername} />
            <TextInput style={styles.input} placeholder="Password (8+ characters)" secureTextEntry value={password} onChangeText={setPassword} />

            <Text style={styles.label}>Your sub-city</Text>
            <View style={styles.chips}>
                {KNOWN_SUB_CITIES.map((c) => (
                    <Chip key={c} label={c} active={subCity === c} onPress={() => setSubCity(c)} />
                ))}
            </View>

            <Text style={styles.label}>Subjects you teach</Text>
            <View style={styles.chips}>
                {SUBJECTS.map((s) => (
                    <Chip key={s} label={s} active={subjects.includes(s)} onPress={() => toggle(subjects, s, setSubjects)} />
                ))}
            </View>

            <Text style={styles.label}>Grades you teach</Text>
            <View style={styles.chips}>
                {GRADES.map((g) => (
                    <Chip key={g} label={g} active={grades.includes(g)} onPress={() => toggle(grades, g, setGrades)} />
                ))}
            </View>

            {error ? <Text style={styles.error}>{error}</Text> : null}

            <Pressable style={styles.button} onPress={submit}>
                <Text style={styles.buttonText}>Create account</Text>
            </Pressable>
        </ScrollView>
    );
}

const styles = StyleSheet.create({
    screen: { padding: 24, gap: 12, backgroundColor: '#F4F7FB' },
    heading: { fontSize: 24, fontWeight: '700', color: '#0F2A4A' },
    note: { fontSize: 13, color: '#5C4300', backgroundColor: '#FFE8A3', padding: 8, borderRadius: 8 },
    label: { fontSize: 14, fontWeight: '700', color: '#0F2A4A', marginTop: 8 },
    input: { backgroundColor: '#FFFFFF', borderRadius: 10, borderWidth: 1, borderColor: '#D1D5DB', padding: 12, fontSize: 15 },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    error: { color: '#B91C1C', fontSize: 14 },
    button: { backgroundColor: '#0F2A4A', borderRadius: 10, padding: 14, alignItems: 'center', marginTop: 8 },
    buttonText: { color: '#FFFFFF', fontWeight: '700', fontSize: 16 },
    link: { color: '#2563EB', fontWeight: '600' },
});