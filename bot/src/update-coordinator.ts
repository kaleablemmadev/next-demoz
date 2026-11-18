/**
 * Coordinates Telegram updates by user within one bot process.
 *
 * - Messages from the same user are processed in arrival order.
 * - A callback arriving while that user already has work in progress is dropped
 *   with an acknowledgement. Replaying a second button against an already
 *   changing screen is more dangerous than asking the user to tap again.
 * - Different users are never blocked by one another.
 *
 * This is intentionally a process-local guard. It does not replace database
 * constraints/transactions and does not coordinate multiple bot replicas.
 */
export class UserUpdateCoordinator {
    private readonly pendingByUser = new Map<number, Promise<void>>();

    async run<T>(
        userId: number,
        isCallback: boolean,
        onBusy: () => Promise<unknown> | unknown,
        task: () => Promise<T>,
    ): Promise<{ status: 'processed'; value: T } | { status: 'busy' }> {
        const previous = this.pendingByUser.get(userId);

        if (previous && isCallback) {
            await onBusy();
            return { status: 'busy' };
        }

        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });

        // Publish the lock before yielding so a simultaneous webhook request sees it.
        this.pendingByUser.set(userId, current);

        if (previous) {
            await previous.catch(() => undefined);
        }

        try {
            return { status: 'processed', value: await task() };
        } finally {
            release();
            if (this.pendingByUser.get(userId) === current) {
                this.pendingByUser.delete(userId);
            }
        }
    }

    get activeUserCount(): number {
        return this.pendingByUser.size;
    }
}
