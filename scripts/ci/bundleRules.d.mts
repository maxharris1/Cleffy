export interface BundleChunk {
    isEntry: boolean;
    imports: string[];
    dynamicImports: string[];
    modules: string[];
}
export const VIEWER_MODULE: RegExp;
export const GUARDED_MODULE: RegExp;
export const VIEWER_GZIP_BUDGET: number;
export function bundleProblems(
    report: { chunks: Record<string, BundleChunk> },
    gzipSizeOf: (chunkFileName: string) => number,
): string[];
