import fs from 'node:fs/promises';
import path from 'node:path';
import { AnalyzedScreen } from './analyzer';
import { ComponentKind, ClassifiedElement } from './schema';
// Removed duplicate import of path
// NOTE: We purposefully keep dependencies minimal; we assume host app has next/link & ui components.

/**
 * Lightweight emitter utilities.
 * Goal: Provide minimal, non-breaking code generation templates.
 *
 * This does NOT attempt advanced layout intelligence yet; it keeps absolute positioning
 * to avoid unexpected restructuring. Future iterations can introduce smarter grouping.
 */

export interface EmitOptions {
  outDir: string;                 // Absolute or project-relative base (e.g. app/generated)
  projectRoot?: string;           // For manifest relative paths (optional)
  createDirs?: boolean;           // default true
  dryRun?: boolean;               // if true, do not write to disk
  routeFileName?: string;         // default 'page.tsx'
  addRouteExportComment?: boolean;
}

export interface EmittedFile {
  filePath: string;   // absolute path
  route: string;
  relPath: string;    // relative from options.outDir
  content: string;
}

export interface GenerationManifest {
  sourceHash: string;
  generatedAt: string;
  screens: {
    route: string;
    file: string;
    componentCount: number;
  }[];
  // For future diffing:
  previousHash?: string;
}

export interface EmitResult {
  files: EmittedFile[];
  manifest: GenerationManifest;
  dryRun: boolean;
  warnings: string[];
}

const DEFAULT_ROUTE_FILENAME = 'page.tsx';

/**
 * Public API: emit code for analyzed screens.
 */
