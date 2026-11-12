// services/auth.service.ts

import { hashPassword, comparePasswords } from '../utils/security.js';
import { loginSchema, registerSchema } from '../schemas/auth.schema.js';
import { prisma } from '../prisma.js';
import { signAccessToken } from '../utils/jwt.js';
import { Role } from '../constants/constantEnums.js';
import { Prisma } from '../generated/prisma/client.js';
import { createRefreshToken } from './refresh-token.service.js';

type RegistrationErrorCode =
    | 'VALIDATION_ERROR'
    | 'ACCOUNT_CONFLICT'
    | 'AUTHENTICATION_FAILED';

const DUMMY_HASH = await hashPassword("dummy-password-not-used");

export class RegistrationError extends Error {
    constructor(
        public readonly code: RegistrationErrorCode,
        message: string,
        public readonly details?: unknown
    ) {
        super(message);
        this.name = 'RegistrationError';
    }
}

export const registerTutor = async (userData: unknown) => {
    const result = registerSchema.safeParse(userData);

    if (!result.success) {
        throw new RegistrationError(
            'VALIDATION_ERROR',
            'Invalid registration data',
            result.error.issues
        );
    }

    const input = result.data;

    try {
        const hashedPassword = await hashPassword(input.password);

        const tutor = await prisma.user.create({
            data: {
                fullName: input.fullName,
                username: input.userName,
                email: input.email,
                phoneNumber: input.phoneNumber,
                passwordHash: hashedPassword,
                role: Role.TUTOR,
                emailVerified: false,
                gender: input.gender,

                tutorApplications: {
                    create: {
                        educationStatus: input.educationStatus
                    },
                },
            },

            select: {
                id: true,
                fullName: true,
                username: true,
                email: true,
                phoneNumber: true,
                role: true,
                emailVerified: true,
                gender: true,
            },
        });

        return tutor;
    } catch (error) {
        if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            error.code === 'P2002'
        ) {
            throw new RegistrationError(
                'ACCOUNT_CONFLICT',
                'We could not create an account with these details. If you already have one, sign in instead.'
            );
        }

        throw error;
    }
};

export const loginTutor = async (userData: unknown, expectedRole: string = Role.TUTOR) => {
    const result = loginSchema.safeParse(userData);

    if (!result.success) {
        throw new RegistrationError(
            'VALIDATION_ERROR',
            'Invalid login data',
            result.error.issues
        );
    }

    const { identifier, password } = result.data;

    const user = await prisma.user.findFirst({
        where: {
            OR: [
                { username: identifier },
                { email: identifier },
                {phoneNumber: identifier}
            ]
        }
    })

    const passwordMatches = user ? await comparePasswords(password, user.passwordHash) : await comparePasswords(password, DUMMY_HASH);

    if (!passwordMatches || !user || user.role !== expectedRole) {
        throw new RegistrationError('AUTHENTICATION_FAILED', 'Invalid username or password');
    }

    const accessToken = signAccessToken({
        sub: user.id,
        role: user.role
    });

    const refreshToken = await createRefreshToken(user.id);

    return {
        accessToken,
        refreshToken,
        user: {
            id: user.id,
            username: user.username,
            email: user.email,
            phoneNumber: user.phoneNumber,
            fullName: user.fullName,
            role: user.role,
            emailVerified: user.emailVerified,
        }
    };
}