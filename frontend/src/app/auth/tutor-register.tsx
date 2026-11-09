import { useState } from 'react';
import { useRouter } from 'expo-router';
import {
    ActivityIndicator,
    KeyboardAvoidingView,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    TextInput,
    View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors } from '../../theme/colors';
import {
    registerTutor,
    type RegisterTutorInput,
} from '@/features/auth/api/register';

export default function RegisterScreen() {
    const router = useRouter();

    const [form, setForm] = useState<RegisterTutorInput>({
        userName: '',
        fullName: '',
        email: '',
        phoneNumber: '',
        password: '',
        confirmPassword: '',
        gender: 'MALE',
        educationStatus: 'NONGRADUATE',
    });

    const [showPassword, setShowPassword] = useState(false);
    const [showConfirmPassword, setShowConfirmPassword] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);

    function updateField<K extends keyof RegisterTutorInput>(
        field: K,
        value: RegisterTutorInput[K]
    ) {
        setForm((previous) => ({
            ...previous,
            [field]: value,
        }));
    }

    async function handleRegister() {
        setError('');

        if (
            !form.userName.trim() ||
            !form.fullName.trim() ||
            !form.email.trim() ||
            !form.phoneNumber.trim() ||
            !form.password ||
            !form.confirmPassword
        ) {
            setError('Please complete all the fields.');
            return;
        }

        if (form.userName.trim().length < 3) {
            setError('Username must contain at least 3 characters.');
            return;
        }

        if (form.fullName.trim().length < 3) {
            setError('Please enter your full name.');
            return;
        }

        if (form.password.length < 8) {
            setError('Password must contain at least 8 characters.');
            return;
        }

        if (form.password !== form.confirmPassword) {
            setError('Your passwords do not match.');
            return;
        }

        setLoading(true);

        try {
            await registerTutor({
                ...form,
                userName: form.userName.trim(),
                fullName: form.fullName.trim(),
                email: form.email.trim().toLowerCase(),
                phoneNumber: form.phoneNumber.trim(),
            });

            setSuccess(true);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Unable to create your account. Please try again.');
        } finally {
            setLoading(false);
        }
    }

    if (success) {
        return (
            <View style={styles.container}>
                <View style={styles.successBackground} />
                <View style={styles.successContainer}>
                    <View style={styles.successBadge}>
                        <Text style={styles.successIcon}>✓</Text>
                    </View>

                    <Text style={styles.successTitle}>Registration Successful!</Text>

                    <Text style={styles.successSubtitle}>
                        Your account has been created successfully.
                        You can now continue to login using your new credentials.
                    </Text>

                    <Pressable
                        style={styles.button}
                        onPress={() => router.replace('/')}
                    >
                        <Text style={styles.buttonText}>Continue to Login</Text>
                    </Pressable>
                </View>
            </View>
        );
    }

    return (
        <SafeAreaView style={styles.safeArea}>
            <StatusBar style="dark" />
            <View style={styles.screenGlow} />
            <View style={styles.screenGlowBottom} />

            <KeyboardAvoidingView
                style={styles.flex}
                behavior={Platform.OS === 'ios' ? 'padding' : undefined}
            >
                <ScrollView
                    contentContainerStyle={styles.content}
                    keyboardShouldPersistTaps="handled"
                    showsVerticalScrollIndicator={false}
                >
                    <Pressable
                        style={styles.backButton}
                        onPress={() => router.back()}
                    >
                        <Text style={styles.backText}>← Back to sign in</Text>
                    </Pressable>

                    <View style={styles.brandRow}>
                        <View style={styles.logo}>
                            <Text style={styles.logoLetter}>NT</Text>
                        </View>
                        <View>
                            <Text style={styles.brandName}>Next Tutor</Text>
                            <Text style={styles.brandSubtext}>Trusted local teaching support</Text>
                        </View>
                    </View>

                    <View style={styles.intro}>
                        <Text style={styles.eyebrow}>JOIN OUR TUTOR COMMUNITY</Text>
                        <Text style={styles.title}>Create your account</Text>
                        <Text style={styles.subtitle}>
                            Start your journey as a tutor and connect with
                            students who need your knowledge.
                        </Text>
                    </View>

                    <View style={styles.card}>
                        <View style={styles.sectionHeaderRow}>
                            <Text style={styles.sectionNumber}>01</Text>
                            <Text style={styles.cardTitle}>Personal information</Text>
                        </View>
                        <Text style={styles.cardSubtitle}>
                            Tell us a little about yourself.
                        </Text>

                        <Text style={styles.label}>Full name</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="Enter your full name"
                            placeholderTextColor={colors.muted}
                            value={form.fullName}
                            onChangeText={(value) => updateField('fullName', value)}
                            autoCapitalize="words"
                            editable={!loading}
                        />

                        <Text style={styles.label}>Username</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="Choose a username"
                            placeholderTextColor={colors.muted}
                            value={form.userName}
                            onChangeText={(value) => updateField('userName', value)}
                            autoCapitalize="none"
                            autoCorrect={false}
                            editable={!loading}
                        />

                        <Text style={styles.label}>Email address</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="example@email.com"
                            placeholderTextColor={colors.muted}
                            value={form.email}
                            onChangeText={(value) => updateField('email', value)}
                            keyboardType="email-address"
                            autoCapitalize="none"
                            autoCorrect={false}
                            editable={!loading}
                        />

                        <Text style={styles.label}>Phone number</Text>
                        <TextInput
                            style={styles.input}
                            placeholder="09XXXXXXXX or +2519XXXXXXXX"
                            placeholderTextColor={colors.muted}
                            value={form.phoneNumber}
                            onChangeText={(value) => updateField('phoneNumber', value)}
                            keyboardType="phone-pad"
                            editable={!loading}
                        />

                        <Text style={styles.label}>Gender</Text>
                        <View style={styles.optionRow}>
                            <OptionButton
                                label="Male"
                                selected={form.gender === 'MALE'}
                                onPress={() => updateField('gender', 'MALE')}
                                disabled={loading}
                            />
                            <OptionButton
                                label="Female"
                                selected={form.gender === 'FEMALE'}
                                onPress={() => updateField('gender', 'FEMALE')}
                                disabled={loading}
                            />
                        </View>

                        <View style={styles.sectionDivider} />

                        <View style={styles.sectionHeaderRow}>
                            <Text style={styles.sectionNumber}>02</Text>
                            <Text style={styles.cardTitle}>Education background</Text>
                        </View>
                        <Text style={styles.cardSubtitle}>
                            Select your current education status.
                        </Text>

                        <OptionButton
                            label="Non-graduate"
                            description="Currently studying or not yet graduated"
                            selected={form.educationStatus === 'NONGRADUATE'}
                            onPress={() =>
                                updateField('educationStatus', 'NONGRADUATE')
                            }
                            disabled={loading}
                        />

                        <OptionButton
                            label="Graduate"
                            description="Completed your degree or diploma"
                            selected={form.educationStatus === 'GRADUATE'}
                            onPress={() =>
                                updateField('educationStatus', 'GRADUATE')
                            }
                            disabled={loading}
                        />

                        <View style={styles.sectionDivider} />

                        <View style={styles.sectionHeaderRow}>
                            <Text style={styles.sectionNumber}>03</Text>
                            <Text style={styles.cardTitle}>Secure your account</Text>
                        </View>
                        <Text style={styles.cardSubtitle}>
                            Create a password you haven&apos;t used elsewhere.
                        </Text>

                        <Text style={styles.label}>Password</Text>
                        <View style={styles.passwordContainer}>
                            <TextInput
                                style={styles.passwordInput}
                                placeholder="At least 8 characters"
                                placeholderTextColor={colors.muted}
                                value={form.password}
                                onChangeText={(value) => updateField('password', value)}
                                secureTextEntry={!showPassword}
                                autoCapitalize="none"
                                editable={!loading}
                            />
                            <Pressable
                                onPress={() => setShowPassword(!showPassword)}
                            >
                                <Text style={styles.textAction}>
                                    {showPassword ? 'Hide' : 'Show'}
                                </Text>
                            </Pressable>
                        </View>

                        <Text style={styles.label}>Confirm password</Text>
                        <View style={styles.passwordContainer}>
                            <TextInput
                                style={styles.passwordInput}
                                placeholder="Enter your password again"
                                placeholderTextColor={colors.muted}
                                value={form.confirmPassword}
                                onChangeText={(value) =>
                                    updateField('confirmPassword', value)
                                }
                                secureTextEntry={!showConfirmPassword}
                                autoCapitalize="none"
                                editable={!loading}
                            />
                            <Pressable
                                onPress={() =>
                                    setShowConfirmPassword(!showConfirmPassword)
                                }
                            >
                                <Text style={styles.textAction}>
                                    {showConfirmPassword ? 'Hide' : 'Show'}
                                </Text>
                            </Pressable>
                        </View>

                        {error ? (
                            <Text accessibilityRole="alert" style={styles.error}>
                                {error}
                            </Text>
                        ) : null}

                        <Pressable
                            style={({ pressed }) => [
                                styles.submitButton,
                                pressed && styles.pressed,
                                loading && styles.disabled,
                            ]}
                            onPress={handleRegister}
                            disabled={loading}
                        >
                            {loading ? (
                                <ActivityIndicator color={colors.surface} />
                            ) : (
                                <Text style={styles.submitButtonText}>
                                    Create account →
                                </Text>
                            )}
                        </Pressable>

                        <Text style={styles.terms}>
                            By creating an account, you agree to provide
                            accurate information during your tutor application.
                        </Text>
                    </View>

                    <Text style={styles.footer}>
                        Your knowledge can make a difference.
                    </Text>
                </ScrollView>
            </KeyboardAvoidingView>
        </SafeAreaView>
    );
}

