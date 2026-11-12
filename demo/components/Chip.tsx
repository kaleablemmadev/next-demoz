import {Pressable, StyleSheet, Text} from "react-native";

export function Chip({label, active, onPress}: {label: string; active: boolean; onPress: () => void}) {
    return (
        <Pressable onPress={onPress} style={[styles.chip, active && styles.active]}>
            <Text style={[styles.text, active && styles.activeText]}>{label}</Text>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#D1D5DB' },
    active: { backgroundColor: '#0F2A4A', borderColor: '#0F2A4A' },
    text: { fontSize: 13, color: '#374151' },
    activeText: { color: '#FFFFFF', fontWeight: '600' },
});