/**
 * Constant-time comparison for shared secrets presented in request headers.
 *
 * NO imports, like stripeSignature.ts: Deno loads it with the `.ts` extension
 * and vitest without, so the comparison the functions run is the one the tests
 * run.
 *
 * Why not `a === b`: string equality returns at the first differing character,
 * so how long a rejection takes says how much of a guess was right, and a
 * secret can be recovered a character at a time from response timings.
 *
 * Why hash first: stripeSignature.ts can compare its hex digests directly
 * because both sides are a known, fixed length. A configured secret is not, and
 * an early exit on length would leak it. Comparing SHA-256 digests makes both
 * operands 32 bytes whatever was sent, so the loop below always does the same
 * work, and a caller learns nothing about the secret's length or content.
 */

const encoder = new TextEncoder();

const digest = async (value: string): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));

/**
 * True only when both values are non-empty and identical. An unset secret
 * never matches — not even an empty header — so a missing environment
 * variable fails closed instead of opening the endpoint.
 */
export const secretsEqual = async (
    received: string | null | undefined,
    expected: string | null | undefined,
): Promise<boolean> => {
    if (!received || !expected) {
        return false;
    }
    const [a, b] = await Promise.all([digest(received), digest(expected)]);
    let diff = 0;
    for (let i = 0; i < a.length; i += 1) {
        diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
    }
    return diff === 0;
};
