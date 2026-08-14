import * as runExclusive from "run-exclusive";

export const runExternalRequest = runExclusive.build(
    async <Result>(request: () => Promise<Result>): Promise<Result> => request()
);
