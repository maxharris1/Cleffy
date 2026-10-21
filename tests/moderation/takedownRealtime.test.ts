import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { docTopic } from '@/sync/realtimeChannel';
import { MEMBERSHIP_EVENT, parseMembershipChange } from '@/sync/wire';

/**
 * A takedown must reach viewers who already have the score open
 * (20261020150000_content_moderation.sql, "Realtime"). Realtime authorizes a
 * channel at join, so document_role() alone leaves a connected collaborator
 * receiving the score's committed changes. tests/sql/content_moderation.sql
 * proves the behaviour against a database (checks 03-04, 46, 70-80); this
 * keeps it from being undone by a later migration that redefines a fan-out
 * function without the takedown check — CI runs no SQL, so without this the
 * first anyone would hear of it is a leak.
 */
const MIGRATIONS_DIR = 'supabase/migrations';

const migrations = (): string[] =>
    readdirSync(resolve(process.cwd(), MIGRATIONS_DIR))
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .reverse();

const read = (name: string): string => readFileSync(resolve(process.cwd(), MIGRATIONS_DIR, name), 'utf8');

/** The newest `create or replace function public.<fn>`, body included. */
const latestDefinition = (fn: string): string => {
    const pattern = new RegExp(`create or replace function public\\.${fn}\\b[\\s\\S]*?\\$\\$;`, 'i');
    for (const name of migrations()) {
        const match = read(name).match(pattern);
        if (match) {
            return match[0];
        }
    }
    throw new Error(`no migration defines public.${fn}`);
};

/** The newest create or alter of the documents SELECT policy. */
const latestDocumentsSelect = (): string => {
    const pattern = /(?:create|alter) policy documents_select on public\.documents[\s\S]*?\);/i;
    for (const name of migrations()) {
        const match = read(name).match(pattern);
        if (match) {
            return match[0];
        }
    }
    throw new Error('no migration defines documents_select');
};

describe('a takedown cuts off viewers already connected', () => {
    it.each(['broadcast_annotation_changes', 'broadcast_document_changes', 'broadcast_score_analysis_changes'])(
        '%s sends nothing for a taken-down score',
        (fn) => {
            const body = latestDefinition(fn);
            const check = body.indexOf('public.content_taken_down (new.');
            const send = Math.max(body.indexOf('realtime.broadcast_changes'), body.indexOf('realtime.send'));
            expect(check, `${fn} has no takedown check`).toBeGreaterThan(-1);
            // Checked before anything goes out, and the check returns.
            expect(check).toBeLessThan(send);
            expect(body.slice(check, send)).toMatch(/return null;/);
        },
    );

    it('tells every member who lost access to re-check, on the topic and event the app listens to', () => {
        expect(latestDefinition('apply_content_takedown')).toMatch(
            /perform public\.content_takedown_notify_viewers \(p_document, p_action\)/,
        );
        const notify = latestDefinition('content_takedown_notify_viewers');
        // Everyone but the owner for restrict; everyone for remove.
        expect(notify).toMatch(/p_action = 'remove' or dm\.role <> 'owner'/);
        expect(notify).toContain(`'${MEMBERSHIP_EVENT}', -- event`);
        expect(notify).toContain(`'${docTopic('')}' || p_document::text`);
        // The payload is one the client accepts (role null: re-check, you were removed).
        expect(notify).toMatch(/'role', null/);
        expect(
            parseMembershipChange({ table: 'document_members', document_id: 'd', user_id: 'u', role: null }),
        ).not.toBeNull();
    });

    it("stops a removed score's owner reading its row, so the re-check finds nothing", () => {
        expect(latestDocumentsSelect()).toMatch(
            /owner_id = \(select auth\.uid\(\)\) and not public\.owned_document_removed \(id\)/,
        );
        expect(latestDefinition('owned_document_removed')).toMatch(/d\.owner_id = \(select auth\.uid\(\)\)/);
    });
});
