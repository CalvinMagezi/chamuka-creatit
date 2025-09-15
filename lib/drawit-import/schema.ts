import { z } from 'zod';

/**
 * Minimal v0 schema for .drawit import (MVP).
 * Uses only existing dependency (zod) to avoid adding ajv right now.
 *
 * Future extensions:
 * - Support edges (type === 'edge')
 * - Richer shape taxonomy
 * - Metadata namespaces & validation
 */

export const DrawitTextSchema = z
  .object({
    content: z.string().optional(),
    fontSize: z.number().optional(),
    fontFamily: z.string().optional(),
    color: z.string().optional(),
    textAlign: z.string().optional(),
    verticalAlign: z.string().optional(),
    padding: z.number().optional(),
    lineHeight: z.number().optional(),
  })
  .partial();

export const DrawitStyleSchema = z
  .object({
    fillStyle: z.string().optional(),
    strokeStyle: z.string().optional(),
    lineWidth: z.number().optional(),
    fillOpacity: z.number().optional(),
    strokeOpacity: z.number().optional(),
    cornerRadii: z
      .object({
        topLeft: z.number().optional(),
        topRight: z.number().optional(),
        bottomRight: z.number().optional(),
        bottomLeft: z.number().optional(),
      })
      .partial()
      .optional(),
    iconProvider: z.string().optional(),
    iconName: z.string().optional(),
    iconOptions: z.record(z.any()).optional(),
  })
  .partial();

export const DrawitNodeSchema = z.object({
  id: z.string().min(1),
  type: z.literal('node'),
  shape: z.enum(['rectangle', 'icon', 'text']).optional(), // MVP accepted set
  position: z.object({
    x: z.number(),
    y: z.number(),
  }),
  size: z.object({
    width: z.number(),
    height: z.number(),
  }),
  zIndex: z.number().optional(),
  angle: z.number().optional(),
  style: DrawitStyleSchema.optional(),
  text: DrawitTextSchema.optional(),
  metadata: z.record(z.any()).optional(),
  // Ports ignored for MVP but tolerated:
  ports: z.array(z.any()).optional(),
});

export type DrawitNode = z.infer<typeof DrawitNodeSchema>;

export const DrawitElementSchema = DrawitNodeSchema; // For now only nodes (MVP)

export const DrawitRootSchema = z.object({
  fileType: z.literal('chamuka-drawit').optional(), // tolerate missing
  elements: z.array(DrawitElementSchema),
  metadata: z
    .object({
      version: z.string().optional(),
      savedAt: z.string().optional(),
      schemaVersion: z
        .object({
          major: z.number(),
          minor: z.number(),
          patch: z.number(),
        })
        .optional(),
    })
    .partial()
    .optional(),
});

export type DrawitRoot = z.infer<typeof DrawitRootSchema>;

/**
 * Public validation function.
 */
export function validateDrawitJson(input: unknown): {
  ok: boolean;
  data?: DrawitRoot;
  errors?: { path: string; message: string }[];
} {
  const result = DrawitRootSchema.safeParse(input);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map(issue => ({
        path: issue.path.join('.') || '(root)',
        message: issue.message,
      })),
    };
  }
  return { ok: true, data: result.data };
}

/**
 * Heuristic classification result types.
 */
export interface ScreenSpec {
  id: string;
  route: string;
  frame: { x: number; y: number; width: number; height: number };
  elements: DrawitNode[];
}

export type ComponentKind =
  | 'heading'
  | 'paragraph'
  | 'button-primary'
  | 'button-secondary'
  | 'icon'
  | 'progress-bar'
  | 'card'
  | 'text-raw'
  | 'unknown';

export interface ClassifiedElement {
  node: DrawitNode;
  kind: ComponentKind;
  inferredName: string;
  roleHints: string[];
}

/**
 * Normalization + basic sanitization.
 */
