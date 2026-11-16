import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const configDirectory = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(configDirectory, '.env.test');
const envResult = dotenv.config({ path: envPath, override: true });

if (envResult.error) {
    throw new Error(`Could not load bot/.env.test: ${envResult.error.message}`);
}

const databaseUrl = envResult.parsed?.DATABASE_URL;
const expectedHost = envResult.parsed?.TEST_BRANCH_HOST?.trim();

if (!expectedHost) {
    throw new Error('TEST_BRANCH_HOST must be set to the expected test database hostname.');
}

if (!databaseUrl) {
    throw new Error('DATABASE_URL must be set in bot/.env.test.');
}

let databaseHost: string;
try {
    databaseHost = new URL(databaseUrl).hostname;
} catch {
    throw new Error('DATABASE_URL in bot/.env.test must be a valid PostgreSQL URL.');
}

if (databaseHost.toLowerCase() !== expectedHost.toLowerCase()) {
    throw new Error(
        `Refusing to run tests: DATABASE_URL host "${databaseHost}" does not match TEST_BRANCH_HOST "${expectedHost}".`
    );
}

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/**/*.test.ts'],
    },
});
