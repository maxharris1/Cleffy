import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { createClient } from '@supabase/supabase-js';

import { TICKS_PER_QUARTER, type ScoreData } from '../scoreData.js';
import {
    DOCUMENT_ID_RE,
    assertDocumentReady,
    fromPdf,
    fromScoreFile,
    parseScoreJson,
    type Candidate,
} from './candidate.js';
import { compareScore } from './compare.js';
import { fetchCorpus, midiPath } from './fetch.js';
import { sha256Buffer, sha256File } from './hash.js';
import type { CorpusEntry } from './manifest.js';
import { notesFromMidi } from './midiRef.js';
import { downloadsDir, packageRoot, resultsDir } from './paths.js';
import { attachRecord, formatSummary, type EvalRecord } from './report.js';
import { segmentMovements } from './segment.js';

/** Hosted production project. Shootout fetch never targets local / `.env.local`. */
export const HOSTED_PROJECT_REF = 'jibgwgosihadbjgxdsfe';

export type ShootoutSide = 'prod' | 'local';

export interface ShootoutMeta {
    side: ShootoutSide;
    documentId?: string;
    title?: string;
    storagePath?: string;
    engineVersion: string | null;
    audiverisVersion: string | null;
    pdfSha256: string | null;
    pdfBytes?: number;
    hostedProject?: string;
    fetchedAt?: string;
    artifactHash?: string | null;
    artifactDir?: string | null;
    readOnly?: true;
}

export interface OverfullTicks {
    bars: number;
    extraTicks: number;
}

export interface ShootoutSideReport {
    engineVersion: string | null;
    composite: number;
    pitchMatch: number;
    exact: number;
    missing: number;
    extra: number;
    overfullBars: number;
    overfullTicks: number;
    pdfSha256: string | null;
}

export interface ShootoutReport {
    slug: string;
    title: string;
    pdfIdentical: boolean | null;
    prod: ShootoutSideReport;
    local: ShootoutSideReport;
}

const repoRoot = (): string => resolve(packageRoot(), '..', '..');

export const shootoutPdfPath = (slug: string): string => join(downloadsDir(), `shootout-${slug}.pdf`);

export const shootoutSideDir = (slug: string, side: ShootoutSide): string =>
    join(resultsDir(), `${slug}-${side}`);

export const shootoutScorePath = (slug: string, side: ShootoutSide): string =>
    join(shootoutSideDir(slug, side), 'score.json');

export const shootoutOutDir = (slug: string): string => join(resultsDir(), `${slug}-shootout`);

export const parseEnvFile = (contents: string): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const raw of contents.split('\n')) {
        const line = raw.trim();
        if (line === '' || line.startsWith('#')) {
            continue;
        }
        const eq = line.indexOf('=');
        if (eq < 1) {
            continue;
        }
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
};

export const loadRepoEnv = (envPath = join(repoRoot(), '.env')): Record<string, string> => {
    if (!existsSync(envPath)) {
        return {};
    }
    return parseEnvFile(readFileSync(envPath, 'utf8'));
};

export const assertHostedEvalUrl = (url: string): string => {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error('VITE_SUPABASE_URL is not a URL');
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== `${HOSTED_PROJECT_REF}.supabase.co`) {
        throw new Error(
            `shootout fetch is hosted-only (${HOSTED_PROJECT_REF}.supabase.co). Got ${host}. ` +
                `Use repo-root .env (VITE_SUPABASE_*), not .env.local from .cursor/start.sh.`,
        );
    }
    return url.replace(/\/+$/, '');
};

const envVal = (file: Record<string, string>, key: string): string | undefined => {
    const live = process.env[key];
    if (live !== undefined && live.trim() !== '') {
        return live.trim();
    }
    const fromFile = file[key];
    return fromFile !== undefined && fromFile.trim() !== '' ? fromFile.trim() : undefined;
};