export function sanitizeAndNormalize(root: DrawitRoot): DrawitRoot {
  const elements = root.elements
    .filter(e => e && typeof e === 'object')
    .map(e => {
      // Strip dangerous text content
      if (e.text?.content) {
        const safe = e.text.content
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<\/?script>/gi, '')
          .replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
        e = {
          ...e,
          text: {
            ...e.text,
            content: safe,
          },
        };
      }
      return e;
    });
  return { ...root, elements };
}

/**
 * Simple hash (md5) for provenance. Uses Node crypto if available; fallback to browser subtle.
 */
export async function hashNormalized(root: DrawitRoot): Promise<string> {
  const json = JSON.stringify(root);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  try {
    const crypto = await import('crypto');
    return crypto.createHash('md5').update(json).digest('hex');
  } catch {
    // Browser fallback
    const enc = new TextEncoder().encode(json);
    const digest = await crypto.subtle.digest('MD5', enc);
    return Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

/**
 * Utility: predicate for potential screen nodes.
 */
export function isScreenCandidate(node: DrawitNode): boolean {
  if (!node.size) return false;
  const w = node.size.width;
  const h = node.size.height;
  const id = node.id.toLowerCase();
  if (id.startsWith('mobile_screen_')) return true;
  // Heuristic size bounds for a phone screen
  return w >= 320 && w <= 450 && h > 600;
}

/**
 * Infer route segment from screen id or contained heading.
 */
export function inferRoute(screen: DrawitNode, allElements: DrawitNode[]): string {
  if (screen.id === 'mobile_screen_1') return '/';
  const base = screen.id
    .replace(/^mobile_screen_/i, '')
    .replace(/[_\s]+/g, '-')
    .toLowerCase();
  if (!base || base === '1') {
    return '/' + (screen.id || 'screen').toLowerCase();
  }
  return '/' + base;
}

/**
 * Basic component classification heuristics.
 */
export function classifyNode(node: DrawitNode): ClassifiedElement {
  const txt = (node.text?.content || '').trim();
  const fontSize = node.text?.fontSize || 0;
  const fill = node.style?.fillStyle?.toLowerCase();
  const roleHints: string[] = [];
  let kind: ComponentKind = 'unknown';
  let inferredName = node.id;

  if (node.shape === 'icon' || node.style?.iconName) {
    kind = 'icon';
    inferredName = node.style?.iconName || node.id;
  } else if (txt) {
    if (fontSize >= 24) {
      kind = 'heading';
      inferredName = toPascal(txt.split(/\s+/).slice(0, 4).join(' '));
    } else if (fontSize >= 16) {
      kind = 'paragraph';
    } else {
      kind = 'text-raw';
    }
  }

  // Buttons: filled green or common action text
  if (
    node.shape === 'rectangle' &&
    txt &&
    (fill === '#4caf50' ||
      /^(add|create|save|submit|confirm|ok|start)/i.test(txt) ||
      /button/i.test(node.id))
  ) {
    kind = fill === '#4caf50' ? 'button-primary' : 'button-secondary';
    inferredName = toPascal(txt.replace(/[^a-z0-9 ]/gi, ''));
    roleHints.push('clickable');
  }

  // Progress bar: very short height (≤12px)
  if (
    node.shape === 'rectangle' &&
    node.size.height <= 14 &&
    node.size.width >= 50 &&
    !txt
  ) {
    kind = 'progress-bar';
  }

  // Card: rectangle with corner radius >= 8 & moderate size
  const cr =
    node.style?.cornerRadii?.topLeft ??
    node.style?.cornerRadii?.topRight ??
    node.style?.cornerRadii?.bottomLeft ??
    node.style?.cornerRadii?.bottomRight;
  if (
    kind === 'unknown' &&
    node.shape === 'rectangle' &&
    cr !== undefined &&
    cr >= 8 &&
    node.size.width >= 150 &&
    node.size.height >= 60
  ) {
    kind = 'card';
  }

  return { node, kind, inferredName, roleHints };
}

function toPascal(s: string): string {
  return s
    .replace(/[^a-z0-9]+/gi, ' ')
    .split(' ')
    .filter(Boolean)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join('');
}
