import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    connect: vi.fn(),
    query: vi.fn(),
    release: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
    pool: { connect: mocks.connect },
}));

import { recordAuditEvent, withTransaction } from '../src/audit.js';

beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({ rows: [] });
    mocks.connect.mockResolvedValue({
        query: mocks.query,
        release: mocks.release,
    });
});

describe('account audit transactions', () => {
    it('writes a minimal audit event and commits it in the same transaction', async () => {
        await withTransaction(async (client) => {
            await recordAuditEvent(client, {
                actorRef: '11111111-1111-4111-8111-111111111111',
                actorType: 'PARENT',
                action: 'REQUEST_CREATED',
                entityType: 'PARENT_REQUEST',
                entityRef: '22222222-2222-4222-8222-222222222222',
                metadata: { source: 'TELEGRAM' },
            });
        });

        expect(mocks.query).toHaveBeenNthCalledWith(1, 'BEGIN');
        expect(mocks.query).toHaveBeenNthCalledWith(
            2,
            expect.stringContaining('INSERT INTO "AuditEvent"'),
            [
                '11111111-1111-4111-8111-111111111111',
                'PARENT',
                'REQUEST_CREATED',
                'PARENT_REQUEST',
                '22222222-2222-4222-8222-222222222222',
                '{"source":"TELEGRAM"}',
            ],
        );
        expect(mocks.query).toHaveBeenLastCalledWith('COMMIT');
        expect(mocks.release).toHaveBeenCalledOnce();
    });

    it('rolls back and releases the connection when a transaction fails', async () => {
        await expect(
            withTransaction(async () => {
                throw new Error('expected failure');
            }),
        ).rejects.toThrow('expected failure');

        expect(mocks.query).toHaveBeenNthCalledWith(1, 'BEGIN');
        expect(mocks.query).toHaveBeenLastCalledWith('ROLLBACK');
        expect(mocks.release).toHaveBeenCalledOnce();
    });
});