export const overfullTicks = (score: ScoreData): OverfullTicks => {
    const sigs = [...score.timeSignatures].sort((a, b) => a.tick - b.tick);
    let bars = 0;
    let extraTicks = 0;
    for (const measure of score.measures) {
        let sig = sigs[0];
        for (const candidate of sigs) {
            if (candidate.tick <= measure.tick) {
                sig = candidate;
            }
        }
        if (sig === undefined) {
            continue;
        }
        const expected = Math.round((4 * TICKS_PER_QUARTER * sig.num) / sig.den);
        if (measure.dTicks > expected) {
            bars += 1;
            extraTicks += measure.dTicks - expected;
        }
    }
    return { bars, extraTicks };
};

export const readShootoutMeta = (dir: string): ShootoutMeta | null => {
    const path = join(dir, 'meta.json');
    if (!existsSync(path)) {
        return null;
    }
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (raw === null || typeof raw !== 'object') {
        return null;
    }
    const rec = raw as Record<string, unknown>;
    const side = rec.side === 'prod' || rec.side === 'local' ? rec.side : null;
    if (side === null) {
        return null;
    }
    const sha = rec.pdfSha256;
    const engine = rec.engineVersion ?? rec.engine_version;
    return {
        side,
        documentId: typeof rec.documentId === 'string' ? rec.documentId : undefined,
        title: typeof rec.title === 'string' ? rec.title : undefined,
        storagePath: typeof rec.storagePath === 'string' ? rec.storagePath : undefined,
        engineVersion: typeof engine === 'string' ? engine : null,
        audiverisVersion: typeof rec.audiverisVersion === 'string' ? rec.audiverisVersion : null,
        pdfSha256: typeof sha === 'string' && /^[0-9a-f]{64}$/.test(sha) ? sha : null,
        pdfBytes: typeof rec.pdfBytes === 'number' ? rec.pdfBytes : undefined,
        hostedProject: typeof rec.hostedProject === 'string' ? rec.hostedProject : undefined,
        fetchedAt: typeof rec.fetchedAt === 'string' ? rec.fetchedAt : undefined,
        artifactHash: typeof rec.artifactHash === 'string' ? rec.artifactHash : null,
        artifactDir: typeof rec.artifactDir === 'string' ? rec.artifactDir : null,
        readOnly: rec.readOnly === true ? true : undefined,
    };
};

const writeJson = async (path: string, value: unknown): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

const hostedClient = () => {
    const file = loadRepoEnv();
    const url = envVal(file, 'VITE_SUPABASE_URL');
    if (url === undefined) {
        throw new Error('VITE_SUPABASE_URL missing. Put hosted keys in repo-root .env (never commit them).');
    }
    assertHostedEvalUrl(url);
    const key = envVal(file, 'SUPABASE_SERVICE_ROLE_KEY');
    if (key === undefined) {
        throw new Error(
            'SUPABASE_SERVICE_ROLE_KEY missing in repo-root .env. Anon/publishable keys cannot pass RLS for a private score_analyses row. Fetch is SELECT + storage download only — never mutate prod.',
        );
    }
    return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
};

