import { setTimeout as wait } from "node:timers/promises";
import * as runExclusive from "run-exclusive";

const MAX_REQUEST_JITTER_MS = 10_000;

function getRequestJitterMs(): number {
    return Math.floor(Math.random() * (MAX_REQUEST_JITTER_MS + 1));
}

export const runExternalRequest = runExclusive.build(
    async <Result>(request: () => Promise<Result>): Promise<Result> => {
        const jitterMs = getRequestJitterMs();
        console.log(`    Waiting ${(jitterMs / 1_000).toFixed(1)} seconds before external request...`);
        await wait(jitterMs);
        return request();
    }
);