type OptionButtonProps = {
    label: string;
    description?: string;
    selected: boolean;
    onPress: () => void;
    disabled?: boolean;
};

function OptionButton({
    label,
    description,
    selected,
    onPress,
    disabled,
}: OptionButtonProps) {
    return (
        <Pressable
            onPress={onPress}
            disabled={disabled}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            style={[
                styles.optionButton,
                selected && styles.optionSelected,
            ]}
        >
            <View style={styles.optionContent}>
                <Text style={[
                    styles.optionLabel,
                    selected && styles.optionLabelSelected,
                ]}>
                    {label}
                </Text>

                {description ? (
                    <Text style={styles.optionDescription}>{description}</Text>
                ) : null}
            </View>

            <View style={[styles.radio, selected && styles.radioSelected]}>
                {selected ? <View style={styles.radioDot} /> : null}
            </View>
        </Pressable>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    successBackground: {
        position: 'absolute',
        inset: 0,
        backgroundColor: '#FFF1EA',
        opacity: 0.9,
    },
    successContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 28,
        zIndex: 1,
    },
    successBadge: {
        width: 90,
        height: 90,
        borderRadius: 28,
        backgroundColor: '#EAF8F0',
        alignItems: 'center',
        justifyContent: 'center',
        marginBottom: 20,
        borderWidth: 1,
        borderColor: '#C8EEDB',
    },
    successIcon: {
        fontSize: 42,
        color: '#2E9D61',
        fontWeight: '800',
    },
    successTitle: {
        fontSize: 28,
        fontWeight: '800',
        color: colors.heading,
        textAlign: 'center',
        marginBottom: 12,
    },
    successSubtitle: {
        fontSize: 15,
        color: colors.text,
        textAlign: 'center',
        lineHeight: 23,
        marginBottom: 32,
    },
    button: {
        backgroundColor: colors.primary,
        paddingVertical: 16,
        paddingHorizontal: 28,
        borderRadius: 16,
        width: '100%',
        alignItems: 'center',
        shadowColor: '#B04A1E',
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.18,
        shadowRadius: 18,
        elevation: 4,
    },
    buttonText: {
        color: '#FFFFFF',
        fontSize: 16,
        fontWeight: '800',
    },
    safeArea: {
        flex: 1,
        backgroundColor: colors.background,
    },
    flex: {
        flex: 1,
    },
    screenGlow: {
        position: 'absolute',
        top: -120,
        left: -80,
        width: 260,
        height: 260,
        borderRadius: 130,
        backgroundColor: '#FDE3D3',
        opacity: 0.7,
    },
    screenGlowBottom: {
        position: 'absolute',
        bottom: -120,
        right: -80,
        width: 280,
        height: 280,
        borderRadius: 140,
        backgroundColor: '#F9D9C7',
        opacity: 0.75,
    },
    content: {
        flexGrow: 1,
        paddingHorizontal: 24,
        paddingTop: 16,
        paddingBottom: 30,
    },
    backButton: {
        alignSelf: 'flex-start',
        marginBottom: 20,
        paddingVertical: 6,
    },
    backText: {
        color: colors.primary,
        fontSize: 14,
        fontWeight: '700',
    },
    brandRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        marginBottom: 20,
    },
    logo: {
        width: 52,
        height: 52,
        borderRadius: 18,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
        shadowColor: '#C8582D',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.24,
        shadowRadius: 16,
        elevation: 4,
    },
    logoLetter: {
        color: colors.surface,
        fontSize: 18,
        fontWeight: '800',
    },
    brandName: {
        color: colors.primary,
        fontSize: 22,
        fontWeight: '800',
    },
    brandSubtext: {
        color: colors.muted,
        fontSize: 11,
        fontWeight: '700',
        letterSpacing: 0.8,
        textTransform: 'uppercase',
    },
    intro: {
        marginBottom: 18,
    },
    eyebrow: {
        color: colors.primary,
        fontSize: 11,
        fontWeight: '800',
        letterSpacing: 1.5,
        marginBottom: 10,
    },
    title: {
        fontSize: 34,
        lineHeight: 42,
        fontWeight: '800',
        color: colors.heading,
        letterSpacing: -1,
    },
    subtitle: {
        fontSize: 15,
        color: colors.text,
        textAlign: 'left',
        lineHeight: 23,
        marginTop: 10,
    },
    card: {
        backgroundColor: colors.surface,
        borderRadius: 28,
        padding: 22,
        borderWidth: 1,
        borderColor: '#FFF0E8',
        shadowColor: '#C77B5F',
        shadowOffset: { width: 0, height: 12 },
        shadowOpacity: 0.08,
        shadowRadius: 20,
        elevation: 2,
    },
    sectionHeaderRow: {
        flexDirection: 'row',
        alignItems: 'center',
        marginBottom: 4,
    },
    sectionNumber: {
        fontSize: 12,
        fontWeight: '800',
        color: colors.primary,
        letterSpacing: 1.6,
        marginRight: 10,
    },
    cardTitle: {
        color: colors.heading,
        fontSize: 19,
        fontWeight: '800',
    },
    cardSubtitle: {
        color: colors.muted,
        fontSize: 13,
        lineHeight: 19,
        marginTop: 6,
        marginBottom: 23,
    },
    label: {
        color: colors.heading,
        fontSize: 13,
        fontWeight: '700',
        marginBottom: 9,
    },
    input: {
        minHeight: 54,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 16,
        backgroundColor: '#FFFCFA',
        paddingHorizontal: 14,
        color: colors.heading,
        fontSize: 14,
        marginBottom: 20,
    },
    optionRow: {
        flexDirection: 'row',
        gap: 10,
        marginBottom: 10,
    },
    optionButton: {
        minHeight: 58,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderWidth: 1.5,
        borderColor: colors.border,
        borderRadius: 16,
        paddingHorizontal: 14,
        paddingVertical: 12,
        marginBottom: 10,
        flex: 1,
        backgroundColor: '#FFFCFA',
    },
    optionSelected: {
        borderColor: colors.primary,
        backgroundColor: colors.softOrange,
        shadowColor: '#E1A785',
        shadowOffset: { width: 0, height: 6 },
        shadowOpacity: 0.15,
        shadowRadius: 12,
        elevation: 2,
    },
    optionContent: {
        flex: 1,
        paddingRight: 10,
    },
    optionLabel: {
        color: colors.text,
        fontSize: 14,
        fontWeight: '700',
    },
    optionLabelSelected: {
        color: colors.primaryDark,
    },
    optionDescription: {
        color: colors.muted,
        fontSize: 11,
        lineHeight: 16,
        marginTop: 4,
    },
    radio: {
        width: 20,
        height: 20,
        borderRadius: 10,
        borderWidth: 1.5,
        borderColor: colors.muted,
        alignItems: 'center',
        justifyContent: 'center',
    },
    radioSelected: {
        borderColor: colors.primary,
    },
    radioDot: {
        width: 10,
        height: 10,
        borderRadius: 5,
        backgroundColor: colors.primary,
    },
    sectionDivider: {
        height: 1,
        backgroundColor: colors.border,
        marginVertical: 24,
    },
    passwordContainer: {
        minHeight: 54,
        flexDirection: 'row',
        alignItems: 'center',
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: 16,
        backgroundColor: '#FFFCFA',
        paddingHorizontal: 14,
        marginBottom: 20,
    },
    passwordInput: {
        flex: 1,
        color: colors.heading,
        fontSize: 14,
        paddingVertical: 12,
    },
    textAction: {
        color: colors.primary,
        fontSize: 13,
        fontWeight: '700',
        paddingLeft: 10,
    },
    error: {
        color: colors.error,
        fontSize: 13,
        lineHeight: 19,
        marginBottom: 15,
    },
    submitButton: {
        minHeight: 56,
        borderRadius: 16,
        backgroundColor: colors.primary,
        alignItems: 'center',
        justifyContent: 'center',
        marginTop: 8,
        shadowColor: '#A73D16',
        shadowOffset: { width: 0, height: 10 },
        shadowOpacity: 0.18,
        shadowRadius: 18,
        elevation: 4,
    },
    submitButtonText: {
        color: colors.surface,
        fontSize: 15,
        fontWeight: '800',
    },
    pressed: {
        opacity: 0.85,
    },
    disabled: {
        opacity: 0.65,
    },
    terms: {
        color: colors.muted,
        fontSize: 11,
        lineHeight: 17,
        textAlign: 'center',
        marginTop: 18,
    },
    footer: {
        color: colors.muted,
        fontSize: 12,
        textAlign: 'center',
        marginTop: 23,
    },
});
