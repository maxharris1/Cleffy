import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { PLAY_ALONG_AUDIVERIS_OPTIONS, parseExtraOpts } from '../audiveris.js';
import { buildScoreData } from '../buildScoreData.js';
import { parseMxlFiles } from '../musicxml.js';
import { parseOmrGeometry } from '../omrGeometry.js';
import { scoreDataSchema, type ScoreData } from '../scoreData.js';
import { sha256File, sha256Files } from './hash.js';
import { artifactsCacheDir } from './paths.js';

const execFileAsync = promisify(execFile);

export type CandidateSource = 'pdf' | 'artifacts' | 'document';

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

const cacheKey = (pdfSha: string, version: string): string => {
    const opts = optionsFingerprint().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48);
    const ver = version.replace(/[^a-zA-Z0-9._+-]+/g, '_').slice(0, 32);
    return `${pdfSha.slice(0, 16)}-${ver}-${opts || 'default'}`;
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
        engineVersion: null,
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
        throw new Error(`docker exec ${container} failed: ${message}`);
    }
};

export const readAudiverisVersion = async (): Promise<string> => {
    try {
        const { stdout } = await dockerExec(omrContainer(), [audiverisBin(), '-version']);
        const line = stdout
            .split('\n')
            .map((s) => s.trim())
            .find((s) => /\d+\.\d+/.test(s));
        const match = line?.match(/(\d+\.\d+(?:\.\d+)?)/);
        return match?.[1] ?? line ?? 'unknown';
    } catch {
        return process.env.AUDIVERIS_VERSION ?? 'unknown';
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
    const version = await readAudiverisVersion();
    const dest = join(artifactsCacheDir(), cacheKey(pdfSha, version));
    const hit = !force && cacheReady(dest);
    if (!hit) {
        await mkdir(dest, { recursive: true });
        await runAudiverisInContainer(pdfPath, dest, join(dest, 'audiveris.log'));
        await writeFile(join(dest, 'meta.json'), JSON.stringify({ pdfSha, version, options: optionsFingerprint() }));
    }
    const candidate = await fromArtifacts(dest, 'pdf');
    return {
        ...candidate,
        audiverisVersion: version,
        audiverisCacheHit: hit,
    };
};

export const fromDocument = async (documentId: string): Promise<Candidate> => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) {
        throw new Error(`document id is not a UUID: ${documentId}`);
    }
    const { stdout: engineOut } = await dockerExec(dbContainer(), [
        'psql',
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-At',
        '-c',
        `select coalesce(engine_version, '') from score_analyses where document_id='${documentId}'`,
    ]);
    const engineVersion = engineOut.trim() || null;

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
                `select score::text from score_analyses where document_id='${documentId}'`,
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
