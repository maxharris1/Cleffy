import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** bench/accuracy */
export const ACCURACY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
/** services/omr-service */
export const SERVICE_DIR = join(ACCURACY_DIR, '..', '..');
export const DIST_DIR = join(SERVICE_DIR, 'dist');
export const DATA_DIR = join(ACCURACY_DIR, 'data');
export const GT_DIR = join(DATA_DIR, 'gt');
export const PDF_DIR = join(DATA_DIR, 'pdf');
export const IMSLP_DIR = join(DATA_DIR, 'imslp');
export const RESULTS_DIR = join(ACCURACY_DIR, 'results');
export const RAW_RESULTS_DIR = join(RESULTS_DIR, 'raw');
export const LLM_CACHE_DIR = join(RESULTS_DIR, 'llm-cache');
export const MANIFEST_PATH = join(ACCURACY_DIR, 'manifest.json');
