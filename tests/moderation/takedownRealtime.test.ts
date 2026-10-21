import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MEMBERSHIP_EVENT, TOPIC_ROTATED_EVENT, parseMembershipChange, parseTopicRotated } from '@/sync/wire';

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
        '%s sends to the current generation only, and nothing for a removed score',
        (fn) => {
            const body = latestDefinition(fn);
            const check = body.indexOf('public.content_removed (new.');
            const send = Math.max(body.indexOf('realtime.broadcast_changes'), body.indexOf('realtime.send'));
            expect(check, `${fn} has no removal check`).toBeGreaterThan(-1);
            // Checked before anything goes out, and the check returns.
            expect(check).toBeLessThan(send);
            expect(body.slice(check, send)).toMatch(/return null;/);
            // A restricted score's changes go to its rotated topic, which only
            // its owner may join, never to the plain one a shut-out member
            // may still sit on.
            expect(body).toMatch(/public\.document_db_topic \(new\.(document_id|id)\)/);
            expect(body).not.toMatch(/'doc-db:'\s*\|\|/);
        },
    );

    it('tells every member who lost access to re-check, on the topic and event the app listens to, then moves the score', () => {
        expect(latestDefinition('apply_content_takedown')).toMatch(
            /perform public\.content_takedown_notify_viewers \(p_document, p_action\)/,
        );
        const notify = latestDefinition('content_takedown_notify_viewers');
        // Everyone but the owner for restrict; everyone for remove.
        expect(notify).toMatch(/p_action = 'remove' or dm\.role <> 'owner'/);
        expect(notify).toContain(`'${MEMBERSHIP_EVENT}', -- event`);
        // On the topic those members are on now, read before the rotation.
        expect(notify).toMatch(/v_topic text := public\.document_live_topic \(p_document\)/);
        expect(notify.indexOf('v_topic, -- topic')).toBeLessThan(
            notify.indexOf('perform public.rotate_document_realtime (p_document)'),
        );
        // The payload is one the client accepts (role null: re-check, you were removed).
        expect(notify).toMatch(/'role', null/);
        expect(
            parseMembershipChange({ table: 'document_members', document_id: 'd', user_id: 'u', role: null }),
        ).not.toBeNull();
    });

    it('rotates the topics and tells both old ones, with the event the app follows', () => {
        const rotate = latestDefinition('rotate_document_realtime');
        expect(rotate).toMatch(/v_old_live text := public\.document_live_topic \(p_document\)/);
        expect(rotate).toMatch(/v_old_db text := public\.document_db_topic \(p_document\)/);
        expect(rotate.match(new RegExp(`'${TOPIC_ROTATED_EVENT}', -- event`, 'g'))).toHaveLength(2);
        // The payload the client checks.
        expect(rotate).toMatch(/jsonb_build_object\('document_id', p_document\)/);
        expect(parseTopicRotated({ id: 'x', document_id: 'd' })).toEqual({ document_id: 'd' });
    });

    it('admits a join on the current generation only, for a member document_role() answers for', () => {
        const parse = latestDefinition('realtime_topic_document');
        expect(parse).toMatch(/v_epoch <> public\.document_realtime_epoch \(v_doc\)/);
        expect(latestDefinition('topic_document_role')).toMatch(/realtime_topic_document \(topic, 'doc'\)/);
        expect(latestDefinition('db_topic_document_role')).toMatch(/realtime_topic_document \(topic, 'doc-db'\)/);
        expect(latestDefinition('realtime_topic_epoch')).toMatch(/public\.document_role \(p_document\) is not null/);
    });

    it.each(['broadcast_membership_changes', 'end_student_sessions'])(
        '%s sends its hint on the current generation',
        (fn) => {
            const body = latestDefinition(fn);
            expect(body).toMatch(/public\.document_live_topic \(/);
            expect(body).not.toMatch(/'doc:'\s*\|\|/);
        },
    );

    it("stops a removed score's owner reading its row, so the re-check finds nothing", () => {
        expect(latestDocumentsSelect()).toMatch(
            /owner_id = \(select auth\.uid\(\)\) and not public\.owned_document_removed \(id\)/,
        );
        expect(latestDefinition('owned_document_removed')).toMatch(/d\.owner_id = \(select auth\.uid\(\)\)/);
    });
});

describe("a restriction never makes the owner's devices skip marks", () => {
    it('the viewer holds the watermark before every gap-fill pull (reconnect, resync, topic move)', () => {
        const viewer = readFileSync(resolve(process.cwd(), 'src/features/viewer/PdfViewport.tsx'), 'utf8');
        for (const hook of ['onReconnect', 'onResync']) {
            const start = viewer.indexOf(`${hook}: () => {`);
            expect(start, `${hook} is wired`).toBeGreaterThan(-1);
            const body = viewer.slice(start, viewer.indexOf('},', start));
            const hold = body.indexOf('engine?.noteGap();');
            expect(hold, `${hook} notes the gap`).toBeGreaterThan(-1);
            expect(hold).toBeLessThan(body.indexOf('engine?.sync();'));
        }
    });
});
