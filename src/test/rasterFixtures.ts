import type { DetectionRaster } from '@/features/import/importTypes';

export type Rgb = [number, number, number];

export const INK_BLUE: Rgb = [37, 99, 235];
export const INK_RED: Rgb = [220, 38, 38];

/** Solid-background RGBA raster for detection tests. */
export const makeRaster = (width: number, height: number, bg: Rgb = [255, 255, 255]): DetectionRaster => {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = bg[0];
        data[i * 4 + 1] = bg[1];
        data[i * 4 + 2] = bg[2];
        data[i * 4 + 3] = 255;
    }
    return { data, width, height };
};

export const paintRect = (raster: DetectionRaster, x: number, y: number, w: number, h: number, color: Rgb): void => {
    for (let py = y; py < y + h; py++) {
        for (let px = x; px < x + w; px++) {
            const i = (py * raster.width + px) * 4;
            raster.data[i] = color[0];
            raster.data[i + 1] = color[1];
            raster.data[i + 2] = color[2];
            raster.data[i + 3] = 255;
        }
    }
};
