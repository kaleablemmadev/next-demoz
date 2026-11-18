import { describe, expect, it } from 'vitest';
import { UserUpdateCoordinator } from '../src/update-coordinator.js';

function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

describe('UserUpdateCoordinator', () => {
    it('drops a different callback while the first callback is still running', async () => {
        const coordinator = new UserUpdateCoordinator();
        const started = deferred();
        const finish = deferred();
        let firstRuns = 0;
        let secondRuns = 0;
        let busyAcknowledgements = 0;

        const first = coordinator.run(101, true, () => undefined, async () => {
            firstRuns += 1;
            started.resolve();
            await finish.promise;
        });
        await started.promise;

        const second = await coordinator.run(101, true, () => {
            busyAcknowledgements += 1;
        }, async () => {
            secondRuns += 1;
        });

        expect(second).toEqual({ status: 'busy' });
        expect(firstRuns).toBe(1);
        expect(secondRuns).toBe(0);
        expect(busyAcknowledgements).toBe(1);

        finish.resolve();
        await first;
        expect(coordinator.activeUserCount).toBe(0);
    });

    it('serializes messages from the same user in arrival order', async () => {
        const coordinator = new UserUpdateCoordinator();
        const started = deferred();
        const finish = deferred();
        const order: string[] = [];

        const first = coordinator.run(202, false, () => undefined, async () => {
            order.push('first:start');
            started.resolve();
            await finish.promise;
            order.push('first:end');
        });
        await started.promise;

        const second = coordinator.run(202, false, () => undefined, async () => {
            order.push('second');
        });

        await Promise.resolve();
        expect(order).toEqual(['first:start']);

        finish.resolve();
        await Promise.all([first, second]);
        expect(order).toEqual(['first:start', 'first:end', 'second']);
        expect(coordinator.activeUserCount).toBe(0);
    });

    it('allows different users to execute concurrently', async () => {
        const coordinator = new UserUpdateCoordinator();
        const firstStarted = deferred();
        const secondStarted = deferred();
        const finish = deferred();

        const first = coordinator.run(301, false, () => undefined, async () => {
            firstStarted.resolve();
            await finish.promise;
        });
        const second = coordinator.run(302, false, () => undefined, async () => {
            secondStarted.resolve();
            await finish.promise;
        });

        await Promise.all([firstStarted.promise, secondStarted.promise]);
        expect(coordinator.activeUserCount).toBe(2);

        finish.resolve();
        await Promise.all([first, second]);
        expect(coordinator.activeUserCount).toBe(0);
    });

    it('releases the user lock when a handler throws', async () => {
        const coordinator = new UserUpdateCoordinator();

        await expect(
            coordinator.run(404, false, () => undefined, async () => {
                throw new Error('test failure');
            }),
        ).rejects.toThrow('test failure');

        const retry = await coordinator.run(404, true, () => undefined, async () => 'retried');
        expect(retry).toEqual({ status: 'processed', value: 'retried' });
        expect(coordinator.activeUserCount).toBe(0);
    });

    it('drops callbacks while a queued message is waiting too', async () => {
        const coordinator = new UserUpdateCoordinator();
        const firstStarted = deferred();
        const finish = deferred();

        const first = coordinator.run(505, false, () => undefined, async () => {
            firstStarted.resolve();
            await finish.promise;
        });
        await firstStarted.promise;

        const queuedMessage = coordinator.run(505, false, () => undefined, async () => undefined);
        let callbackRan = false;
        const callback = await coordinator.run(505, true, () => undefined, async () => {
            callbackRan = true;
        });

        expect(callback).toEqual({ status: 'busy' });
        expect(callbackRan).toBe(false);

        finish.resolve();
        await Promise.all([first, queuedMessage]);
        expect(coordinator.activeUserCount).toBe(0);
    });
});
