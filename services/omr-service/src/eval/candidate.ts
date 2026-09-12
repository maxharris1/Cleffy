import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { PLAY_ALONG_AUDIVERIS_OPTIONS, parseExtraOpts } from '../audiveris.js';
import { buildScoreData } from '../buildScoreData.js';
import { ENGINE_VERSION } from '../job.js';
import { parseMxlFiles } from '../musicxml.js';
import { parseOmrGeometry } from '../omrGeometry.js';
import { scoreDataSchema, type ScoreData } from '../scoreData.js';
import { sha256Buffer, sha256File, sha256Files } from './hash.js';
import { artifactsCacheDir } from './paths.js';

const execFileAsync = promisify(execFile);

export type CandidateSource = 'pdf' | 'artifacts' | 'document' | 'score';

export interface Candidate {
    score: ScoreData;
    source: CandidateSource;
    engineVersion: string | null;
    audiverisVersion: string | null;
    audiverisOptions: string;
    audiverisCacheHit: boolean | null;
    artifactHash: string | null;
    artifactDir: string | null;
}

const omrContainer = (): string => process.env.CLEFFY_OMR_CONTAINER ?? 'cleffy-local-omr';
const dbContainer = (): string => process.env.CLEFFY_DB_CONTAINER ?? 'supabase_db_cleffy';
const audiverisBin = (): string => process.env.AUDIVERIS_BIN ?? '/opt/audiveris-root/opt/audiveris/bin/Audiveris';

const walkFiles = (dir: string, depth = 0): string[] => {
    if (depth > 4) {
        return [];
    }
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        return entry.isDirectory() ? walkFiles(full, depth + 1) : [full];
    });
};

export const optionsFingerprint = (): string =>
    [...PLAY_ALONG_AUDIVERIS_OPTIONS, ...parseExtraOpts(process.env.AUDIVERIS_EXTRA_OPTS)].join(' ');

/** Full PDF sha256 + ENGINE_VERSION (+svc-N) + sha256 of the option vector. */
export const artifactCacheKey = (pdfSha: string, options: string = optionsFingerprint()): string => {
    const ver = ENGINE_VERSION.replace(/[^a-zA-Z0-9._+-]+/g, '_');
    const optHash = sha256Buffer(Buffer.from(options));
    return `${pdfSha}-${ver}-${optHash}`;
};

export const parseScoreJson = (raw: unknown): ScoreData => {
    const parsed = scoreDataSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`ScoreData failed to parse: ${parsed.error.issues[0]?.message}`);
    }
    return parsed.data;
};

export const fromArtifacts = async (dir: string, source: CandidateSource = 'artifacts'): Promise<Candidate> => {
    const files = walkFiles(dir);
    const mxl = files.filter((f) => f.toLowerCase().endsWith('.mxl')).sort();
    const omr = files.find((f) => f.toLowerCase().endsWith('.omr')) ?? null;
    if (mxl.length === 0) {
        throw new Error(`no .mxl under ${dir}`);
    }
    const buffers = await Promise.all(mxl.map((f) => readFile(f)));
    const musical = parseMxlFiles(buffers);
    const geometry = omr ? parseOmrGeometry(await readFile(omr)) : null;
    const score = buildScoreData(musical, geometry);
    return {
        score,
        source,
        engineVersion: ENGINE_VERSION,
        audiverisVersion: null,
        audiverisOptions: optionsFingerprint(),
        audiverisCacheHit: null,
        artifactHash: sha256Files(omr ? [...mxl, omr] : mxl),
        artifactDir: dir,
    };
};

