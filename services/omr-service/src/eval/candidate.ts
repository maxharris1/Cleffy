import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { PLAY_ALONG_AUDIVERIS_OPTIONS, parseExtraOpts } from '../audiveris.js';
import { buildScoreData } from '../buildScoreData.js';
import { DEFAULT_ERA, eraOfTitle, type Era } from '../era.js';
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

/**
 * The era production would play this piece in. Production reads it from the
 * document title's IMSLP "(Last, First)" suffix (era.ts `eraOfTitle`). Corpus
 * titles lead with the composer instead ("Bach — Invention 1", "Petzold / Bach
 * — Menuet", "Bach (attrib.) — Air"), so the last named composer is moved into
 * that suffix and the same helper decides. A title without " — " is taken as a
 * document title as-is.
 */
export const eraOfCorpusTitle = (title: string): Era => {
    const dash = title.indexOf(' — ');
    if (dash < 0) {
        return eraOfTitle(title);
    }
    const composers = title
        .slice(0, dash)
        .replace(/\([^()]*\)/g, '')
        .split('/')
        .map((name) => name.trim())
        .filter(Boolean);
    const surname = composers[composers.length - 1];
    return surname ? eraOfTitle(`${title} (${surname})`) : DEFAULT_ERA;
};

/**
 * Parse and build exactly as job.ts `parseRangeArtifacts` does, era included:
 * the era changes how ornaments are spelled (a Baroque prall is a four-note
 * Pralltriller starting above) and how an unmarked score is pedalled.
 */
