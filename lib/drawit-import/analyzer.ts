import { DrawitRoot, DrawitNode, validateDrawitJson, sanitizeAndNormalize, hashNormalized, isScreenCandidate, inferRoute, classifyNode, ClassifiedElement, ScreenSpec } from './schema';

/**
 * Intermediate analysis types kept intentionally lean to avoid breaking existing
 * components. These can be extended later.
 */
export interface AnalyzedScreen {
  screen: ScreenSpec;
  classified: ClassifiedElement[];
}

export interface AnalysisResult {
  ok: true;
  sourceHash: string;
  screens: AnalyzedScreen[];
  warnings: string[];
  meta: {
    elementCount: number;
    unassignedElementCount: number;
    generatedAt: string;
  };
}

export interface AnalysisErrorResult {
  ok: false;
  errors: { path: string; message: string }[];
}

export type AnalyzerResponse = AnalysisResult | AnalysisErrorResult;

/**
 * Config (MVP defaults chosen to minimize impact to existing system).
 */
const MAX_ELEMENTS = 2000; // conservative upper bound
const CONTAINMENT_PADDING = 0; // strict containment for now

/**
 * Entry point for analysis. Takes raw unknown JSON input (already parsed) and returns structured result.
 */
export async function analyzeDrawitInput(raw: unknown): Promise<AnalyzerResponse> {
  const validation = validateDrawitJson(raw);
  if (!validation.ok || !validation.data) {
    return {
      ok: false,
      errors: validation.errors || [{ path: '(root)', message: 'Unknown validation failure' }],
    };
  }
  if (validation.data.elements.length > MAX_ELEMENTS) {
    return {
      ok: false,
      errors: [{ path: 'elements', message: `Element count exceeds limit (${validation.data.elements.length} > ${MAX_ELEMENTS})` }],
    };
  }

  const normalized = sanitizeAndNormalize(validation.data);
  const sourceHash = await hashNormalized(normalized);

  const { screens, screenNodes } = extractScreens(normalized.elements);
  const assignment = assignElementsToScreens(screens, normalized.elements);

  const analyzedScreens: AnalyzedScreen[] = screens.map(screen => {
    const contained = assignment.byScreenId.get(screen.id) || [];
    const classified = contained.map(classifyNode);
    return {
      screen: {
        id: screen.id,
        route: inferRoute(screen, normalized.elements),
        frame: {
          x: screen.position.x,
            y: screen.position.y,
            width: screen.size.width,
            height: screen.size.height,
        },
        elements: contained,
      },
      classified,
    };
  });

  const warnings: string[] = [];
  if (screens.length === 0) {
    warnings.push('No screen candidates detected');
  }

  // Unassigned elements (excluding screen rectangles themselves)
  const unassigned = assignment.unassigned.filter(n => !screenNodes.has(n.id));
  if (unassigned.length > 0) {
    warnings.push(`${unassigned.length} elements not assigned to any screen`);
  }

  return {
    ok: true,
    sourceHash,
    screens: analyzedScreens,
    warnings,
    meta: {
      elementCount: normalized.elements.length,
      unassignedElementCount: unassigned.length,
      generatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Extract screen candidate nodes.
 */
function extractScreens(elements: DrawitNode[]): { screens: DrawitNode[]; screenNodes: Set<string> } {
  const screens = elements.filter(isScreenCandidate);
  return { screens, screenNodes: new Set(screens.map(s => s.id)) };
}

/**
 * Assign non-screen elements to their containing screen by geometric containment.
 * Policy: An element belongs to the screen whose bounding box fully contains its bounds.
 * If multiple screens contain (rare), choose the smallest area (most specific).
 */
function assignElementsToScreens(screens: DrawitNode[], elements: DrawitNode[]) {
  const byScreenId = new Map<string, DrawitNode[]>();
  screens.forEach(s => byScreenId.set(s.id, []));

  const screenBoxes = screens.map(s => ({
    id: s.id,
    x: s.position.x,
    y: s.position.y,
    w: s.size.width,
    h: s.size.height,
    area: s.size.width * s.size.height,
  }));

  const unassigned: DrawitNode[] = [];

  for (const el of elements) {
    if (screens.find(s => s.id === el.id)) continue; // skip screen rectangles themselves
    const elBox = {
      x: el.position.x,
      y: el.position.y,
      w: el.size.width,
      h: el.size.height,
    };

    const containing = screenBoxes.filter(sb =>
      within(elBox.x, sb.x, sb.x + sb.w) &&
      within(elBox.y, sb.y, sb.y + sb.h) &&
      within(elBox.x + elBox.w, sb.x - CONTAINMENT_PADDING, sb.x + sb.w + CONTAINMENT_PADDING) &&
      within(elBox.y + elBox.h, sb.y - CONTAINMENT_PADDING, sb.y + sb.h + CONTAINMENT_PADDING)
    );

    if (containing.length === 0) {
      unassigned.push(el);
      continue;
    }

    // Choose smallest area screen to avoid nesting ambiguity
    containing.sort((a, b) => a.area - b.area);
    const target = containing[0];
    const arr = byScreenId.get(target.id);
    if (arr) arr.push(el);
  }

  return { byScreenId, unassigned };
}

function within(v: number, min: number, max: number): boolean {
  return v >= min && v <= max;
}

/**
 * Lightweight re-export for external consumers (future emitter, API).
 */
export const Analyzer = {
  analyzeDrawitInput,
};
