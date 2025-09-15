import { NextRequest, NextResponse } from 'next/server';
import { analyzeDrawitInput } from '@/lib/drawit-import/analyzer';

/**
 * /api/import-drawit
 *
 * MVP endpoint to ingest a .drawit JSON (already parsed client-side or raw JSON),
 * validate + normalize + analyze it, and return an analysis response.
 *
 * Non-breaking design:
 * - Does NOT write any generated files yet (emitter comes later)
 * - Purely returns JSON (client can preview before generation step)
 *
 * Accepted request formats:
 * 1. application/json body:
 *    {
 *      "diagram": { ...original drawit JSON... }
 *    }
 *    or direct root object (fallback)
 *
 * 2. multipart/form-data with a 'file' field containing JSON text
 *
 * Response (success):
 *  {
 *    "ok": true,
 *    "sourceHash": "...",
 *    "screens": [
 *       {
 *         "screen": { id, route, frame, elements: [...] },
 *         "classified": [
 *            { node, kind, inferredName, roleHints }
 *         ]
 *       }
 *    ],
 *    "warnings": [...],
 *    "meta": {
 *       "elementCount": n,
 *       "unassignedElementCount": m,
 *       "generatedAt": isoString
 *    }
 *  }
 *
 * Response (validation / analysis failure):
 *  {
 *    "ok": false,
 *    "errors": [{ path, message }, ...]
 *  }
 *
 * NOTE: Emitter / file generation & manifest writing will be implemented in a later step.
 */

// Basic size guard (in bytes) to avoid accidentally accepting extremely large payloads.
// Adjust later if needed.
const MAX_RAW_BYTES = 2 * 1024 * 1024; // 2MB

export async function POST(req: NextRequest) {
  try {
    let rawObj: unknown | null = null;

    const contentType = req.headers.get('content-type') || '';

    if (contentType.startsWith('multipart/form-data')) {
      const formData = await req.formData();
      const file = formData.get('file');
      if (file && typeof file === 'object' && 'text' in file && typeof (file as any).text === 'function') {
        const text = await (file as File).text();
        if (text.length > MAX_RAW_BYTES) {
          return NextResponse.json(
            {
              ok: false,
              errors: [{ path: '(root)', message: `File too large (${text.length} bytes > ${MAX_RAW_BYTES})` }],
            },
            { status: 413 }
          );
        }
        try {
          rawObj = JSON.parse(text);
        } catch (e) {
          return NextResponse.json(
            {
              ok: false,
              errors: [{ path: '(root)', message: 'Invalid JSON in uploaded file' }],
            },
            { status: 400 }
          );
        }
      } else {
        return NextResponse.json(
          {
            ok: false,
            errors: [{ path: '(root)', message: "Multipart upload must include a 'file' field" }],
          },
          { status: 400 }
        );
      }
    } else {
      // Assume JSON body
      const rawText = await req.text();
      if (rawText.length > MAX_RAW_BYTES) {
        return NextResponse.json(
          {
            ok: false,
            errors: [{ path: '(root)', message: `Request body too large (${rawText.length} bytes > ${MAX_RAW_BYTES})` }],
          },
          { status: 413 }
        );
      }
      if (!rawText.trim()) {
        return NextResponse.json(
          {
            ok: false,
            errors: [{ path: '(root)', message: 'Empty request body' }],
          },
          { status: 400 }
        );
      }
      let parsed: any;
      try {
        parsed = JSON.parse(rawText);
      } catch {
        return NextResponse.json(
          {
            ok: false,
            errors: [{ path: '(root)', message: 'Malformed JSON body' }],
          },
          { status: 400 }
        );
      }
      // Accept either { diagram: {...} } or direct root
      rawObj = parsed?.diagram ?? parsed;
    }

    if (!rawObj || typeof rawObj !== 'object') {
      return NextResponse.json(
        {
          ok: false,
            errors: [{ path: '(root)', message: 'No diagram JSON provided' }],
        },
        { status: 400 }
      );
    }

    const analysis = await analyzeDrawitInput(rawObj);

    // Pass through analysis object as-is.
    return NextResponse.json(analysis, { status: analysis.ok ? 200 : 400 });
  } catch (err: any) {
    console.error('[import-drawit] Unexpected error', err);
    return NextResponse.json(
      {
        ok: false,
        errors: [{ path: '(root)', message: 'Internal server error' }],
        internalMessage: process.env.NODE_ENV === 'development' ? String(err?.message || err) : undefined,
      },
      { status: 500 }
    );
  }
}