export const fromArtifacts = async (
    dir: string,
    source: CandidateSource = 'artifacts',
    era: Era = DEFAULT_ERA,
): Promise<Candidate> => {
    const files = walkFiles(dir);
    const mxl = files.filter((f) => f.toLowerCase().endsWith('.mxl')).sort();
    const omr = files.find((f) => f.toLowerCase().endsWith('.omr')) ?? null;
    if (mxl.length === 0) {
        throw new Error(`no .mxl under ${dir}`);
    }
    const buffers = await Promise.all(mxl.map((f) => readFile(f)));
    const musical = parseMxlFiles(buffers, undefined, { era });
    const geometry = omr ? parseOmrGeometry(await readFile(omr)) : null;
    const score = buildScoreData(musical, geometry, { era });
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

type DockerExec = (container: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
type RunAudiveris = (pdfPath: string, destDir: string, logPath: string) => Promise<void>;

const defaultDockerExec: DockerExec = async (container, args) => {
    try {
        return await execFileAsync('docker', ['exec', container, ...args], { maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`docker exec ${container} failed: ${message}`, { cause: err });
    }
};

let dockerExecImpl: DockerExec = defaultDockerExec;

const dockerExec: DockerExec = (container, args) => dockerExecImpl(container, args);

/** Read the version exported by the selected container without importing its service. */
const readContainerEngineVersion = async (): Promise<string> => {
    const script = String.raw`const fs=require('node:fs');const source=fs.readFileSync('/svc/dist/job.js','utf8');const match=source.match(/^\s*export\s+const\s+ENGINE_VERSION\s*=\s*(['"])([^'"]+)\1\s*;\s*$/m);if(!match)process.exit(2);process.stdout.write(match[2]);`;
    const { stdout } = await dockerExecImpl(omrContainer(), ['node', '-e', script]);
    const version = stdout.trim();
    if (!version) {
        throw new Error(`OMR container ${omrContainer()} did not expose ENGINE_VERSION from /svc/dist/job.js`);
    }
    return version;
};

/** Fail closed before reading the Audiveris binary or touching an artifact cache. */
const assertContainerEngineVersion = async (): Promise<string> => {
    const observed = await readContainerEngineVersion();
    if (observed !== ENGINE_VERSION) {
        throw new Error(
            `OMR container ${omrContainer()} has ENGINE_VERSION ${observed}, expected ${ENGINE_VERSION}; ` +
                `select the matching Cleffy OMR image before running the benchmark`,
        );
    }
    return observed;
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

/**
 * A per-run work directory inside the shared container. Two eval processes can
 * export at once (bench in one shell, shootout in another); fixed paths would
 * let one overwrite the other's input mid-run and be cached under the wrong
 * PDF's key. The PDF keeps its fixed basename because Audiveris names its
 * exports after it, and the artifact hash covers those names.
 */
const containerWorkDir = (): string => `/tmp/omr-eval-${process.pid}-${randomUUID()}`;

const exportInContainer = async (
    container: string,
    pdfPath: string,
    remotePdf: string,
    remoteOut: string,
    destDir: string,
    logPath: string,
): Promise<void> => {
    await execFileAsync('docker', ['cp', pdfPath, `${container}:${remotePdf}`]);

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

    const { stdout } = await dockerExec(container, ['find', remoteOut, '-type', 'f']);
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

const runAudiverisInContainer = async (pdfPath: string, destDir: string, logPath: string): Promise<void> => {
    await mkdir(destDir, { recursive: true });
    const container = omrContainer();
    const remoteDir = containerWorkDir();
    const remotePdf = `${remoteDir}/omr-eval-input.pdf`;
    const remoteOut = `${remoteDir}/out`;
    await dockerExec(container, ['mkdir', '-p', remoteOut]);
    try {
        await exportInContainer(container, pdfPath, remotePdf, remoteOut, destDir, logPath);
    } finally {
        await dockerExec(container, ['rm', '-rf', remoteDir]).catch(() => undefined);
    }
};

let runAudiverisImpl: RunAudiveris = runAudiverisInContainer;

/** Test-only process seam; production always uses Docker and the local exporter. */
export const setCandidateRuntimeForTests = (
    runtime: {
        dockerExec?: DockerExec;
        runAudiveris?: RunAudiveris;
    } | null,
): void => {
    dockerExecImpl = runtime?.dockerExec ?? defaultDockerExec;
    runAudiverisImpl = runtime?.runAudiveris ?? runAudiverisInContainer;
};

interface ArtifactMeta {
    pdfSha?: unknown;
    engineVersion?: unknown;
    observedEngineVersion?: unknown;
    audiverisVersion?: unknown;
    options?: unknown;
}

/** A cache is reusable only when its input and observed container provenance are exact. */
const cacheMetaMatches = async (dir: string, pdfSha: string, options: string): Promise<boolean> => {
    const metaPath = join(dir, 'meta.json');
    if (!existsSync(metaPath)) {
        return false;
    }

    try {
        const raw: unknown = JSON.parse(await readFile(metaPath, 'utf8'));
        if (raw === null || typeof raw !== 'object') {
            return false;
        }
        const meta = raw as ArtifactMeta;
        return (
            meta.pdfSha === pdfSha &&
            meta.options === options &&
            meta.engineVersion === ENGINE_VERSION &&
            meta.observedEngineVersion === ENGINE_VERSION
        );
    } catch {
        return false;
    }
};

const cacheReady = async (dir: string, pdfSha: string, options: string): Promise<boolean> =>
    existsSync(dir) &&
    walkFiles(dir).some((f) => f.toLowerCase().endsWith('.mxl')) &&
    (await cacheMetaMatches(dir, pdfSha, options));

export const fromPdf = async (pdfPath: string, force = false, era: Era = DEFAULT_ERA): Promise<Candidate> => {
    const pdfSha = sha256File(pdfPath);
    const options = optionsFingerprint();
    const dest = join(artifactsCacheDir(), artifactCacheKey(pdfSha, options));
    // Verify the selected container before cache lookup or any Audiveris command. This prevents
    // an older running container from being recorded under the local engine revision.
    const observedEngineVersion = await assertContainerEngineVersion();
    const hit = !force && (await cacheReady(dest, pdfSha, options));
    const dockerVersion = await readAudiverisVersion();
    if (!hit) {
        // A legacy or mismatched cache uses the same revision-keyed directory. Remove its files
        // before export so stale MXL/OMR files cannot be mixed with the fresh run.
        await rm(dest, { recursive: true, force: true });
        await mkdir(dest, { recursive: true });
        await runAudiverisImpl(pdfPath, dest, join(dest, 'audiveris.log'));
        await writeFile(
            join(dest, 'meta.json'),
            JSON.stringify({
                pdfSha,
                engineVersion: ENGINE_VERSION,
                observedEngineVersion,
                audiverisVersion: dockerVersion,
                options,
            }),
        );
    }
    const candidate = await fromArtifacts(dest, 'pdf', era);
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