export async function emitScreens(
  analyzed: AnalyzedScreen[],
  sourceHash: string,
  options: EmitOptions
): Promise<EmitResult> {
  const {
    outDir,
    createDirs = true,
    dryRun = false,
    routeFileName = DEFAULT_ROUTE_FILENAME,
    addRouteExportComment = true,
  } = options;

  const warnings: string[] = [];
  const files: EmittedFile[] = [];

  for (const screen of analyzed) {
    const route = normalizeRoute(screen.screen.route);
    const routeDir = path.join(outDir, routeToDir(route));
    const relFile = path.join(routeToDir(route), routeFileName);
    const filePath = path.join(outDir, relFile);

    if (createDirs && !dryRun) {
      await fs.mkdir(routeDir, { recursive: true });
    }

    const content = buildPageFile(screen, {
      addComment: addRouteExportComment,
      route,
    });

    files.push({
      filePath,
      route,
      relPath: relFile,
      content,
    });

    if (!dryRun) {
      await fs.writeFile(filePath, content, 'utf8');
    }
  }

  const manifest: GenerationManifest = {
    sourceHash,
    generatedAt: new Date().toISOString(),
    screens: files.map(f => ({
      route: f.route,
      file: f.relPath,
      componentCount: analyzed.find(a => normalizeRoute(a.screen.route) === f.route)?.classified.length || 0,
    })),
  };

  // Write manifest next to outDir root
  const manifestPath = path.join(outDir, '.drawit-generation-manifest.json');
  if (!dryRun) {
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  return { files, manifest, dryRun, warnings };
}

/**
 * Convert a route like '/' or '/create-goal' into directory segments.
 * '/' => '' (root inside outDir)
 */
function routeToDir(route: string): string {
  if (route === '/' || route === '') return '';
  return route.replace(/^\//, '');
}

function normalizeRoute(route: string): string {
  return route.startsWith('/') ? route : `/${route}`;
}

/**
 * Build a Next.js App Router page component.
 * Absolute positioning container replicates design coordinates.
 */
function buildPageFile(screen: AnalyzedScreen, opts: { addComment: boolean; route: string; allRoutes?: string[] }): string {
  const imports = new Set<string>();
  const bodyChildren: string[] = [];

  const needsButton = screen.classified.some(c => c.kind === 'button-primary' || c.kind === 'button-secondary');
  if (needsButton) imports.add(`import { Button } from '@/components/ui/button';`);
  // We always allow navigation if more than one route overall
  const multiRoute = (opts.allRoutes && opts.allRoutes.length > 1) ? true : false;
  if (multiRoute) imports.add(`import Link from 'next/link';`);

  // Build elements as positioned divs / components
  for (const ce of screen.classified) {
    bodyChildren.push(renderElement(ce));
  }

  // Optional simple navigation section
  let navBlock = '';
  if (multiRoute) {
    const links = (opts.allRoutes || []).map(r => {
      const label = r === '/' ? 'Home' : r.replace(/^\//, '').replace(/-/g, ' ');
      const active = r === opts.route;
      return `<Link href="${r}" className={"px-2 py-1 rounded text-xs font-medium " + (pathname === '${r}' ? 'bg-emerald-600 text-white' : 'bg-white/70 text-gray-700 hover:bg-white')}>${label}</Link>`;
    }).join('\n          ');
    navBlock = `<div className="flex gap-2 mb-4 flex-wrap">\n          { /* Simple generated navigation */ }\n          {${'typeof window !== "undefined"' } && (() => { const pathname = globalThis.location?.pathname || ''; return (<>{/* nav */}${links}</>); })()}\n        </div>`;
  }

  const importBlock = Array.from(imports).join('\n');
  const comment =
    opts.addComment
      ? `// Auto-generated from .drawit import. Route: ${opts.route}\n// DO NOT EDIT DIRECTLY (will be overwritten on regeneration)\n`
      : '';

  return `${comment}${importBlock ? importBlock + '\n\n' : ''}export default function Page() {\n  return (\n    <div className="relative w-full min-h-screen overflow-auto bg-neutral-50">\n      <div className="mx-auto p-4" style={{ maxWidth: ${Math.max(400, screen.screen.frame.width)}, minHeight: ${screen.screen.frame.height} }}>\n        ${navBlock}\n        <div className="relative border rounded-md bg-white shadow-sm" style={{ width: ${screen.screen.frame.width}, height: ${screen.screen.frame.height} }}>\n${indentLines(bodyChildren.join('\n'), 10)}\n        </div>\n      </div>\n    </div>\n  );\n}\n`;
}

/**
 * Render one classified element to JSX.
 * For MVP everything stays absolutely positioned with inline style to minimize breakage.
 * Future: map to design system components (buttons, cards, etc.)
 */
function renderElement(ce: ClassifiedElement): string {
  const n = ce.node;
  const { position: p, size: s } = n;
  const styleParts: string[] = [
    `position: 'absolute'`,
    `left: ${p.x}`,
    `top: ${p.y}`,
    `width: ${s.width}`,
    `height: ${s.height}`,
  ];
  if (n.style?.fillStyle && isRenderableColor(n.style.fillStyle)) {
    styleParts.push(`background: '${n.style.fillStyle}'`);
  }
  if (n.style?.strokeStyle && n.style.strokeStyle !== 'transparent') {
    styleParts.push(`border: '1px solid ${n.style.strokeStyle}'`);
  }
  const radius =
    n.style?.cornerRadii?.topLeft ??
    n.style?.cornerRadii?.topRight ??
    n.style?.cornerRadii?.bottomLeft ??
    n.style?.cornerRadii?.bottomRight;
  if (radius) styleParts.push(`borderRadius: ${radius}`);

  const styleObj = `{ ${styleParts.join(', ')} }`;

  switch (ce.kind) {
    case 'heading':
      return `<h1 style={${styleObj}} className="text-gray-900 font-semibold">${escapeHtml(
        n.text?.content || ''
      )}</h1>`;
    case 'paragraph':
      return `<p style={${styleObj}} className="text-gray-700">${escapeHtml(n.text?.content || '')}</p>`;
    case 'button-primary':
    case 'button-secondary': {
      const primary = ce.kind === 'button-primary';
      const variant = primary ? 'default' : 'secondary';
      return `<div style={${styleObj}} className="">
        <Button variant="${variant}" className="w-full h-full">${escapeHtml(n.text?.content || 'Action')}</Button>
      </div>`;
    }
    case 'icon':
      return `<div style={${styleObj}} className="flex items-center justify-center text-gray-600">{
        /* icon placeholder: ${n.style?.iconName || 'icon'} */
      }</div>`;
    case 'progress-bar':
      return `<div style={${styleObj}} className="bg-gray-200 overflow-hidden">
  <div className="h-full bg-emerald-500" style={{ width: '${approxProgressWidth(
    ce
  )}%' }} />
</div>`;
    case 'card':
      return `<div style={${styleObj}} className="shadow-sm" />`;
    case 'text-raw':
      return `<span style={${styleObj}} className="text-xs text-gray-600 leading-snug">${escapeHtml(
        n.text?.content || ''
      )}</span>`;
    default:
      return `<div style={${styleObj}} className="text-[10px] text-gray-400">/* ${ce.kind} */</div>`;
  }
}

/**
 * For a fill rectangle paired with its background width we could compute progress; MVP heuristic:
 */
function approxProgressWidth(_ce: ClassifiedElement): number {
  // Placeholder: future improvement could analyze sibling fill/background rectangles
  return 50;
}

function isRenderableColor(v: string): boolean {
  return /^#([0-9a-f]{3,8})$/i.test(v) || /(white|black|gray|grey|red|green|blue|emerald)/i.test(v);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>');
}

function indentLines(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .filter(Boolean)
    .map(l => pad + l)
    .join('\n');
}

/**
 * Remove previously generated pages (optional future use).
 */
export async function pruneGenerated(outDir: string, keepRoutes: string[]): Promise<void> {
  const dirents = await fs.readdir(outDir, { withFileTypes: true }).catch(() => []);
  const keepSet = new Set(keepRoutes.map(r => routeToDir(normalizeRoute(r))));
  await Promise.all(
    dirents
      .filter(d => d.isDirectory())
      .filter(d => !keepSet.has(d.name))
      .map(async d => {
        await fs.rm(path.join(outDir, d.name), { recursive: true, force: true });
      })
  );
}

/**
 * Convenience function for dry-run analysis to preview what would be written.
 */
export function previewEmit(analyzed: AnalyzedScreen[], sourceHash: string): EmitResult {
  return {
    dryRun: true,
    warnings: [],
    files: analyzed.map(s => {
      const route = normalizeRoute(s.screen.route);
      const relPath = path.join(routeToDir(route), DEFAULT_ROUTE_FILENAME);
      return {
        route,
        relPath,
        filePath: relPath,
        content: buildPageFile(s, { addComment: true, route }),
      };
    }),
    manifest: {
      sourceHash,
      generatedAt: new Date().toISOString(),
      screens: analyzed.map(s => ({
        route: normalizeRoute(s.screen.route),
        file: path.join(routeToDir(normalizeRoute(s.screen.route)), DEFAULT_ROUTE_FILENAME),
        componentCount: s.classified.length,
      })),
    },
  };
}

export const Emitter = {
  emitScreens,
  previewEmit,
  pruneGenerated,
};