const dockerExec = async (container: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    try {
        return await execFileAsync('docker', ['exec', container, ...args], { maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`docker exec ${container} failed: ${message}`, { cause: err });
    }
};

export const readAudiverisVersion = async (): Promise<string> => {
    try {
        const { stdout } = await dockerExec(omrContainer(), [audiverisBin(), '-version']);
        const line = stdout
            .split('\n')
            .map((s) => s.trim())
            .find((s) => /\d+\.\d+/.test(s));
        return line ?? ENGINE_VERSION;
    } catch {
        return ENGINE_VERSION;
    }
};

const cacheReady = (dir: string): boolean => {
    if (!existsSync(dir)) {
        return false;
    }
    return walkFiles(dir).some((f) => f.toLowerCase().endsWith('.mxl'));
};

const runAudiverisInContainer = async (pdfPath: string, destDir: string, logPath: string): Promise<void> => {
    await mkdir(destDir, { recursive: true });
    const container = omrContainer();
    const remotePdf = `/tmp/omr-eval-input.pdf`;
    const remoteOut = `/tmp/omr-eval-out`;
    await execFileAsync('docker', ['cp', pdfPath, `${container}:${remotePdf}`]);
    await dockerExec(container, ['rm', '-rf', remoteOut]);
    await dockerExec(container, ['mkdir', '-p', remoteOut]);

    const args = [
        'exec',
        container,
        audiverisBin(),
        '-batch',
        '-export',
        '-output',
        remoteOut,
        ...PLAY_ALONG_AUDIVERIS_OPTIONS,
        ...parseExtraOpts(process.env.AUDIVERIS_EXTRA_OPTS),
        '--',
        remotePdf,
    ];
    await new Promise<void>((resolve, reject) => {
        const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const log = createWriteStream(logPath);
        child.stdout?.pipe(log);
        child.stderr?.pipe(log);
        child.on('error', reject);
        child.on('close', (code) => {
            log.end();
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Audiveris exited ${code}. See ${logPath}`));
            }
        });
    });

    const { stdout } = await dockerExec(container, ['sh', '-c', `find ${remoteOut} -type f`]);
    const remotes = stdout
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.endsWith('.mxl') || s.endsWith('.omr') || s.endsWith('.log'));
    for (const remote of remotes) {
        const name = remote.split('/').pop();
        if (!name) {
            continue;
        }
        await execFileAsync('docker', ['cp', `${container}:${remote}`, join(destDir, name)]);
    }
};

export const fromPdf = async (pdfPath: string, force = false): Promise<Candidate> => {
    const pdfSha = sha256File(pdfPath);
    const options = optionsFingerprint();
    const dest = join(artifactsCacheDir(), artifactCacheKey(pdfSha, options));
    const hit = !force && cacheReady(dest);
    const dockerVersion = await readAudiverisVersion();
    if (!hit) {
        await mkdir(dest, { recursive: true });
        await runAudiverisInContainer(pdfPath, dest, join(dest, 'audiveris.log'));
        await writeFile(
            join(dest, 'meta.json'),
            JSON.stringify({ pdfSha, engineVersion: ENGINE_VERSION, audiverisVersion: dockerVersion, options }),
        );
    }
    const candidate = await fromArtifacts(dest, 'pdf');
    return {
        ...candidate,
        engineVersion: ENGINE_VERSION,
        audiverisVersion: dockerVersion,
        audiverisCacheHit: hit,
    };
};

export const DOCUMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const assertDocumentReady = (status: string, title: string, ownerId: string): void => {
    if (status !== 'ready') {
        throw new Error(`score_analyses status is '${status}', not ready (title=${title || '?'})`);
    }
    if (!title.trim()) {
        throw new Error('document title is empty');
    }
    if (!ownerId.trim()) {
        throw new Error('document has no owner_id');
    }
};

export const documentMetaSql = (documentId: string): string =>
    `select sa.status, coalesce(sa.engine_version, ''), d.title, d.owner_id::text ` +
    `from score_analyses sa join documents d on d.id = sa.document_id ` +
    `where sa.document_id='${documentId}'`;

export const fromDocument = async (documentId: string): Promise<Candidate> => {
    if (!DOCUMENT_ID_RE.test(documentId)) {
        throw new Error(`document id is not a UUID: ${documentId}`);
    }
    const { stdout: metaOut } = await dockerExec(dbContainer(), [
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-At',
        '-F',
        '\t',
        '-c',
        documentMetaSql(documentId),
    ]);
    const metaLine = metaOut.trim().split('\n')[0];
    if (!metaLine) {
        throw new Error(`no ready score_analyses+documents row for ${documentId}`);
    }
    const [status, engineRaw, title, ownerId] = metaLine.split('\t');
    assertDocumentReady(status ?? '', title ?? '', ownerId ?? '');
    const engineVersion = engineRaw?.trim() || null;
    process.stderr.write(`document ${documentId} title=${title} owner=${ownerId} engine=${engineVersion ?? '—'}\n`);

    const tmp = join(artifactsCacheDir(), `document-${documentId}.json`);
    await mkdir(artifactsCacheDir(), { recursive: true });
    await new Promise<void>((resolve, reject) => {
        const child = spawn(
            'docker',
            [
                'exec',
                dbContainer(),
                'psql',
                '-U',
                'postgres',
                '-d',
                'postgres',
                '-At',
                '-c',
                `select score::text from score_analyses where document_id='${documentId}' and status='ready'`,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const out = createWriteStream(tmp);
        child.stdout?.pipe(out);
        let err = '';
        child.stderr?.on('data', (chunk: Buffer) => {
            err += chunk.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => {
            out.end();
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`psql exited ${code}: ${err}`));
            }
        });
    });
    const text = (await readFile(tmp, 'utf8')).trim();
    if (!text) {
        throw new Error(`no score_analyses row for ${documentId}`);
    }
    const score = parseScoreJson(JSON.parse(text));
    return {
        score,
        source: 'document',
        engineVersion,
        audiverisVersion: engineVersion,
        audiverisOptions: optionsFingerprint(),
        audiverisCacheHit: null,
        artifactHash: null,
        artifactDir: null,
    };
};

/** Load a dumped ScoreData JSON (hosted fetch or a previous local run). */
export const fromScoreFile = async (scorePath: string): Promise<Candidate> => {
    const raw: unknown = JSON.parse(await readFile(scorePath, 'utf8'));
    const score = parseScoreJson(raw);
    let engineVersion: string | null = null;
    const metaPath = join(dirname(scorePath), 'meta.json');
    if (existsSync(metaPath)) {
        try {
            const meta: unknown = JSON.parse(await readFile(metaPath, 'utf8'));
            if (meta !== null && typeof meta === 'object') {
                const rec = meta as Record<string, unknown>;
                const ev = rec.engine_version ?? rec.engineVersion;
                if (typeof ev === 'string' && ev.trim()) {
                    engineVersion = ev.trim();
                }
            }
        } catch {
            // sibling meta.json is optional
        }
    }
    return {
        score,
        source: 'score',
        engineVersion,
        audiverisVersion: engineVersion,
        audiverisOptions: optionsFingerprint(),
        audiverisCacheHit: null,
        artifactHash: null,
        artifactDir: null,
    };
};