export const fetchProdShootout = async (entry: CorpusEntry, documentId: string): Promise<string> => {
    if (!DOCUMENT_ID_RE.test(documentId)) {
        throw new Error(`document id is not a UUID: ${documentId}`);
    }
    const client = hostedClient();
    const { data: analysis, error: analysisErr } = await client
        .from('score_analyses')
        .select('status, engine_version, score')
        .eq('document_id', documentId)
        .maybeSingle();
    if (analysisErr) {
        throw new Error(`hosted score_analyses read failed: ${analysisErr.message}`);
    }
    if (analysis === null) {
        throw new Error(`no score_analyses row for ${documentId} on hosted ${HOSTED_PROJECT_REF}`);
    }
    const { data: doc, error: docErr } = await client
        .from('documents')
        .select('title, owner_id, storage_path')
        .eq('id', documentId)
        .maybeSingle();
    if (docErr) {
        throw new Error(`hosted documents read failed: ${docErr.message}`);
    }
    if (doc === null) {
        throw new Error(`no documents row for ${documentId} on hosted ${HOSTED_PROJECT_REF}`);
    }
    const status = typeof analysis.status === 'string' ? analysis.status : '';
    const title = typeof doc.title === 'string' ? doc.title : '';
    const ownerId = typeof doc.owner_id === 'string' ? doc.owner_id : '';
    assertDocumentReady(status, title, ownerId);
    const storagePath = typeof doc.storage_path === 'string' ? doc.storage_path : '';
    if (!storagePath) {
        throw new Error(`document ${documentId} has no storage_path`);
    }
    const { data: blob, error: dlErr } = await client.storage.from('scores').download(storagePath);
    if (dlErr || !blob) {
        throw new Error(`hosted PDF download failed: ${dlErr?.message ?? 'empty body'}`);
    }
    const pdfBuf = Buffer.from(await blob.arrayBuffer());
    if (pdfBuf.length < 32 || !pdfBuf.subarray(0, 4).toString('latin1').startsWith('%PDF')) {
        throw new Error(`hosted object at ${storagePath} is not a PDF`);
    }
    const pdfSha256 = sha256Buffer(pdfBuf);
    const pdfPath = shootoutPdfPath(entry.slug);
    await mkdir(dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, pdfBuf);

    const parsed = parseScoreJson(
        typeof analysis.score === 'string' ? JSON.parse(analysis.score) : analysis.score,
    );
    const engineVersion = typeof analysis.engine_version === 'string' ? analysis.engine_version : null;
    const dest = shootoutSideDir(entry.slug, 'prod');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'score.json'), `${JSON.stringify(parsed)}\n`);
    const meta: ShootoutMeta = {
        side: 'prod',
        documentId,
        title,
        storagePath,
        engineVersion,
        audiverisVersion: engineVersion,
        pdfSha256,
        pdfBytes: pdfBuf.length,
        hostedProject: HOSTED_PROJECT_REF,
        fetchedAt: new Date().toISOString(),
        readOnly: true,
    };
    await writeJson(join(dest, 'meta.json'), meta);
    process.stderr.write(
        `fetched prod ${documentId} pdfSha=${pdfSha256} bytes=${pdfBuf.length} engine=${engineVersion ?? '—'}\n`,
    );
    return dest;
};

export const runLocalShootout = async (entry: CorpusEntry, forceAudiveris: boolean): Promise<string> => {
    const pdfPath = shootoutPdfPath(entry.slug);
    if (!existsSync(pdfPath)) {
        throw new Error(
            `shootout PDF missing at ${pdfPath}. Run \`shootout fetch\` on a machine with hosted .env, then copy eval/cache/downloads/shootout-${entry.slug}.pdf here.`,
        );
    }
    const prodMeta = readShootoutMeta(shootoutSideDir(entry.slug, 'prod'));
    const pdfSha = sha256File(pdfPath);
    if (prodMeta?.pdfSha256 && prodMeta.pdfSha256 !== pdfSha) {
        throw new Error(
            `local PDF sha ${pdfSha} does not match prod fetch ${prodMeta.pdfSha256}. ` +
                `Refuse to OMR a different scan. Re-run shootout fetch and use those bytes.`,
        );
    }
    if (!prodMeta?.pdfSha256) {
        throw new Error(
            `prod meta.json with pdfSha256 is required before local OMR (apples-to-apples). ` +
                `Run shootout fetch first.`,
        );
    }
    const candidate = await fromPdf(pdfPath, forceAudiveris);
    const dest = shootoutSideDir(entry.slug, 'local');
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, 'score.json'), `${JSON.stringify(candidate.score)}\n`);
    const meta: ShootoutMeta = {
        side: 'local',
        engineVersion: candidate.engineVersion,
        audiverisVersion: candidate.audiverisVersion,
        pdfSha256: pdfSha,
        pdfBytes: (await readFile(pdfPath)).length,
        artifactHash: candidate.artifactHash,
        artifactDir: candidate.artifactDir,
    };
    await writeJson(join(dest, 'meta.json'), meta);
    process.stderr.write(
        `local OMR pdfSha=${pdfSha} engine=${candidate.engineVersion ?? '—'} artifacts=${candidate.artifactDir ?? '—'}\n`,
    );
    return dest;
};

const scoreCandidate = async (
    entry: CorpusEntry,
    candidate: Candidate,
    midiDir: string,
): Promise<EvalRecord> => {
    const refs = [];
    for (const movement of entry.movements) {
        const buf = await readFile(midiPath({ pdfPath: null, midiDir }, movement.midi));
        refs.push(notesFromMidi(buf, movement));
    }
    const segmented = segmentMovements(candidate.score, entry);
    return attachRecord(compareScore(candidate.score, entry, refs, segmented), candidate);
};

