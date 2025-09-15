import { NextRequest, NextResponse } from 'next/server';
import path from 'node:path';
import fs from 'node:fs/promises';
import { analyzeDrawitInput } from '@/lib/drawit-import/analyzer';
import { emitScreens, previewEmit, Emitter } from '@/lib/drawit-import/emitter';

/**
 * /api/generate-from-drawit
 *
 * Full generation endpoint (analysis + optional emission).
 * Keeps original /api/import-drawit (analysis-only) untouched to avoid breaking changes.
 *
 * POST body (application/json):
 * {
 *   "diagram": {...},              // or raw root object (like import endpoint)
 *   "options": {
 *      "dryRun": true,             // default false -> when true, does not write files
 *      "prune": false,             // when true (and not dryRun) removes previously generated routes not present now
 *      "outDir": "app/generated"   // override output directory (project-relative)
 *   }
 * }
 *
 * Response (success, dryRun):
 * {
 *   ok: true,
 *   mode: "dry-run",
 *   sourceHash: "...",
 *   analysis: { ...same as /api/import-drawit },
 *   preview: { files: [{ route, relPath, content }...], manifest }
 * }
 *
 * Response (success, write):
 * {
 *   ok: true,
 *   mode: "write",
 *   sourceHash: "...",
 *   analysis: { ... },
 *   manifest: { ... },
 *   generatedFiles: [{ route, relPath }]
 * }
 *
 * Response (failure):
 * {
 *   ok: false,
 *   errors: [...]
 * }
 */

const MAX_RAW_BYTES = 2 * 1024 * 1024; // 2MB cap (same as import)
const DEFAULT_OUT_DIR = 'app/generated';

interface GenerationOptions {
  dryRun?: boolean;
  prune?: boolean;
  outDir?: string;
}

export async function POST(req: NextRequest) {
  try {
    const rawText = await req.text();
    if (rawText.length > MAX_RAW_BYTES) {
      return NextResponse.json(
        { ok: false, errors: [{ path: '(root)', message: `Request body too large (${rawText.length} bytes > ${MAX_RAW_BYTES})` }] },
        { status: 413 },
      );
    }
    if (!rawText.trim()) {
      return NextResponse.json(
        { ok: false, errors: [{ path: '(root)', message: 'Empty request body' }] },
        { status: 400 },
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return NextResponse.json(
        { ok: false, errors: [{ path: '(root)', message: 'Malformed JSON body' }] },
        { status: 400 },
      );
    }

    const diagram = parsed?.diagram ?? parsed;
    const options: GenerationOptions = parsed?.options || {};

    if (!diagram || typeof diagram !== 'object') {
      return NextResponse.json(
        { ok: false, errors: [{ path: '(root)', message: 'No diagram JSON provided' }] },
        { status: 400 },
      );
    }

    const analysis = await analyzeDrawitInput(diagram);
    if (!analysis.ok) {
      return NextResponse.json(analysis, { status: 400 });
    }

    // Prepare emission
    const outDirRel = options.outDir || DEFAULT_OUT_DIR;
    const projectRoot = process.cwd();
    const outDirAbs = path.isAbsolute(outDirRel) ? outDirRel : path.join(projectRoot, outDirRel);

    // Ensure base output dir exists (even in dryRun we may want to read previous manifest)
    if (!options.dryRun) {
      await fs.mkdir(outDirAbs, { recursive: true });
    }

    // Read previous manifest (if present) for provenance
    const manifestPath = path.join(outDirAbs, '.drawit-generation-manifest.json');
    let previousManifest: any = null;
    try {
      const prevRaw = await fs.readFile(manifestPath, 'utf8');
      previousManifest = JSON.parse(prevRaw);
    } catch {
      // ignore
    }

    const previousHash: string | undefined = previousManifest?.sourceHash;

    if (options.dryRun) {
      const preview = previewEmit(analysis.screens, analysis.sourceHash);
      return NextResponse.json({
        ok: true,
        mode: 'dry-run',
        sourceHash: analysis.sourceHash,
        previousHash,
        hashChanged: previousHash ? previousHash !== analysis.sourceHash : true,
        analysis,
        preview: {
          files: preview.files.map(f => ({
            route: f.route,
            relPath: f.relPath,
            content: f.content,
          })),
          manifest: preview.manifest,
        },
      });
    }

    // Perform actual emission
    const emitResult = await emitScreens(analysis.screens, analysis.sourceHash, {
      outDir: outDirAbs,
      createDirs: true,
      dryRun: false,
      addRouteExportComment: true,
    });

    // Attach previousHash for provenance
    if (previousHash && emitResult.manifest.sourceHash !== previousHash) {
      emitResult.manifest.previousHash = previousHash;
      // overwrite manifest with updated previousHash
      await fs.writeFile(
        manifestPath,
        JSON.stringify(emitResult.manifest, null, 2),
        'utf8',
      );
    }

    // Optional pruning: remove stale generated routes not present now
    if (options.prune) {
      const keepRoutes = emitResult.manifest.screens.map(s => s.route);
      try {
        await Emitter.pruneGenerated(outDirAbs, keepRoutes);
      } catch (e) {
        console.warn('[generate-from-drawit] prune failed', e);
      }
    }

    return NextResponse.json({
      ok: true,
      mode: 'write',
      sourceHash: emitResult.manifest.sourceHash,
      previousHash,
      hashChanged: previousHash ? previousHash !== emitResult.manifest.sourceHash : true,
      analysis,
      manifest: emitResult.manifest,
      generatedFiles: emitResult.files.map(f => ({ route: f.route, relPath: path.relative(projectRoot, f.filePath) })),
      warnings: emitResult.warnings,
    });
  } catch (err: any) {
    console.error('[generate-from-drawit] Unexpected error', err);
    return NextResponse.json(
      {
        ok: false,
        errors: [{ path: '(root)', message: 'Internal server error' }],
        internalMessage: process.env.NODE_ENV === 'development' ? String(err?.message || err) : undefined,
      },
      { status: 500 },
    );
  }
}
