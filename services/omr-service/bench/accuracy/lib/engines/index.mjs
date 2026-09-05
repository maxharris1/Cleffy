import { AUDIVERIS_IMAGES, runAudiverisEngine } from './audiveris.mjs';

/**
 * Engine registry. Each engine's `run({ score, pdfPath, workDir, pages })`
 * resolves to `{ musical, scoreData, timings, usd?, tokens?, llm?, extra? }`.
 */
export const getEngine = (name, options = {}) => {
    if (name in AUDIVERIS_IMAGES) {
        const image = AUDIVERIS_IMAGES[name];
        return {
            name,
            run: ({ pdfPath, workDir }) => runAudiverisEngine({ image, pdfPath, workDir }),
        };
    }
    if (name === 'llm-notes' || name === 'llm-geo' || name === 'geo-only') {
        return {
            name,
            run: async (ctx) => {
                const { runLlmEngine } = await import('./llm.mjs');
                return runLlmEngine({ ...ctx, mode: name, ...options });
            },
        };
    }
    throw new Error(
        `Unknown engine ${name}. Known: ${Object.keys(AUDIVERIS_IMAGES).join(', ')}, llm-notes, llm-geo, geo-only`,
    );
};