const sideReport = (record: EvalRecord, score: ScoreData, pdfSha256: string | null): ShootoutSideReport => {
    const over = overfullTicks(score);
    return {
        engineVersion: record.engineVersion,
        composite: record.composite,
        pitchMatch: record.overall.pitchMatch,
        exact: record.overall.exact,
        missing: record.overall.missing,
        extra: record.overall.extra,
        overfullBars: over.bars,
        overfullTicks: over.extraTicks,
        pdfSha256,
    };
};

export const pdfShaMatch = (prod: string | null, local: string | null): boolean | null => {
    if (!prod || !local) {
        return null;
    }
    return prod === local;
};

const pct = (n: number): string => `${n.toFixed(1)}%`;

export const formatShootout = (report: ShootoutReport): string => {
    const identical =
        report.pdfIdentical === true
            ? 'yes — inputs were identical'
            : report.pdfIdentical === false
              ? 'NO — different PDF bytes; this is not an apples-to-apples shootout'
              : 'unknown — missing pdf sha on one or both sides';
    const row = (label: string, prod: string, local: string): string => `| ${label} | ${prod} | ${local} |`;
    return [
        `# Shootout: ${report.title}`,
        '',
        `slug: ${report.slug}`,
        `PDF sha identical: ${identical}`,
        `  prod  ${report.prod.pdfSha256 ?? '—'}`,
        `  local ${report.local.pdfSha256 ?? '—'}`,
        '',
        '| Metric | Prod | Local |',
        '| --- | ---: | ---: |',
        row('composite', report.prod.composite.toFixed(1), report.local.composite.toFixed(1)),
        row('pitch', pct(report.prod.pitchMatch), pct(report.local.pitchMatch)),
        row('exact', pct(report.prod.exact), pct(report.local.exact)),
        row('missing', String(report.prod.missing), String(report.local.missing)),
        row('extra', String(report.prod.extra), String(report.local.extra)),
        row(
            'overfull ticks',
            `${report.prod.overfullTicks} (${report.prod.overfullBars} bars)`,
            `${report.local.overfullTicks} (${report.local.overfullBars} bars)`,
        ),
        row('engine', report.prod.engineVersion ?? '—', report.local.engineVersion ?? '—'),
        '',
    ].join('\n');
};

export const compareShootout = async (
    entry: CorpusEntry,
    prodScorePath: string,
    localScorePath: string,
): Promise<{ report: ShootoutReport; outDir: string; prodRecord: EvalRecord; localRecord: EvalRecord }> => {
    const fetched = await fetchCorpus(entry, { allowNetwork: false, mode: 'midi' });
    const prodCandidate = await fromScoreFile(prodScorePath);
    const localCandidate = await fromScoreFile(localScorePath);
    const prodMeta = readShootoutMeta(dirname(prodScorePath));
    const localMeta = readShootoutMeta(dirname(localScorePath));
    const prodSha = prodMeta?.pdfSha256 ?? null;
    const localSha = localMeta?.pdfSha256 ?? null;
    const prodRecord = await scoreCandidate(entry, prodCandidate, fetched.midiDir);
    const localRecord = await scoreCandidate(entry, localCandidate, fetched.midiDir);
    const report: ShootoutReport = {
        slug: entry.slug,
        title: entry.title,
        pdfIdentical: pdfShaMatch(prodSha, localSha),
        prod: sideReport(prodRecord, prodCandidate.score, prodSha),
        local: sideReport(localRecord, localCandidate.score, localSha),
    };
    const outDir = shootoutOutDir(entry.slug);
    await mkdir(outDir, { recursive: true });
    await writeJson(join(outDir, 'shootout.json'), report);
    await writeFile(join(outDir, 'summary.md'), formatShootout(report));
    await writeFile(join(outDir, 'prod-eval.md'), `${formatSummary(prodRecord)}\n`);
    await writeFile(join(outDir, 'local-eval.md'), `${formatSummary(localRecord)}\n`);
    return { report, outDir, prodRecord, localRecord };
};
