import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { docDbTopic, docTopic } from '@/sync/realtimeChannel';

/**
 * Drift guard for the realtime topics.
 *
 * The client subscribes to topic names it builds itself; the database
 * broadcasts to topic names its triggers build, and RLS resolves membership
 * from topic names its helper functions parse. Nothing connects the three but
 * this test. A mismatch is silent in production — peers simply stop seeing
 * each other's committed marks — so it is made loud here, against the latest
 * migration that (re)defines each function.
 *
 * Resolved from the project root, like applyMigrationsInSync.test.ts.
 */
const MIGRATIONS_DIR = 'supabase/migrations';

const latestDefinition = (fn: string): string => {
    const pattern = new RegExp(`create or replace function public\\.${fn}\\b[\\s\\S]*?\\$\\$;`, 'i');
    const files = readdirSync(resolve(process.cwd(), MIGRATIONS_DIR))
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .reverse();
    for (const name of files) {
        const match = readFileSync(resolve(process.cwd(), MIGRATIONS_DIR, name), 'utf8').match(pattern);
        if (match) {
            return match[0];
        }
    }
    throw new Error(`no migration defines public.${fn}`);
};

describe('realtime topics stay in sync with the database', () => {
    it('builds the topics the policies resolve', () => {
        expect(docTopic('x')).toBe('doc:x');
        expect(docDbTopic('x')).toBe('doc-db:x');
        expect(latestDefinition('topic_document_role')).toContain("'doc:%'");
        expect(latestDefinition('db_topic_document_role')).toContain("'doc-db:%'");
    });

    it.each(['broadcast_annotation_changes', 'broadcast_document_changes', 'broadcast_score_analysis_changes'])(
        '%s broadcasts on the receive-only doc-db topic',
        (fn) => {
            const body = latestDefinition(fn);
            expect(body).toContain("'doc-db:' ||");
            // Never on the topic every editor may send on.
            expect(body).not.toMatch(/'doc:'\s*\|\|/);
        },
    );
});
