const UPDATE_INTERVAL_MS = 1_000;

type ActiveStatus = {
    clear: () => void;
    render: () => void;
};

let activeStatus: ActiveStatus | undefined;

function pluralize(value: number, unit: string): string {
    return `${value} ${unit}${value === 1 ? "" : "s"}`;
}

export function formatElapsedDuration(milliseconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    const parts: string[] = [];

    if (hours > 0) parts.push(pluralize(hours, "hour"));
    if (minutes > 0) parts.push(pluralize(minutes, "minute"));
    if (seconds > 0 || parts.length === 0) parts.push(pluralize(seconds, "second"));

    return parts.join(" ");
}

export function writeProgressWarning(message: string): void {
    if (activeStatus === undefined) {
        console.warn(message);
        return;
    }

    activeStatus.clear();
    process.stdout.write(`${message}\n`);
    activeStatus.render();
}

export async function withElapsedStatus<Result>(
    label: string,
    operation: () => Promise<Result>
): Promise<Result> {
    const startedAt = Date.now();
    const canUpdateInPlace = process.stdout.isTTY === true;
    const render = (message: string): void => {
        process.stdout.write(`\r\u001b[2K${message}`);
    };
    const renderElapsed = (): void => {
        render(`${label} ${formatElapsedDuration(Date.now() - startedAt)}.`);
    };
    const previousStatus = activeStatus;
    const currentStatus = { clear: () => render(""), render: renderElapsed };

    if (canUpdateInPlace) {
        activeStatus = currentStatus;
        renderElapsed();
    } else {
        console.log(label);
    }

    const interval = canUpdateInPlace ? setInterval(renderElapsed, UPDATE_INTERVAL_MS) : undefined;
    interval?.unref();

    try {
        const result = await operation();
        const elapsed = formatElapsedDuration(Date.now() - startedAt);

        if (canUpdateInPlace) {
            render(`${label} done in ${elapsed}.`);
            process.stdout.write("\n");
        } else {
            console.log(`${label} done in ${elapsed}.`);
        }

        return result;
    } catch (error) {
        const elapsed = formatElapsedDuration(Date.now() - startedAt);

        if (canUpdateInPlace) {
            render(`${label} failed after ${elapsed}.`);
            process.stdout.write("\n");
        } else {
            console.error(`${label} failed after ${elapsed}.`);
        }

        throw error;
    } finally {
        if (interval !== undefined) clearInterval(interval);
        if (activeStatus === currentStatus) activeStatus = previousStatus;
    }
}
