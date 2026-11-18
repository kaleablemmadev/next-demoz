import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: ['test/update-coordinator.test.ts', 'test/subjects.test.ts'],
        testTimeout: 5000,
    },
});
