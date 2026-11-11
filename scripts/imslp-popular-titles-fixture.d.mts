export const FIXTURE_PATH: string;
export function fixtureEntries(
    titles: readonly string[],
    response: {
        query?: {
            normalized?: Array<{ from: string; to: string }>;
            redirects?: Array<{ from: string; to: string }>;
            pages?: Record<string, { title: string; missing?: string; pageid?: number }>;
        };
    },
): Record<string, { exists: boolean; resolvedTo: string | null }>;
