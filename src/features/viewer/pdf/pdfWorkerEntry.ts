// Wrapper worker entry: install polyfills in the worker's global scope BEFORE
// pdf.js worker code evaluates (it uses Map.getOrInsertComputed at call time).
import '@/lib/polyfills';
import 'pdfjs-dist/build/pdf.worker.mjs';
