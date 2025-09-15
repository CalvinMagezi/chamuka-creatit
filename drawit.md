chamuka-drawit-app/
├── app
│   ├── api
│   │   ├── diagrams
│   │   │   └── route.ts
│   │   ├── generate
│   │   │   └── route.ts
│   │   └── generate-image
│   │       └── route.ts
│   └── design
│       ├── [roomId]
│       │   ├── DiagramPageClient.tsx
│       │   └── page.tsx
│       └── page.tsx
└── convex
    ├── auth.config.js
    ├── convex.config.ts
    ├── crons.ts
    ├── diagrams.ts
    ├── init.ts
    ├── manualSync.ts
    ├── README.md
    ├── schema.ts
    ├── setup.ts
    ├── subscriptions.ts
    ├── templates.ts
    ├── tsconfig.json
    ├── usage.ts
    └── users.ts

<file path="app/api/diagrams/route.ts">
import { NextResponse } from 'next/server';

// In-memory storage for diagrams per room
const storedDiagrams = new Map<string, any>();
// SSE controllers per roomId
const sseControllersMap = new Map<
  string,
  Set<ReadableStreamDefaultController<any>>
>();
// Helper to dispatch SSE messages to all subscribers in a room
function dispatchSSE(roomId: string, data: any) {
  const controllers = sseControllersMap.get(roomId) || new Set();
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  const encoded = new TextEncoder().encode(msg);
  for (const controller of controllers) {
    controller.enqueue(encoded);
  }
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const roomId = url.searchParams.get('roomId');
  if (!roomId) {
    return NextResponse.json(
      { error: 'Missing roomId parameter' },
      { status: 400 }
    );
  }
  try {
    const { diagram } = await request.json();
    if (!diagram) {
      return NextResponse.json(
        { error: 'Missing "diagram" in request body' },
        { status: 400 }
      );
    }
    storedDiagrams.set(roomId, diagram);
    // Notify SSE clients in this room
    dispatchSSE(roomId, diagram);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const roomId = url.searchParams.get('roomId');
  if (!roomId) {
    return NextResponse.json(
      { error: 'Missing roomId parameter' },
      { status: 400 }
    );
  }
  const accept = request.headers.get('accept') || '';
  // If client subscribes via EventSource
  if (accept.includes('text/event-stream')) {
    let controllerRef: ReadableStreamDefaultController<any>;
    const controllers = sseControllersMap.get(roomId) || new Set();
    const stream = new ReadableStream({
      start(controller) {
        controllerRef = controller;
        controllers.add(controllerRef);
        sseControllersMap.set(roomId, controllers);
        // Send initial diagram
        const stored = storedDiagrams.get(roomId);
        if (stored !== undefined) {
          const initMsg = `data: ${JSON.stringify(stored)}\n\n`;
          controllerRef.enqueue(new TextEncoder().encode(initMsg));
        }
      },
      cancel() {
        const controllers = sseControllersMap.get(roomId);
        if (controllers && controllerRef) {
          controllers.delete(controllerRef);
        }
      },
    });
    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  }
  // Fallback to JSON GET
  return NextResponse.json({ diagram: storedDiagrams.get(roomId) });
}

</file>
<file path="app/api/generate/route.ts">
import { google, GoogleGenerativeAIProviderOptions } from '@ai-sdk/google';
import { openai } from '@ai-sdk/openai';
import { anthropic, AnthropicProviderOptions } from '@ai-sdk/anthropic';
import { groq } from '@ai-sdk/groq';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { streamText, CoreMessage, ImagePart, TextPart, UserContent } from 'ai';
import { TemplateId } from '@/lib/aiUtils';
import { getSystemPrompt } from '@/lib/promptUtils';
import { auth } from '@clerk/nextjs/server';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '@/convex/_generated/api';

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

// Helper to get Convex auth from Clerk
async function getConvexAuth() {
  const { getToken } = await auth();
  return await getToken({ template: 'convex' });
}

// Create a .env.local file in the chamuka-drawit-app package root:
// GOOGLE_GENERATIVE_AI_API_KEY=your_api_key
// OPENAI_API_KEY=your_api_key
// ANTHROPIC_API_KEY=your_api_key

export const runtime = 'nodejs'; // We are using Langfuse, which is not supported in Edge Runtime
// Increase max duration for potentially longer generations
export const maxDuration = 300;

// AI providers and models configuration
type Provider = 'google' | 'openai' | 'anthropic' | 'groq' | 'openrouter';

interface ModelCharacteristics {
  noSystemPrompt?: boolean;
  noThinkingConfig?: boolean;
}

interface ModelOption {
  provider: Provider;
  modelId: string;
  maxOutputTokens: number;
  defaultTemperature: number;
  characteristics?: ModelCharacteristics;
}

const AVAILABLE_MODELS: Record<string, ModelOption> = {
  'gemini-2.5-flash': {
    provider: 'google',
    modelId: 'models/gemini-2.5-flash',
    maxOutputTokens: 16000,
    defaultTemperature: 0.2,
  },
  'gemini-2.5-pro': {
    provider: 'google',
    modelId: 'models/gemini-2.5-pro',
    maxOutputTokens: 32000,
    defaultTemperature: 0.8,
  },
  'gemini-2.5-flash-lite-preview-06-17': {
    provider: 'google',
    modelId: 'models/gemini-2.5-flash-lite-preview-06-17',
    maxOutputTokens: 16000,
    defaultTemperature: 0.2,
  },
  'gemma-3-27b-it': {
    provider: 'google',
    modelId: 'models/gemma-3-27b-it',
    maxOutputTokens: 32768,
    defaultTemperature: 0.7,
    characteristics: {
      noSystemPrompt: true,
      noThinkingConfig: true,
    },
  },
  'gemma-3n-e4b-it': {
    provider: 'google',
    modelId: 'models/gemma-3n-e4b-it',
    maxOutputTokens: 16000,
    defaultTemperature: 0.2,
    characteristics: {
      noSystemPrompt: true,
      noThinkingConfig: true,
    },
  },
  'gpt-4o': {
    provider: 'openai',
    modelId: 'gpt-4o',
    maxOutputTokens: 16000,
    defaultTemperature: 0.2,
  },
  'gpt-4-1': {
    provider: 'openai',
    modelId: 'gpt-4.1',
    maxOutputTokens: 16000,
    defaultTemperature: 0.2,
  },
  'gpt-4.1-mini': {
    provider: 'openai',
    modelId: 'gpt-4.1-mini',
    maxOutputTokens: 16000,
    defaultTemperature: 0.2,
  },
  'openai-o3-mini': {
    provider: 'openai',
    modelId: 'o3-mini',
    maxOutputTokens: 16000,
    defaultTemperature: 0.2,
  },
  'openai-o3': {
    provider: 'openai',
    modelId: 'o3',
    maxOutputTokens: 16000,
    defaultTemperature: 0.2,
  },
  'openai-o4-mini': {
    provider: 'openai',
    modelId: 'o4-mini',
    maxOutputTokens: 16000,
    defaultTemperature: 0.2,
  },
  'openai-gpt-5': {
    provider: 'openai',
    modelId: 'gpt-5',
    maxOutputTokens: 32000,
    defaultTemperature: 0.2,
  },
  'openai-gpt-5-mini': {
    provider: 'openai',
    modelId: 'gpt-5-mini',
    maxOutputTokens: 32000,
    defaultTemperature: 0.2,
  },
  'openai-gpt-5-nano': {
    provider: 'openai',
    modelId: 'gpt-5-nano',
    maxOutputTokens: 32000,
    defaultTemperature: 0.2,
  },
  'claude-4-opus-20250514': {
    provider: 'anthropic',
    modelId: 'claude-4-opus-20250514',
    maxOutputTokens: 16000,
    defaultTemperature: 0.2,
  },
  'claude-4-sonnet-20250514': {
    provider: 'anthropic',
    modelId: 'claude-4-sonnet-20250514',
    maxOutputTokens: 16000,
    defaultTemperature: 0.2,
  },
  'claude-3-7-sonnet': {
    provider: 'anthropic',
    modelId: 'claude-3-7-sonnet-20250219',
    maxOutputTokens: 16000,
    defaultTemperature: 0.2,
  },
  'claude-3-5-sonnet': {
    provider: 'anthropic',
    modelId: 'claude-3-5-sonnet-20241022',
    maxOutputTokens: 8192,
    defaultTemperature: 0.2,
  },
  'claude-3-5-haiku': {
    provider: 'anthropic',
    modelId: 'claude-3-5-haiku-20241022',
    maxOutputTokens: 8192,
    defaultTemperature: 0.2,
  },
};

// Initialize OpenRouter provider instance (API key will be read from env var if not provided)
const openrouter = createOpenRouter({});

// Default model if none specified - can be overridden via environment variable
const DEFAULT_MODEL = process.env.DEFAULT_AI_MODEL || 'gemini-2.5-pro';

// --- Type Definitions ---
interface RawImageInput {
  imageData: string;
  mimeType: string;
}

interface ValidatedImage {
  data: string; // Base64 encoded data
  mimeType: string;
}

interface GenerateRequest {
  prompt: string;
  images?: RawImageInput[];
  selectedElements?: any[];
  selectionImage?: RawImageInput | null;
  model?: string;
  temperature?: number;
  template?: TemplateId;
  mode?: 'generate' | 'edit';
}

// --- Helper Functions ---

/**
 * Generates a short random alphanumeric string.
 * Not cryptographically secure, used for simple unique IDs.
 */
function generateShortId(length: number = 5): string {
  const characters =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

/**
 * Validates and prepares image data from the request.
 */
function validateAndPrepareImage(
  rawImage?: RawImageInput | null
): ValidatedImage | null {
  if (!rawImage || typeof rawImage !== 'object') return null;
  const { imageData, mimeType } = rawImage;

  if (
    !imageData ||
    !mimeType ||
    typeof imageData !== 'string' ||
    typeof mimeType !== 'string'
  ) {
    console.warn('Skipping image with missing or invalid data/mimeType.');
    return null;
  }

  let base64Data: string;
  if (imageData.startsWith('data:')) {
    const parts = imageData.split(',');
    if (parts.length !== 2 || !parts[1]) {
      console.warn(
        `Failed to extract base64 data from data URL for mime type ${mimeType}. Skipping.`
      );
      return null;
    }
    base64Data = parts[1];
  } else {
    console.warn(
      'Received imageData might not be a data URL. Attempting to use as raw base64.'
    );
    base64Data = imageData;
  }
  return { data: base64Data, mimeType };
}

function validateAndPrepareImages(
  rawImages?: RawImageInput[]
): ValidatedImage[] {
  if (!rawImages || !Array.isArray(rawImages)) {
    return [];
  }
  return rawImages
    .map(img => validateAndPrepareImage(img))
    .filter(Boolean) as ValidatedImage[];
}

/**
 * Recursively sanitize objects by removing any base64 `backgroundImageUrl` fields.
 * This prevents huge data URLs from being embedded in AI prompts.
 */
function sanitizeForAI<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map(v => sanitizeForAI(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (
        key === 'backgroundImageUrl' &&
        typeof val === 'string' &&
        /^data:/i.test(val)
      ) {
        // Skip base64 data URLs
        continue;
      }
      result[key] = sanitizeForAI(val as any);
    }
    return result as unknown as T;
  }
  return value;
}

function sanitizeSelectedElementsForAI(
  selectedElements?: any[]
): any[] | undefined {
  if (!selectedElements || !Array.isArray(selectedElements))
    return selectedElements;
  return selectedElements.map(el => sanitizeForAI(el));
}

/**
 * Creates a standardized error response.
 */
function createErrorResponse(
  logMessage: string,
  clientMessage: string,
  statusCode: number = 500
): Response {
  const errorId = generateShortId(5);
  console.error(`Error ID: ${errorId} - ${logMessage}`);
  const body = JSON.stringify({ error: `${clientMessage}. ID: ${errorId}` });
  return new Response(body, {
    status: statusCode,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Gets the appropriate AI model based on provider and model ID.
 */
function getAIModel(modelOption: ModelOption) {
  switch (modelOption.provider) {
    case 'google':
      return google(modelOption.modelId);
    case 'openai':
      return openai(modelOption.modelId);
    case 'anthropic':
      return anthropic(modelOption.modelId);
    case 'groq':
      return groq(modelOption.modelId);
    case 'openrouter':
      // Use chat() for chat models, completion() for completion models (default to chat)
      // You may extend this logic if you want to support completion models
      return openrouter.chat(modelOption.modelId);
    default:
      throw new Error(`Unsupported provider: ${modelOption.provider}`);
  }
}

/**
 * Gets provider-specific options for the AI SDK.
 */
function getProviderOptions(
  provider: Provider,
  modelConfig?: ModelOption
): any {
  if (modelConfig?.characteristics?.noThinkingConfig) {
    return {};
  }
  switch (provider) {
    case 'google':
      return {
        // Disable thinking completely for Gemini to ensure proper formatting
        thinkingConfig: {
          thinkingBudget: 2048,
        },
      } satisfies GoogleGenerativeAIProviderOptions;
    case 'openai':
      return {
        openai: {
          polling: {
            interval: 500,
          },
        },
      };
    case 'anthropic':
      return {
        thinking: { type: 'enabled', budgetTokens: 2048 },
      } satisfies AnthropicProviderOptions;
    case 'groq':
      return {};
    case 'openrouter':
      return {};
    default:
      return {};
  }
}

// --- Main API Route Handler ---
export async function POST(req: Request) {
  try {
    // Check authentication first
    const { userId } = await auth();
    if (!userId) {
      return createErrorResponse(
        'Unauthenticated request',
        'Authentication required',
        401
      );
    }

    // Check usage limits before processing
    const authToken = await getConvexAuth();
    if (!authToken) {
      return createErrorResponse(
        'Failed to get authentication token',
        'Authentication token required',
        401
      );
    }
    convex.setAuth(authToken);
    const canGenerate = await convex.query(api.usage.canGenerate);
    
    if (!canGenerate) {
      return new Response(
        JSON.stringify({
          error: 'Daily generation limit exceeded. Upgrade to Pro for unlimited generations.',
          code: 'LIMIT_EXCEEDED'
        }),
        { 
          status: 429, 
          headers: { 'Content-Type': 'application/json' } 
        }
      );
    }

    const {
      prompt: userPrompt,
      images: rawImages,
      selectedElements,
      selectionImage: rawSelectionImage,
      model: requestedModel,
      temperature: requestedTemperature,
      template: requestedTemplate = 'publishing',
      mode: requestedMode = 'generate',
    } = (await req.json()) as GenerateRequest;

    if (
      !userPrompt &&
      (!rawImages || rawImages.length === 0) &&
      !rawSelectionImage
    ) {
      return new Response(
        JSON.stringify({
          error: 'Prompt, user image(s), or a selection image is required',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Enhanced model selection logic: support 'provider:modelId' format
    let modelConfig: ModelOption;
    const modelKey = requestedModel ?? DEFAULT_MODEL;
    const providerModelMatch = modelKey.match(
      /^(google|openai|anthropic|groq|openrouter):(.+)$/
    );
    if (AVAILABLE_MODELS[modelKey]) {
      modelConfig = AVAILABLE_MODELS[modelKey];
    } else if (providerModelMatch) {
      const [, provider, modelId] = providerModelMatch;
      modelConfig = {
        provider: provider as Provider,
        modelId,
        maxOutputTokens: 16000,
        defaultTemperature: 0.2,
      };
    } else {
      return new Response(
        JSON.stringify({
          error: `Invalid or unsupported model: ${modelKey}. Use a built-in model or the 'provider:modelId' format.`,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const allRawImages = rawImages ? [...rawImages] : [];
    if (rawSelectionImage) {
      allRawImages.unshift(rawSelectionImage);
    }

    if (
      allRawImages.length > 0 &&
      modelConfig.provider === 'anthropic' &&
      modelConfig.modelId.includes('haiku')
    ) {
      return createErrorResponse(
        'Unsupported feature for model',
        'The selected Claude Haiku model does not support image input',
        400
      );
    }

    const validatedImages = validateAndPrepareImages(allRawImages);

    // Get the system prompt based on the template
    const systemPrompt = getSystemPrompt(requestedTemplate);

    const sanitizedSelectedElements =
      sanitizeSelectedElementsForAI(selectedElements);
    const userMessageContent: Array<TextPart | ImagePart> = enrichedUserPrompt(
      sanitizedSelectedElements,
      userPrompt,
      !!rawSelectionImage,
      requestedMode
    );
    validatedImages.forEach(img => {
      userMessageContent.push({
        type: 'image',
        image: img.data,
        mimeType: img.mimeType,
      } as any);
    });

    const messages: CoreMessage[] = [
      { role: 'user', content: userMessageContent as UserContent },
    ];

    const model = getAIModel(modelConfig);
    const providerOptions = getProviderOptions(
      modelConfig.provider,
      modelConfig
    );

    const temperature =
      requestedTemperature !== undefined
        ? requestedTemperature
        : modelConfig.defaultTemperature;

    // For models with noSystemPrompt, prepend the system prompt as a user message
    let finalMessages = messages;
    if (modelConfig.characteristics?.noSystemPrompt && systemPrompt) {
      finalMessages = [
        { role: 'user', content: [{ type: 'text', text: systemPrompt }] },
        ...messages,
      ];
    }

    const streamTextArgs: any = {
      model,
      messages: finalMessages,
      providerOptions,
      maxOutputTokens: modelConfig.maxOutputTokens,
      temperature,
      maxSteps: 5,
      continueSteps: true,
      onError: (error: any) => {
        console.error('Stream Error:', error);
      },
      experimental_telemetry: {
        isEnabled: true,
        functionId: 'generate-diagram',
        metadata: {
          template: requestedTemplate,
          mode: requestedMode,
          model: modelKey,
          temperature: temperature,
        },
      },
    };
    if (!modelConfig.characteristics?.noSystemPrompt) {
      streamTextArgs.system = systemPrompt;
    }

    const result = streamText(streamTextArgs);
    
    // Track the generation usage after successful request
    // Note: We track immediately on request, not on completion, to prevent abuse
    try {
      await convex.mutation(api.usage.trackAiGeneration);
    } catch (trackingError) {
      console.error('Failed to track usage:', trackingError);
      // Don't fail the request if tracking fails
    }
    
    return result.toTextStreamResponse();
  } catch (error) {
    console.error('API Route Error:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'An unexpected error occurred';
    return createErrorResponse('API route error', errorMessage);
  }
}

function enrichedUserPrompt(
  selectedElements: any[] | undefined,
  userPrompt: string,
  hasSelectionImage: boolean,
  mode: 'generate' | 'edit'
) {
  let selectionContext = '';
  if (mode === 'edit' && selectedElements && selectedElements.length > 0) {
    selectionContext = `
I have selected ${selectedElements.length} element(s) in my diagram${hasSelectionImage ? ' (an image of this selection is also provided as the first image)' : ''}:
${JSON.stringify(selectedElements, null, 2)}

Your task is to edit the diagram based on my request. You can add, update, or remove elements from the selection.

Your response must be a JSON object with a top-level "elements" key. The value of this key will be an array containing the final state of all elements that should remain from the original selection, plus any new elements to be added.

- **To UPDATE an element:** Include its full object with the changes applied in the "elements" array.
- **To ADD a new element:** Include the new element object in the "elements" array. Ensure it has a unique 'id'.
- **To REMOVE an element:** Simply omit it from the "elements" array.
- **UNCHANGED elements:** If an element from the selection is not meant to be changed, you MUST include its original, unchanged object in the "elements" array.
- **IMPORTANT for EDGES:** When adding a new edge, you MUST use a valid canonical "sourcePortId" and "targetPortId". The available canonical ports are: 'TOP', 'BOTTOM', 'LEFT', 'RIGHT', and 'CENTER'.

This way, the returned "elements" array represents the complete set of elements that should replace the original selection.

Wrap this JSON object in <chamuka-drawit> and </chamuka-drawit> tags.`;
  } else if (selectedElements && selectedElements.length > 0) {
    selectionContext = `
I have selected ${selectedElements.length} element(s) in my diagram${hasSelectionImage ? ' (an image of this selection is also provided as the first image)' : ''}:
${JSON.stringify(selectedElements, null, 2)}
Please consider these selected elements (and the provided selection image, if any) as primary context for my request. I want the generated elements to relate to, complement, or extend these selected elements.

My request: `;
  }

  const userMessageContent: Array<TextPart | ImagePart> = [];
  if (userPrompt?.trim()) {
    const importantMessage =
      '*IMPORTANT: You MUST respond ONLY in the requested format.';
    const finalUserPrompt = selectionContext
      ? `${selectionContext}${userPrompt.trim()} ${importantMessage}`
      : `${userPrompt.trim()} ${importantMessage}`;

    userMessageContent.push({ type: 'text', text: finalUserPrompt });
  } else if (hasSelectionImage && selectionContext) {
    const importantMessage =
      '*IMPORTANT: Your output MUST be valid JSON, and You MUST respond ONLY in the requested format.';
    const finalUserPrompt = `${selectionContext}Please generate new diagram elements based on the provided selection image and element data. ${importantMessage}`;
    userMessageContent.push({ type: 'text', text: finalUserPrompt });
  }

  return userMessageContent;
}

</file>
<file path="app/api/generate-image/route.ts">
export const runtime = 'nodejs';

interface GenerateImageRequest {
  prompt: string;
  width?: number;
  height?: number;
}

// Multiple image generation services as fallbacks
const IMAGE_SERVICES = [
  {
    name: 'Pollinations',
    generateUrl: (prompt: string, width: number, height: number) =>
      `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true&private=true&enhance=true&safe=true`,
  },
  {
    name: 'Placeholder',
    generateUrl: (prompt: string, width: number, height: number) =>
      `https://placehold.co/${width}x${height}/4F46E5/FFFFFF?text=${encodeURIComponent(prompt.substring(0, 20))}`,
  },
];

async function tryImageService(
  service: (typeof IMAGE_SERVICES)[0],
  prompt: string,
  width: number,
  height: number
) {
  const url = service.generateUrl(prompt, width, height);
  console.log(`Trying ${service.name} service:`, url);

  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      // Add a timeout
      signal: AbortSignal.timeout(10000), // 10 second timeout
    });

    console.log(`${service.name} response status:`, resp.status);

    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'Unknown error');
      console.error(`${service.name} API error:`, resp.status, errorText);
      throw new Error(`${service.name} failed: ${resp.status} - ${errorText}`);
    }

    const contentType = resp.headers.get('content-type') || 'image/jpeg';
    console.log(`${service.name} content type:`, contentType);

    // Assert that the image has been generated by checking the response
    const arrayBuffer = await resp.arrayBuffer();
    console.log(`${service.name} image size:`, arrayBuffer.byteLength, 'bytes');

    if (arrayBuffer.byteLength === 0) {
      throw new Error(`${service.name} returned empty image`);
    }

    // Verify it's actually an image by checking content type
    if (!contentType.startsWith('image/')) {
      throw new Error(
        `${service.name} returned non-image content: ${contentType}`
      );
    }

    // Return the original URL since we've successfully asserted the image was generated
    return { success: true, url, service: service.name };
  } catch (error) {
    console.error(`${service.name} service failed:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      service: service.name,
    };
  }
}

export async function POST(req: Request) {
  try {
    const {
      prompt,
      width = 1024,
      height = 1024,
    } = (await req.json()) as GenerateImageRequest;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return new Response(JSON.stringify({ error: 'Prompt is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Try each service in order until one succeeds
    for (const service of IMAGE_SERVICES) {
      const result = await tryImageService(
        service,
        prompt.trim(),
        width,
        height
      );

      if (result.success) {
        console.log(`Successfully generated image using ${result.service}`);
        return new Response(
          JSON.stringify({
            url: result.url,
            service: result.service,
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }

      console.log(`Failed to use ${result.service}:`, result.error);
    }

    // If all services failed, return a comprehensive error
    return new Response(
      JSON.stringify({
        error: 'All image generation services are currently unavailable',
        details:
          'Please try again later or use a different method to add images',
      }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err: any) {
    console.error('generate-image route error:', err);
    console.error('Error stack:', err.stack);
    return new Response(
      JSON.stringify({
        error: 'Failed to generate image',
        details: err.message || 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

</file>
<file path="app/design/[roomId]/DiagramPageClient.tsx">
'use client'; // Required for hooks like useAtom

import DiagramCanvas from '@/components/DiagramCanvas';
import Toolbar from '@/components/Toolbar';
import AiPanel from '@/components/AiPanel';
import PropertiesPanelRoot from '@/components/properties/PropertiesPanelRoot';
import TemplatesPanel from '@/components/TemplatesPanel';
import CopyrightNotice from '@/components/CopyrightNotice';
import ZoomControls from '@/components/ZoomControls';
import EmptyStateGuide from '@/components/EmptyStateGuide';
// import DevTools from '@/components/DevTools';
import { OnboardingGuard } from '@/components/OnboardingGuard';
import DiagramAccessGuard from '@/components/DiagramAccessGuard';
import { useAtom } from 'jotai';
import {
  diagramInstanceAtom,
  hasElementsAtom,
  isFirstTimeUserAtom,
  templatesPanelOpenAtom,
  printLayoutPagesAtom,
} from '@/lib/atoms';
import { useState, useLayoutEffect, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';

import { DiagramEvent } from '@chamuka/drawit';

import { useQuery } from 'convex/react';
import { api } from '@/convex/_generated/api';


interface DiagramPageClientProps {
  roomId: string;
  partyKitHost?: string;
  yjsWsUrl?: string;
}

export default function DiagramPageClient({
  roomId,
  partyKitHost,
  yjsWsUrl,
}: DiagramPageClientProps) {
  const [diagramInstance] = useAtom(diagramInstanceAtom);
  const [hasElements] = useAtom(hasElementsAtom);
  const [isFirstTimeUser, setIsFirstTimeUser] = useAtom(isFirstTimeUserAtom);
  const [isTemplatesOpen, setIsTemplatesOpen] = useAtom(templatesPanelOpenAtom);
  const [hydrated, setHydrated] = useState(false);
  const [, setPrintLayoutPages] = useAtom(printLayoutPagesAtom);
  
  // Load saved diagram data from Convex
  const savedDiagram = useQuery(api.diagrams.getDiagramByRoom, { roomId });

  // Debug: log when Convex query result changes (helps diagnose stale data / sync issues)
  useEffect(() => {
    if (savedDiagram) {
      console.log('[Convex] savedDiagram updated', {
        roomId,
        updatedAt: (savedDiagram as any)?.updatedAt,
        dataBytes: savedDiagram.data?.length,
      });
    } else {
      console.log('[Convex] savedDiagram is null for room', roomId);
    }
  }, [savedDiagram, roomId]);

  // Initialize first-time user from localStorage before paint to avoid flash
  useLayoutEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('chamuka-first-time-user');
      const isFirst = stored ? JSON.parse(stored) : true;
      setIsFirstTimeUser(isFirst);
    }
    setHydrated(true);
  }, [setIsFirstTimeUser, setHydrated]);

  // Track if we've already loaded to prevent re-loading
  const [hasLoadedSavedDiagram, setHasLoadedSavedDiagram] = useState(false);
  // Track last applied full snapshot (stringified) to avoid duplicate merges (causing exponential duplication)
  const lastAppliedSnapshotHashRef = useRef<string | null>(null);

  // Load saved diagram from Convex when both canvas and data are ready
  useEffect(() => {
    if (!diagramInstance || !savedDiagram || hasLoadedSavedDiagram) return;

    // Parse and load the saved diagram data from Convex
    if (savedDiagram.data) {
      try {
        console.log('Loading saved diagram from Convex:', { 
          roomId,
          dataLength: savedDiagram.data.length,
          title: savedDiagram.title 
        });
        
        const rawData = JSON.parse(savedDiagram.data);

        if (!rawData || typeof rawData !== 'object') {
          throw new Error('Invalid diagram data format');
        }

        // Normalize possible legacy shapes:
        // - Legacy: { nodes: [...], edges: [...] }
        // - Current: { elements: [...] }
        // Build elements[] if absent.
        let normalized: any = rawData;
        if (!normalized.elements) {
          const elements: any[] = [];
          if (Array.isArray(normalized.nodes)) {
            normalized.nodes.forEach((n: any) =>
              elements.push({ ...n, type: 'node' })
            );
          }
            if (Array.isArray(normalized.edges)) {
            normalized.edges.forEach((e: any) =>
              elements.push({ ...e, type: 'edge' })
            );
          }
          if (elements.length > 0) {
            normalized = { ...normalized, elements };
          }
        }

        console.log('Diagram data to load (normalized):', {
          elementsCount: Array.isArray(normalized.elements) ? normalized.elements.length : 0,
          legacyNodes: normalized.nodes?.length || 0,
          legacyEdges: normalized.edges?.length || 0,
          hasViewport: !!normalized.viewport,
        });

        diagramInstance.fromJSON(normalized, { preserveExisting: false });
        diagramInstance.emit(DiagramEvent.Redraw);
        setHasLoadedSavedDiagram(true);
        
        // Trigger a zoom to fit after loading
        setTimeout(() => {
          diagramInstance.zoomToFit();
        }, 100);
        
        // Record snapshot hash to suppress duplicate SSE re-application
        try {
          lastAppliedSnapshotHashRef.current = JSON.stringify(normalized);
        } catch {
          // ignore hash failure
        }
        console.log('Successfully loaded diagram from Convex');
      } catch (err) {
        console.error('Failed to load saved diagram from Convex:', err);
        // Still mark as loaded so sync can proceed
        setHasLoadedSavedDiagram(true);
      }
    } else {
      console.log('No saved diagram data found for room:', roomId);
      // No saved data, mark as loaded to allow sync to proceed
      setHasLoadedSavedDiagram(true);
    }
  }, [diagramInstance, savedDiagram, roomId, hasLoadedSavedDiagram]);


  // Zoom to extents when diagram is loaded or room changes
  useEffect(() => {
    if (!diagramInstance) return;

    // Small delay to ensure diagram rendering is complete
    const timeoutId = setTimeout(() => {
      try {
        diagramInstance.zoomToFit();
      } catch (error) {
        console.warn('Failed to zoom to fit:', error);
      }
    }, 100);

    return () => clearTimeout(timeoutId);
  }, [diagramInstance, roomId]);

  // Subscribe to server-sent events to receive external diagram updates
  // Only connect after initial data is loaded to avoid conflicts
  useEffect(() => {
    if (!diagramInstance || !hasLoadedSavedDiagram) return;
    
    const eventSource = new EventSource(`/api/diagrams?roomId=${roomId}`);
    eventSource.onmessage = e => {
      try {
        const incoming = JSON.parse(e.data);

        // Normalize legacy shape just in case (same logic as initial load)
        let normalizedIncoming: any = incoming;
        if (incoming && !incoming.elements) {
          const elements: any[] = [];
          if (Array.isArray(incoming.nodes)) {
            incoming.nodes.forEach((n: any) =>
              elements.push({ ...n, type: 'node' })
            );
          }
          if (Array.isArray(incoming.edges)) {
            incoming.edges.forEach((ed: any) =>
              elements.push({ ...ed, type: 'edge' })
            );
          }
          if (elements.length > 0) {
            normalizedIncoming = { ...incoming, elements };
          }
        }

        // Stringify & compare to avoid re-applying identical snapshot (which previously caused duplication
        // because merge path generated new IDs)
        let snapshotHash = '';
        try {
          snapshotHash = JSON.stringify(normalizedIncoming);
        } catch {
          // fallback: length heuristic
          snapshotHash = 'len:' + (normalizedIncoming?.elements?.length || 0);
        }
        if (snapshotHash === lastAppliedSnapshotHashRef.current) {
          // Skip duplicate
          return;
        }

        // Apply as authoritative REPLACEMENT (preserveExisting:false) so IDs are preserved;
        // this prevents duplicate copies with new IDs produced by merge logic.
        diagramInstance.fromJSON(normalizedIncoming, { preserveExisting: false });
        diagramInstance.emit(DiagramEvent.Redraw);
        lastAppliedSnapshotHashRef.current = snapshotHash;
      } catch (err) {
        console.error('Failed to apply SSE diagram update:', err);
      }
    };
    eventSource.onerror = err => {
      console.error('SSE connection error:', err);
      eventSource.close();
    };
    return () => {
      if (eventSource) {
        console.log('Closing SSE connection');
        eventSource.close();
      }
    };
  }, [diagramInstance, roomId, hasLoadedSavedDiagram]);

  useEffect(() => {
    const handler = async () => {
      if (!diagramInstance) return;
      // Get current selection
      const selectedIds = diagramInstance.model.getSelectedIds();
      if (!selectedIds || selectedIds.length === 0) return;
      try {
        // Export selection as SVG data URL with zero padding for print layout
        const dataUrl = await diagramInstance.exportSelection('svg', {
          selectionOnly: true,
          padding: 0,
          backgroundColor: 'transparent',
          format: 'svg',
        });
        // Decode data URL to raw SVG string
        let rawSvg;
        const commaIndex = dataUrl.indexOf(',');
        if (dataUrl.startsWith('data:image/svg+xml') && commaIndex !== -1) {
          rawSvg = decodeURIComponent(dataUrl.slice(commaIndex + 1));
        } else {
          rawSvg = dataUrl;
        }
        setPrintLayoutPages(pages => [
          ...pages,
          {
            id: uuidv4(),
            svg: rawSvg,
            name: `Page ${pages.length + 1}`,
            number: pages.length + 1,
            selected: false,
          },
        ]);
      } catch (error) {
        console.error('Failed to add selection as print page:', error);
        alert(
          'Failed to add selection as print page. Check console for details.'
        );
      }
    };
    window.addEventListener('diagram:add-print-page', handler);
    return () => window.removeEventListener('diagram:add-print-page', handler);
  }, [diagramInstance, setPrintLayoutPages]);

  // Define zoom handlers - these complement the library's keyboard shortcuts
  const handleZoomIn = () => {
    if (!diagramInstance) return;
    const currentZoom = diagramInstance.getZoom();
    diagramInstance.zoomAtCenter(currentZoom * 1.2);
  };

  const handleZoomOut = () => {
    if (!diagramInstance) return;
    const currentZoom = diagramInstance.getZoom();
    diagramInstance.zoomAtCenter(currentZoom / 1.2);
  };

  const handleZoomFit = () => {
    // Library's KeyboardShortcutsManager handles '0' key for this
    diagramInstance?.zoomToFit();
  };

  // Show empty state guide if no elements and first time user
  const showEmptyStateGuide = hydrated && !hasElements && isFirstTimeUser;

  return (
    <DiagramAccessGuard roomId={roomId}>
      <OnboardingGuard>
        <div className="relative w-screen h-screen overflow-hidden bg-background">
          <Toolbar roomId={roomId} />
          <ZoomControls
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            onZoomFit={handleZoomFit}
            isDiagramReady={!!diagramInstance}
          />
          <DiagramCanvas
            roomId={roomId}
            partyKitHost={partyKitHost}
            yjsWsUrl={yjsWsUrl}
            hasSavedDataLoaded={hasLoadedSavedDiagram}
          />
          {showEmptyStateGuide && <EmptyStateGuide />}
          <AiPanel />
          <PropertiesPanelRoot />
          <TemplatesPanel 
            isOpen={isTemplatesOpen} 
            onClose={() => setIsTemplatesOpen(false)}
            onOpen={() => setIsTemplatesOpen(true)}
          />
          {/* <DevTools /> */}
          <CopyrightNotice />
        </div>
      </OnboardingGuard>
    </DiagramAccessGuard>
  );
}

</file>
<file path="app/design/[roomId]/page.tsx">
import DiagramPageClient from './DiagramPageClient';

interface DiagramPageProps {
  params: Promise<{
    roomId: string;
  }>;
}

export default async function DiagramPage({ params }: DiagramPageProps) {
  const { roomId } = await params;
  // Use only server-side environment variables
  const partyKitHost = process.env.PARTYKIT_HOST;
  const yjsWsUrl = process.env.YJS_WS_URL;

  return (
    <DiagramPageClient
      roomId={roomId}
      partyKitHost={partyKitHost}
      yjsWsUrl={yjsWsUrl}
    />
  );
}

</file>
<file path="app/design/page.tsx">
import { redirect } from 'next/navigation';
import { generateRoomId } from '@/lib/room-utils';

export default function DesignIndex() {
  const roomId = generateRoomId();
  // Redirect to the dynamic room route
  redirect(`/design/${roomId}`);
}

</file>
<file path="convex/auth.config.js">
export default {
  providers: [
    {
      domain: "https://superb-sunbeam-12.clerk.accounts.dev",
      applicationID: "convex",
    },
  ],
};
</file>
<file path="convex/convex.config.ts">
import { defineApp } from "convex/server";

const app = defineApp();

export default app;
</file>
<file path="convex/crons.ts">
import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Define the cron job to reset free user usage daily at midnight
crons.daily(
  "reset free user usage",
  { hourUTC: 0, minuteUTC: 0 }, // Midnight UTC
  internal.usage.resetFreeUsersUsage
);

export default crons;
</file>
<file path="convex/diagrams.ts">
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Save or update a diagram (auto-save)
export const saveDiagram = mutation({
  args: {
    roomId: v.string(),
    title: v.optional(v.string()),
    data: v.string(),
  },
  handler: async (ctx, { roomId, title, data }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    
    if (!user) throw new Error("User not found");

    // Check if diagram already exists for this room
    const existing = await ctx.db
      .query("diagrams")
      .withIndex("by_room_id", (q) => q.eq("roomId", roomId))
      .first();

    const now = Date.now();
    const diagramTitle = title || `Diagram ${roomId.slice(0, 8)}`;

    if (existing) {
      // Update existing diagram
      await ctx.db.patch(existing._id, {
        data,
        title: diagramTitle,
        updatedAt: now,
        lastAccessed: now,
      });
      return existing._id;
    } else {
      // Create new diagram - default to public
      return await ctx.db.insert("diagrams", {
        roomId,
        title: diagramTitle,
        data,
        createdBy: user._id,
        createdAt: now,
        updatedAt: now,
        lastAccessed: now,
        isPublic: true, // Default to public
        publicAccessRole: "view", // Default public role
      });
    }
  },
});

// Get diagram by room ID
export const getDiagramByRoom = query({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    const diagram = await ctx.db
      .query("diagrams")
      .withIndex("by_room_id", (q) => q.eq("roomId", roomId))
      .first();
    
    return diagram;
  },
});

// Get user's most recent diagram
export const getMostRecentDiagram = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;

    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    
    if (!user) return null;

    // Get most recent diagram by lastAccessed timestamp, fallback to updatedAt
    const recentDiagram = await ctx.db
      .query("diagrams")
      .withIndex("by_creator_last_accessed", (q) => q.eq("createdBy", user._id))
      .order("desc")
      .first();

    return recentDiagram;
  },
});

/**
 * checkDiagramAccess
 *
 * Precedence (highest -> lowest):
 * 1. Owner (always edit)
 * 2. Explicit share (edit/view)
 * 3. Public visibility (view)
 * 4. Non-existent diagram (authenticated user allowed to create -> edit)
 * 5. Otherwise no access
 *
 * Previous implementation returned early on `isPublic`, causing owners of public
 * diagrams to receive only `view` role and appear "locked out" of their own diagrams.
 */
export const checkDiagramAccess = query({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    const identity = await ctx.auth.getUserIdentity();

    // Fetch diagram (if any)
    const diagram = await ctx.db
      .query("diagrams")
      .withIndex("by_room_id", (q) => q.eq("roomId", roomId))
      .first();

    // No diagram yet: only authenticated users may create it (treat as edit)
    if (!diagram) {
      if (!identity) return { hasAccess: false, role: null };
      return { hasAccess: true, role: "edit" };
    }

    // If authenticated, resolve user (needed to check ownership / shares)
    let user: any = null;
    if (identity) {
      user = await ctx.db
        .query("users")
        .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
        .unique();
    }

    // Owner: always edit, regardless of public/private flag
    if (user && diagram.createdBy === user._id) {
      return { hasAccess: true, role: "edit" };
    }

    // Explicit share overrides public flag (ensures correct role if downgraded)
    if (user) {
      const share = await ctx.db
        .query("diagramShares")
        .withIndex("by_diagram_user", (q) =>
          q.eq("diagramId", diagram._id).eq("userId", user._id)
        )
        .first();
      if (share) {
        return { hasAccess: true, role: share.role };
      }
    }

    // Public: anyone (including anonymous) gets configured role (default view)
    if (diagram.isPublic) {
      const pubRole = diagram.publicAccessRole || "view";
      return { hasAccess: true, role: pubRole };
    }

    // Private & not owner / not shared
    return { hasAccess: false, role: null };
  },
});

// Share diagram with a user by email
export const shareDiagram = mutation({
  args: {
    roomId: v.string(),
    userEmail: v.string(),
    role: v.union(v.literal("view"), v.literal("edit")),
  },
  handler: async (ctx, { roomId, userEmail, role }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const currentUser = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    
    if (!currentUser) throw new Error("User not found");

    // Find diagram
    const diagram = await ctx.db
      .query("diagrams")
      .withIndex("by_room_id", (q) => q.eq("roomId", roomId))
      .first();

    if (!diagram) throw new Error("Diagram not found");

    // Check if current user owns the diagram
    if (diagram.createdBy !== currentUser._id) {
      throw new Error("Only the diagram owner can share it");
    }

    // Find user to share with
    const targetUser = await ctx.db
      .query("users")
      .filter((q) => q.eq(q.field("email"), userEmail))
      .first();

    if (!targetUser) throw new Error("User not found");

    // Check if already shared
    const existingShare = await ctx.db
      .query("diagramShares")
      .withIndex("by_diagram_user", (q) => 
        q.eq("diagramId", diagram._id).eq("userId", targetUser._id)
      )
      .first();

    if (existingShare) {
      // Update role
      await ctx.db.patch(existingShare._id, { role });
      return existingShare._id;
    } else {
      // Create new share
      return await ctx.db.insert("diagramShares", {
        diagramId: diagram._id,
        userId: targetUser._id,
        role,
        sharedBy: currentUser._id,
        createdAt: Date.now(),
      });
    }
  },
});

// Get users with whom diagram is shared
export const getDiagramShares = query({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const diagram = await ctx.db
      .query("diagrams")
      .withIndex("by_room_id", (q) => q.eq("roomId", roomId))
      .first();

    if (!diagram) return [];

    const shares = await ctx.db
      .query("diagramShares")
      .withIndex("by_diagram", (q) => q.eq("diagramId", diagram._id))
      .collect();

    // Get user details for each share
    const sharesWithUsers = await Promise.all(
      shares.map(async (share) => {
        const user = await ctx.db.get(share.userId);
        return {
          ...share,
          user: user ? { name: user.name, email: user.email } : null,
        };
      })
    );

    return sharesWithUsers.filter((share) => share.user);
  },
});

// Update last accessed timestamp when user opens a diagram
export const updateLastAccessed = mutation({
  args: { roomId: v.string() },
  handler: async (ctx, { roomId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    
    if (!user) throw new Error("User not found");

    const diagram = await ctx.db
      .query("diagrams")
      .withIndex("by_room_id", (q) => q.eq("roomId", roomId))
      .first();

    if (diagram && diagram.createdBy === user._id) {
      await ctx.db.patch(diagram._id, {
        lastAccessed: Date.now(),
      });
    }
  },
});

// Get all diagrams for current user
export const getUserDiagrams = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return [];

    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    
    if (!user) return [];

    // Get all diagrams owned by user, ordered by last accessed (most recent first)
    const userDiagrams = await ctx.db
      .query("diagrams")
      .withIndex("by_creator_last_accessed", (q) => q.eq("createdBy", user._id))
      .order("desc")
      .collect();

    return userDiagrams;
  },
});

// Delete a diagram
export const deleteDiagram = mutation({
  args: { diagramId: v.id("diagrams") },
  handler: async (ctx, { diagramId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    
    if (!user) throw new Error("User not found");

    const diagram = await ctx.db.get(diagramId);
    if (!diagram) throw new Error("Diagram not found");

    // Check if current user owns the diagram
    if (diagram.createdBy !== user._id) {
      throw new Error("Only the diagram owner can delete it");
    }

    // Delete all shares for this diagram
    const shares = await ctx.db
      .query("diagramShares")
      .withIndex("by_diagram", (q) => q.eq("diagramId", diagramId))
      .collect();

    for (const share of shares) {
      await ctx.db.delete(share._id);
    }

    // Delete the diagram
    await ctx.db.delete(diagramId);
  },
});

// Remove share
export const removeShare = mutation({
  args: { roomId: v.string(), userId: v.id("users") },
  handler: async (ctx, { roomId, userId }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const currentUser = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    
    if (!currentUser) throw new Error("User not found");

    const diagram = await ctx.db
      .query("diagrams")
      .withIndex("by_room_id", (q) => q.eq("roomId", roomId))
      .first();

    if (!diagram) throw new Error("Diagram not found");

    // Check if current user owns the diagram
    if (diagram.createdBy !== currentUser._id) {
      throw new Error("Only the diagram owner can remove shares");
    }

    const share = await ctx.db
      .query("diagramShares")
      .withIndex("by_diagram_user", (q) => 
        q.eq("diagramId", diagram._id).eq("userId", userId)
      )
      .first();

    if (share) {
      await ctx.db.delete(share._id);
    }
  },
});

// Toggle diagram public/private visibility
export const toggleDiagramPublic = mutation({
  args: { roomId: v.string(), isPublic: v.boolean(), publicAccessRole: v.optional(v.union(v.literal("view"), v.literal("edit"))) },
  handler: async (ctx, { roomId, isPublic, publicAccessRole }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated");

    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();
    
    if (!user) throw new Error("User not found");

    const diagram = await ctx.db
      .query("diagrams")
      .withIndex("by_room_id", (q) => q.eq("roomId", roomId))
      .first();

    if (!diagram) throw new Error("Diagram not found");

    // Check if current user owns the diagram
    if (diagram.createdBy !== user._id) {
      throw new Error("Only the diagram owner can change visibility");
    }

    // Update visibility (and optional public access role)
    const patch: Record<string, any> = { isPublic };
    if (typeof publicAccessRole !== "undefined") {
      patch.publicAccessRole = publicAccessRole;
    }
    await ctx.db.patch(diagram._id, patch);
    
    return { isPublic, publicAccessRole: patch.publicAccessRole ?? diagram.publicAccessRole };
  },
});

</file>
<file path="convex/init.ts">
import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Initialize plan limits - run this once to set up the limits
export const initializePlanLimits = internalMutation({
  handler: async (ctx) => {
    // Check if limits already exist
    const existingLimits = await ctx.db.query("planLimits").collect();
    
    if (existingLimits.length === 0) {
      // Free plan limits
      await ctx.db.insert("planLimits", {
        plan: "free",
        dailyAiGenerations: 10, // 10 free generations per day
        features: ["basic_diagrams", "ai_generation_limited", "export_png"],
      });
      
      // Pro plan limits
      await ctx.db.insert("planLimits", {
        plan: "pro",
        dailyAiGenerations: -1, // Unlimited
        features: [
          "basic_diagrams",
          "ai_generation_unlimited",
          "export_png",
          "export_svg",
          "collaboration",
          "custom_templates",
          "priority_support",
        ],
      });
      
      console.log("Plan limits initialized successfully");
    }
  },
});
</file>
<file path="convex/manualSync.ts">
import { mutation } from "./_generated/server";
import { v } from "convex/values";

// Simple sync mutation that updates subscription based on Clerk's has() method
export const syncFromClerk = mutation({
  args: {
    plan: v.union(v.literal("free"), v.literal("pro")),
    status: v.union(v.literal("active"), v.literal("canceled"), v.literal("past_due"), v.literal("trialing"))
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // Find user by Clerk ID
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerk_id", (q) => q.eq("clerkUserId", identity.subject))
      .first();
      
    if (!user) {
      throw new Error("User not found");
    }

    // Find existing subscription
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .first();
      
    if (subscription) {
      // Update existing subscription
      await ctx.db.patch(subscription._id, {
        plan: args.plan,
        status: args.status,
        updatedAt: Date.now(),
      });
      console.log(`Updated subscription for user ${user._id}: ${args.plan} (${args.status})`);
    } else {
      // Create new subscription
      await ctx.db.insert("subscriptions", {
        userId: user._id,
        clerkUserId: identity.subject,
        plan: args.plan,
        status: args.status,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      console.log(`Created subscription for user ${user._id}: ${args.plan} (${args.status})`);
    }

    return { success: true, plan: args.plan, status: args.status };
  },
});
</file>
<file path="convex/README.md">
# Welcome to your Convex functions directory!

Write your Convex functions here.
See https://docs.convex.dev/functions for more.

A query function that takes two arguments looks like:

```ts
// convex/myFunctions.ts
import { query } from "./_generated/server";
import { v } from "convex/values";

export const myQueryFunction = query({
  // Validators for arguments.
  args: {
    first: v.number(),
    second: v.string(),
  },

  // Function implementation.
  handler: async (ctx, args) => {
    // Read the database as many times as you need here.
    // See https://docs.convex.dev/database/reading-data.
    const documents = await ctx.db.query("tablename").collect();

    // Arguments passed from the client are properties of the args object.
    console.log(args.first, args.second);

    // Write arbitrary JavaScript here: filter, aggregate, build derived data,
    // remove non-public properties, or create new objects.
    return documents;
  },
});
```

Using this query function in a React component looks like:

```ts
const data = useQuery(api.myFunctions.myQueryFunction, {
  first: 10,
  second: "hello",
});
```

A mutation function looks like:

```ts
// convex/myFunctions.ts
import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const myMutationFunction = mutation({
  // Validators for arguments.
  args: {
    first: v.string(),
    second: v.string(),
  },

  // Function implementation.
  handler: async (ctx, args) => {
    // Insert or modify documents in the database here.
    // Mutations can also read from the database like queries.
    // See https://docs.convex.dev/database/writing-data.
    const message = { body: args.first, author: args.second };
    const id = await ctx.db.insert("messages", message);

    // Optionally, return a value from your mutation.
    return await ctx.db.get(id);
  },
});
```

Using this mutation function in a React component looks like:

```ts
const mutation = useMutation(api.myFunctions.myMutationFunction);
function handleButtonPress() {
  // fire and forget, the most common way to use mutations
  mutation({ first: "Hello!", second: "me" });
  // OR
  // use the result once the mutation has completed
  mutation({ first: "Hello!", second: "me" }).then((result) =>
    console.log(result),
  );
}
```

Use the Convex CLI to push your functions to a deployment. See everything
the Convex CLI can do by running `npx convex -h` in your project root
directory. To learn more, launch the docs with `npx convex docs`.

</file>
<file path="convex/schema.ts">
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    pictureUrl: v.optional(v.string()),
    isOnline: v.optional(v.boolean()),
    lastSeen: v.optional(v.number()),
    clerkUserId: v.optional(v.string()), // Clerk User ID for linking
  })
    .index("by_token", ["tokenIdentifier"])
    .index("by_clerk_id", ["clerkUserId"]),
  
  diagrams: defineTable({
    title: v.string(),
    description: v.optional(v.string()),
    data: v.string(), // JSON serialized diagram data
    roomId: v.string(), // PartyKit room ID for real-time collaboration
    createdBy: v.id("users"),
    createdAt: v.number(),
    updatedAt: v.number(),
    lastAccessed: v.optional(v.number()), // Track when user last accessed this diagram
    isPublic: v.optional(v.boolean()),
    publicAccessRole: v.optional(v.union(v.literal("view"), v.literal("edit"))), // If public, default role for non-owner/non-shared users
  })
    .index("by_creator", ["createdBy"])
    .index("by_room_id", ["roomId"])
    .index("by_created_at", ["createdAt"])
    .index("by_creator_last_accessed", ["createdBy", "lastAccessed"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["createdBy", "isPublic"]
    }),

  // Simple sharing table for diagram access control
  diagramShares: defineTable({
    diagramId: v.id("diagrams"),
    userId: v.id("users"),
    role: v.union(v.literal("view"), v.literal("edit")),
    sharedBy: v.id("users"),
    createdAt: v.number(),
  })
    .index("by_diagram", ["diagramId"])
    .index("by_user", ["userId"])
    .index("by_diagram_user", ["diagramId", "userId"]),
  
  // Subscription management - synced from Clerk's has() method
  subscriptions: defineTable({
    userId: v.id("users"),
    clerkUserId: v.string(), // Store Clerk user ID for linking
    plan: v.union(v.literal("free"), v.literal("pro")), // Synced from Clerk billing
    status: v.union(
      v.literal("active"), 
      v.literal("canceled"), 
      v.literal("past_due"),
      v.literal("trialing")
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_clerk_user", ["clerkUserId"])
    .index("by_status", ["status"]),
  
  // Usage tracking
  usage: defineTable({
    userId: v.id("users"),
    date: v.string(), // Format: YYYY-MM-DD
    aiGenerations: v.number(), // Count of AI generations
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user_date", ["userId", "date"])
    .index("by_date", ["date"]),
  
  // Plan limits configuration
  planLimits: defineTable({
    plan: v.union(v.literal("free"), v.literal("pro")),
    dailyAiGenerations: v.number(), // -1 for unlimited
    features: v.array(v.string()), // List of enabled features
  }).index("by_plan", ["plan"]),

  // Templates for quick diagram creation
  templates: defineTable({
    title: v.string(),
    description: v.optional(v.string()),
    category: v.string(), // e.g., "proverbs", "business", "technical"
    data: v.string(), // JSON serialized diagram data
    thumbnailUrl: v.optional(v.string()), // Preview image URL
    tags: v.optional(v.array(v.string())), // Searchable tags
    isPublic: v.boolean(), // Whether template is available to all users
    createdBy: v.optional(v.id("users")), // Optional for system templates
    createdAt: v.number(),
    updatedAt: v.number(),
    usageCount: v.optional(v.number()), // Track how often template is used
  })
    .index("by_category", ["category"])
    .index("by_public", ["isPublic"])
    .index("by_creator", ["createdBy"])
    .index("by_category_public", ["category", "isPublic"])
    .searchIndex("search_templates", {
      searchField: "title",
      filterFields: ["category", "isPublic", "tags"]
    }),
});

</file>
<file path="convex/setup.ts">
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";

// One-time setup script to initialize the subscription system
export const setupSubscriptionSystem = internalMutation({
  handler: async (ctx) => {
    console.log("Starting subscription system setup...");
    
    try {
      // Initialize plan limits
      await ctx.runMutation(internal.init.initializePlanLimits);
      console.log("✅ Plan limits initialized");
      
      console.log("✅ Daily reset cron job is defined declaratively in crons.ts");
      console.log("🎉 Subscription system setup completed successfully!");
      
      return {
        success: true,
        message: "Subscription system setup completed successfully",
        timestamp: Date.now()
      };
    } catch (error) {
      console.error("❌ Setup failed:", error);
      throw error;
    }
  },
});

// Helper to check system status
export const checkSystemStatus = internalMutation({
  handler: async (ctx) => {
    const planLimits = await ctx.db.query("planLimits").collect();
    
    return {
      planLimitsConfigured: planLimits.length > 0,
      planLimits: planLimits,
      cronJobsActive: true, // Cron jobs are defined declaratively
      message: "Cron job is defined in crons.ts and managed by Convex",
      timestamp: Date.now()
    };
  },
});
</file>
<file path="convex/subscriptions.ts">
import { query } from "./_generated/server";
import { v } from "convex/values";

// Get user subscription - kept for backwards compatibility
export const getSubscription = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }
    
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .first();
      
    if (!user) {
      return null;
    }
    
    return await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .first();
  },
});

// Check if user has access to a feature - simplified
export const hasFeature = query({
  args: { feature: v.string() },
  handler: async (ctx, { feature }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return false;
    }
    
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .first();
      
    if (!user) {
      return false;
    }
    
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .first();
      
    if (!subscription || subscription.status !== "active") {
      // Default to free plan features
      const freePlanLimits = await ctx.db
        .query("planLimits")
        .withIndex("by_plan", (q) => q.eq("plan", "free"))
        .first();
        
      return freePlanLimits?.features.includes(feature) ?? false;
    }
    
    const planLimits = await ctx.db
      .query("planLimits")
      .withIndex("by_plan", (q) => q.eq("plan", subscription.plan))
      .first();
      
    return planLimits?.features.includes(feature) ?? false;
  },
});
</file>
<file path="convex/templates.ts">
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

// Get all public templates
export const getPublicTemplates = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("templates")
      .withIndex("by_public", (q) => q.eq("isPublic", true))
      .order("desc")
      .collect();
  },
});

// Get templates by category
export const getTemplatesByCategory = query({
  args: { category: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("templates")
      .withIndex("by_category_public", (q) => 
        q.eq("category", args.category).eq("isPublic", true)
      )
      .order("desc")
      .collect();
  },
});

// Get all categories
export const getTemplateCategories = query({
  args: {},
  handler: async (ctx) => {
    const templates = await ctx.db
      .query("templates")
      .withIndex("by_public", (q) => q.eq("isPublic", true))
      .collect();
    
    const categories = [...new Set(templates.map(t => t.category))];
    const categoryCounts = categories.map(category => ({
      name: category,
      count: templates.filter(t => t.category === category).length
    }));
    
    return categoryCounts.sort((a, b) => b.count - a.count);
  },
});

// Search templates
export const searchTemplates = query({
  args: { 
    searchTerm: v.string(),
    category: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    let results = await ctx.db
      .query("templates")
      .withSearchIndex("search_templates", (q) =>
        q.search("title", args.searchTerm)
      )
      .collect();
    
    // Filter by category if specified
    if (args.category) {
      results = results.filter(t => t.category === args.category);
    }
    
    // Only return public templates
    return results.filter(t => t.isPublic);
  },
});

// Create a new template
export const createTemplate = mutation({
  args: {
    title: v.string(),
    description: v.optional(v.string()),
    category: v.string(),
    data: v.string(),
    thumbnailUrl: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    isPublic: v.boolean(),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Must be authenticated to create template");
    }

    // Get or create user
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    const templateId = await ctx.db.insert("templates", {
      title: args.title,
      description: args.description,
      category: args.category,
      data: args.data,
      thumbnailUrl: args.thumbnailUrl,
      tags: args.tags,
      isPublic: args.isPublic,
      createdBy: user._id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usageCount: 0,
    });

    return templateId;
  },
});

// Update template usage count
export const incrementTemplateUsage = mutation({
  args: { templateId: v.id("templates") },
  handler: async (ctx, args) => {
    const template = await ctx.db.get(args.templateId);
    if (!template) {
      throw new Error("Template not found");
    }

    await ctx.db.patch(args.templateId, {
      usageCount: (template.usageCount ?? 0) + 1,
      updatedAt: Date.now(),
    });
  },
});

// Seed initial templates (for development/admin use)
export const seedTemplates = mutation({
  args: {},
  handler: async (ctx) => {
    // Check if templates already exist
    const existingTemplates = await ctx.db
      .query("templates")
      .withIndex("by_public", (q) => q.eq("isPublic", true))
      .collect();

    if (existingTemplates.length > 0) {
      return { message: "Templates already seeded", count: existingTemplates.length };
    }

    // Define high-quality templates with proper structure
    const sampleTemplates = [
      {
        title: "Project Management Dashboard",
        description: "Comprehensive project tracking with tasks, timeline, and team members",
        category: "business",
        data: JSON.stringify({
          elements: [
            // Header Section
            {
              id: "dashboard-header",
              type: "node",
              position: { x: 50, y: 30 },
              angle: 0,
              zIndex: 0,
              style: {
                fillStyle: "#1E40AF",
                fillOpacity: 1,
                strokeStyle: "#1D4ED8",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 700, height: 80 },
              shape: "rectangle",
              text: {
                content: "PROJECT ATLAS - Q4 2024",
                fontSize: 24,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 16,
                lineHeight: 1.2
              }
            },
            // Status Cards
            {
              id: "active-tasks",
              type: "node",
              position: { x: 70, y: 140 },
              angle: 0,
              zIndex: 1,
              style: {
                fillStyle: "#10B981",
                fillOpacity: 1,
                strokeStyle: "#059669",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 150, height: 100 },
              shape: "rectangle",
              text: {
                content: "ACTIVE\n\n23 Tasks",
                fontSize: 16,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 12,
                lineHeight: 1.4
              }
            },
            {
              id: "completed-tasks",
              type: "node",
              position: { x: 250, y: 140 },
              angle: 0,
              zIndex: 2,
              style: {
                fillStyle: "#3B82F6",
                fillOpacity: 1,
                strokeStyle: "#2563EB",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 150, height: 100 },
              shape: "rectangle",
              text: {
                content: "COMPLETED\n\n47 Tasks",
                fontSize: 16,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 12,
                lineHeight: 1.4
              }
            },
            {
              id: "blocked-tasks",
              type: "node",
              position: { x: 430, y: 140 },
              angle: 0,
              zIndex: 3,
              style: {
                fillStyle: "#EF4444",
                fillOpacity: 1,
                strokeStyle: "#DC2626",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 150, height: 100 },
              shape: "rectangle",
              text: {
                content: "BLOCKED\n\n5 Tasks",
                fontSize: 16,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 12,
                lineHeight: 1.4
              }
            },
            {
              id: "review-tasks",
              type: "node",
              position: { x: 610, y: 140 },
              angle: 0,
              zIndex: 4,
              style: {
                fillStyle: "#F59E0B",
                fillOpacity: 1,
                strokeStyle: "#D97706",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 150, height: 100 },
              shape: "rectangle",
              text: {
                content: "REVIEW\n\n12 Tasks",
                fontSize: 16,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 12,
                lineHeight: 1.4
              }
            },
            // Timeline Section
            {
              id: "timeline-header",
              type: "node",
              position: { x: 70, y: 280 },
              angle: 0,
              zIndex: 5,
              style: {
                fillStyle: "#6B7280",
                fillOpacity: 1,
                strokeOpacity: 0
              },
              size: { width: 200, height: 40 },
              shape: "rectangle",
              text: {
                content: "PROJECT TIMELINE",
                fontSize: 16,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            },
            // Timeline milestones
            {
              id: "milestone-1",
              type: "node",
              position: { x: 70, y: 340 },
              angle: 0,
              zIndex: 6,
              style: {
                fillStyle: "#DBEAFE",
                fillOpacity: 1,
                strokeStyle: "#3B82F6",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 160, height: 60 },
              shape: "rectangle",
              text: {
                content: "Phase 1 Complete\nDec 15, 2024",
                fontSize: 12,
                fontFamily: "inter",
                color: "#1E40AF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "milestone-2",
              type: "node",
              position: { x: 250, y: 340 },
              angle: 0,
              zIndex: 7,
              style: {
                fillStyle: "#FEF3C7",
                fillOpacity: 1,
                strokeStyle: "#F59E0B",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 160, height: 60 },
              shape: "rectangle",
              text: {
                content: "Phase 2 Review\nJan 10, 2025",
                fontSize: 12,
                fontFamily: "inter",
                color: "#92400E",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "milestone-3",
              type: "node",
              position: { x: 430, y: 340 },
              angle: 0,
              zIndex: 8,
              style: {
                fillStyle: "#DCFCE7",
                fillOpacity: 1,
                strokeStyle: "#16A34A",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 160, height: 60 },
              shape: "rectangle",
              text: {
                content: "Final Release\nFeb 1, 2025",
                fontSize: 12,
                fontFamily: "inter",
                color: "#15803D",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            // Team section
            {
              id: "team-header",
              type: "node",
              position: { x: 70, y: 440 },
              angle: 0,
              zIndex: 9,
              style: {
                fillStyle: "#6B7280",
                fillOpacity: 1,
                strokeOpacity: 0
              },
              size: { width: 200, height: 40 },
              shape: "rectangle",
              text: {
                content: "TEAM MEMBERS",
                fontSize: 16,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            },
            {
              id: "team-dev",
              type: "node",
              position: { x: 70, y: 500 },
              angle: 0,
              zIndex: 10,
              style: {
                fillStyle: "#8B5CF6",
                fillOpacity: 1,
                strokeStyle: "#7C3AED",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 80 },
              shape: "ellipse",
              text: {
                content: "Sarah K.\nLead Dev",
                fontSize: 12,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "team-design",
              type: "node",
              position: { x: 220, y: 500 },
              angle: 0,
              zIndex: 11,
              style: {
                fillStyle: "#EC4899",
                fillOpacity: 1,
                strokeStyle: "#DB2777",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 80 },
              shape: "ellipse",
              text: {
                content: "Mike R.\nUI/UX",
                fontSize: 12,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "team-pm",
              type: "node",
              position: { x: 370, y: 500 },
              angle: 0,
              zIndex: 12,
              style: {
                fillStyle: "#14B8A6",
                fillOpacity: 1,
                strokeStyle: "#0F766E",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 80 },
              shape: "ellipse",
              text: {
                content: "Alex T.\nProject Mgr",
                fontSize: 12,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            }
          ]
        }),
        tags: ["project", "dashboard", "management", "timeline", "team"],
        isPublic: true,
      },
      {
        title: "Software Architecture Diagram",
        description: "Complete system architecture with microservices, databases, and API gateways",
        category: "technical",
        data: JSON.stringify({
          elements: [
            // Client Layer
            {
              id: "web-client",
              type: "node",
              position: { x: 50, y: 50 },
              angle: 0,
              zIndex: 0,
              style: {
                fillStyle: "#EFF6FF",
                fillOpacity: 1,
                strokeStyle: "#3B82F6",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 140, height: 80 },
              shape: "rectangle",
              text: {
                content: "Web Client\nReact App",
                fontSize: 14,
                fontFamily: "inter",
                color: "#1E40AF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            },
            {
              id: "mobile-client",
              type: "node",
              position: { x: 220, y: 50 },
              angle: 0,
              zIndex: 1,
              style: {
                fillStyle: "#F0F9FF",
                fillOpacity: 1,
                strokeStyle: "#0EA5E9",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 140, height: 80 },
              shape: "rectangle",
              text: {
                content: "Mobile Client\nFlutter App",
                fontSize: 14,
                fontFamily: "inter",
                color: "#0C4A6E",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            },
            // API Gateway
            {
              id: "api-gateway",
              type: "node",
              position: { x: 135, y: 180 },
              angle: 0,
              zIndex: 2,
              style: {
                fillStyle: "#FEF3C7",
                fillOpacity: 1,
                strokeStyle: "#F59E0B",
                strokeOpacity: 1,
                lineWidth: 3
              },
              size: { width: 200, height: 70 },
              shape: "rectangle",
              text: {
                content: "API Gateway\nLoad Balancer & Auth",
                fontSize: 16,
                fontFamily: "inter",
                color: "#92400E",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            },
            // Microservices Layer
            {
              id: "user-service",
              type: "node",
              position: { x: 50, y: 300 },
              angle: 0,
              zIndex: 3,
              style: {
                fillStyle: "#DCFCE7",
                fillOpacity: 1,
                strokeStyle: "#16A34A",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 90 },
              shape: "rectangle",
              text: {
                content: "User Service\n\nAuthentication\nProfiles\nPermissions",
                fontSize: 12,
                fontFamily: "inter",
                color: "#15803D",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "order-service",
              type: "node",
              position: { x: 190, y: 300 },
              angle: 0,
              zIndex: 4,
              style: {
                fillStyle: "#DBEAFE",
                fillOpacity: 1,
                strokeStyle: "#2563EB",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 90 },
              shape: "rectangle",
              text: {
                content: "Order Service\n\nOrder Processing\nPayments\nInvoices",
                fontSize: 12,
                fontFamily: "inter",
                color: "#1D4ED8",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "notification-service",
              type: "node",
              position: { x: 330, y: 300 },
              angle: 0,
              zIndex: 5,
              style: {
                fillStyle: "#FDE7F3",
                fillOpacity: 1,
                strokeStyle: "#EC4899",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 90 },
              shape: "rectangle",
              text: {
                content: "Notification\nService\n\nEmail/SMS\nPush Alerts\nWebhooks",
                fontSize: 12,
                fontFamily: "inter",
                color: "#BE185D",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            // Database Layer
            {
              id: "user-db",
              type: "node",
              position: { x: 50, y: 440 },
              angle: 0,
              zIndex: 6,
              style: {
                fillStyle: "#E5E7EB",
                fillOpacity: 1,
                strokeStyle: "#6B7280",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 100, height: 60 },
              shape: "rectangle",
              text: {
                content: "User DB\nPostgreSQL",
                fontSize: 11,
                fontFamily: "inter",
                color: "#374151",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 6,
                lineHeight: 1.3
              }
            },
            {
              id: "order-db",
              type: "node",
              position: { x: 170, y: 440 },
              angle: 0,
              zIndex: 7,
              style: {
                fillStyle: "#E5E7EB",
                fillOpacity: 1,
                strokeStyle: "#6B7280",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 100, height: 60 },
              shape: "rectangle",
              text: {
                content: "Order DB\nMongoDB",
                fontSize: 11,
                fontFamily: "inter",
                color: "#374151",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 6,
                lineHeight: 1.3
              }
            },
            {
              id: "cache-layer",
              type: "node",
              position: { x: 290, y: 440 },
              angle: 0,
              zIndex: 8,
              style: {
                fillStyle: "#FEE2E2",
                fillOpacity: 1,
                strokeStyle: "#EF4444",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 100, height: 60 },
              shape: "rectangle",
              text: {
                content: "Cache\nRedis",
                fontSize: 11,
                fontFamily: "inter",
                color: "#DC2626",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 6,
                lineHeight: 1.3
              }
            },
            // External Services
            {
              id: "payment-gateway",
              type: "node",
              position: { x: 480, y: 200 },
              angle: 0,
              zIndex: 9,
              style: {
                fillStyle: "#F3E8FF",
                fillOpacity: 1,
                strokeStyle: "#8B5CF6",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 140, height: 80 },
              shape: "rectangle",
              text: {
                content: "Payment Gateway\nStripe API",
                fontSize: 14,
                fontFamily: "inter",
                color: "#7C3AED",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            },
            {
              id: "analytics",
              type: "node",
              position: { x: 480, y: 320 },
              angle: 0,
              zIndex: 10,
              style: {
                fillStyle: "#FBBF24",
                fillOpacity: 0.2,
                strokeStyle: "#F59E0B",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 140, height: 80 },
              shape: "rectangle",
              text: {
                content: "Analytics\nGoogle Analytics",
                fontSize: 14,
                fontFamily: "inter",
                color: "#92400E",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            }
          ]
        }),
        tags: ["architecture", "microservices", "system-design", "technical", "database"],
        isPublic: true,
      },
      {
        title: "Product Launch Strategy",
        description: "Comprehensive product launch plan with market analysis, timeline, and metrics",
        category: "business",
        data: JSON.stringify({
          elements: [
            // Header
            {
              id: "launch-header",
              type: "node",
              position: { x: 50, y: 30 },
              angle: 0,
              zIndex: 0,
              style: {
                fillStyle: "#7C3AED",
                fillOpacity: 1,
                strokeStyle: "#6D28D9",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 600, height: 70 },
              shape: "rectangle",
              text: {
                content: "PRODUCT LAUNCH STRATEGY: NOVA APP",
                fontSize: 22,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 16,
                lineHeight: 1.2
              }
            },
            // Market Analysis Section
            {
              id: "market-header",
              type: "node",
              position: { x: 60, y: 130 },
              angle: 0,
              zIndex: 1,
              style: {
                fillStyle: "#1F2937",
                fillOpacity: 1,
                strokeOpacity: 0
              },
              size: { width: 200, height: 40 },
              shape: "rectangle",
              text: {
                content: "MARKET ANALYSIS",
                fontSize: 14,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            },
            {
              id: "target-audience",
              type: "node",
              position: { x: 60, y: 180 },
              angle: 0,
              zIndex: 2,
              style: {
                fillStyle: "#DBEAFE",
                fillOpacity: 1,
                strokeStyle: "#3B82F6",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 160, height: 90 },
              shape: "rectangle",
              text: {
                content: "Target Audience\n\n• Tech professionals\n• 25-45 years old\n• $50K+ income",
                fontSize: 11,
                fontFamily: "inter",
                color: "#1E40AF",
                textAlign: "left",
                verticalAlign: "top",
                padding: 12,
                lineHeight: 1.4
              }
            },
            {
              id: "competitive-analysis",
              type: "node",
              position: { x: 240, y: 180 },
              angle: 0,
              zIndex: 3,
              style: {
                fillStyle: "#FEF3C7",
                fillOpacity: 1,
                strokeStyle: "#F59E0B",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 160, height: 90 },
              shape: "rectangle",
              text: {
                content: "Competitive Analysis\n\n• Competitor A: 40%\n• Competitor B: 25%\n• Market gap: 35%",
                fontSize: 11,
                fontFamily: "inter",
                color: "#92400E",
                textAlign: "left",
                verticalAlign: "top",
                padding: 12,
                lineHeight: 1.4
              }
            },
            // Launch Timeline
            {
              id: "timeline-header",
              type: "node",
              position: { x: 450, y: 130 },
              angle: 0,
              zIndex: 4,
              style: {
                fillStyle: "#1F2937",
                fillOpacity: 1,
                strokeOpacity: 0
              },
              size: { width: 200, height: 40 },
              shape: "rectangle",
              text: {
                content: "LAUNCH TIMELINE",
                fontSize: 14,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            },
            {
              id: "phase-1",
              type: "node",
              position: { x: 420, y: 180 },
              angle: 0,
              zIndex: 5,
              style: {
                fillStyle: "#DCFCE7",
                fillOpacity: 1,
                strokeStyle: "#16A34A",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 100, height: 70 },
              shape: "rectangle",
              text: {
                content: "Pre-Launch\nWeek -4",
                fontSize: 12,
                fontFamily: "inter",
                color: "#15803D",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "phase-2",
              type: "node",
              position: { x: 535, y: 180 },
              angle: 0,
              zIndex: 6,
              style: {
                fillStyle: "#FEF3C7",
                fillOpacity: 1,
                strokeStyle: "#F59E0B",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 100, height: 70 },
              shape: "rectangle",
              text: {
                content: "Launch Day\nWeek 0",
                fontSize: 12,
                fontFamily: "inter",
                color: "#92400E",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "phase-3",
              type: "node",
              position: { x: 420, y: 270 },
              angle: 0,
              zIndex: 7,
              style: {
                fillStyle: "#DBEAFE",
                fillOpacity: 1,
                strokeStyle: "#3B82F6",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 100, height: 70 },
              shape: "rectangle",
              text: {
                content: "Post-Launch\nWeek +2",
                fontSize: 12,
                fontFamily: "inter",
                color: "#1E40AF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "phase-4",
              type: "node",
              position: { x: 535, y: 270 },
              angle: 0,
              zIndex: 8,
              style: {
                fillStyle: "#FDE7F3",
                fillOpacity: 1,
                strokeStyle: "#EC4899",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 100, height: 70 },
              shape: "rectangle",
              text: {
                content: "Optimization\nWeek +4",
                fontSize: 12,
                fontFamily: "inter",
                color: "#BE185D",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            // Marketing Channels
            {
              id: "marketing-header",
              type: "node",
              position: { x: 60, y: 310 },
              angle: 0,
              zIndex: 9,
              style: {
                fillStyle: "#1F2937",
                fillOpacity: 1,
                strokeOpacity: 0
              },
              size: { width: 200, height: 40 },
              shape: "rectangle",
              text: {
                content: "MARKETING CHANNELS",
                fontSize: 14,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            },
            {
              id: "social-media",
              type: "node",
              position: { x: 60, y: 360 },
              angle: 0,
              zIndex: 10,
              style: {
                fillStyle: "#FDE7F3",
                fillOpacity: 1,
                strokeStyle: "#EC4899",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 80 },
              shape: "ellipse",
              text: {
                content: "Social Media\n\nInstagram\nTwitter\nLinkedIn",
                fontSize: 11,
                fontFamily: "inter",
                color: "#BE185D",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "content-marketing",
              type: "node",
              position: { x: 200, y: 360 },
              angle: 0,
              zIndex: 11,
              style: {
                fillStyle: "#F0F9FF",
                fillOpacity: 1,
                strokeStyle: "#0EA5E9",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 80 },
              shape: "ellipse",
              text: {
                content: "Content Mktg\n\nBlog Posts\nYouTube\nPodcasts",
                fontSize: 11,
                fontFamily: "inter",
                color: "#0C4A6E",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "paid-ads",
              type: "node",
              position: { x: 340, y: 360 },
              angle: 0,
              zIndex: 12,
              style: {
                fillStyle: "#FEF3C7",
                fillOpacity: 1,
                strokeStyle: "#F59E0B",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 80 },
              shape: "ellipse",
              text: {
                content: "Paid Advertising\n\nGoogle Ads\nFacebook\nPPC",
                fontSize: 11,
                fontFamily: "inter",
                color: "#92400E",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            // Success Metrics
            {
              id: "metrics-header",
              type: "node",
              position: { x: 60, y: 470 },
              angle: 0,
              zIndex: 13,
              style: {
                fillStyle: "#1F2937",
                fillOpacity: 1,
                strokeOpacity: 0
              },
              size: { width: 200, height: 40 },
              shape: "rectangle",
              text: {
                content: "SUCCESS METRICS",
                fontSize: 14,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            },
            {
              id: "downloads-metric",
              type: "node",
              position: { x: 60, y: 520 },
              angle: 0,
              zIndex: 14,
              style: {
                fillStyle: "#10B981",
                fillOpacity: 1,
                strokeStyle: "#059669",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 60 },
              shape: "rectangle",
              text: {
                content: "Downloads\n10K in Month 1",
                fontSize: 12,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "revenue-metric",
              type: "node",
              position: { x: 200, y: 520 },
              angle: 0,
              zIndex: 15,
              style: {
                fillStyle: "#3B82F6",
                fillOpacity: 1,
                strokeStyle: "#2563EB",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 60 },
              shape: "rectangle",
              text: {
                content: "Revenue\n$50K MRR",
                fontSize: 12,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "retention-metric",
              type: "node",
              position: { x: 340, y: 520 },
              angle: 0,
              zIndex: 16,
              style: {
                fillStyle: "#8B5CF6",
                fillOpacity: 1,
                strokeStyle: "#7C3AED",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 60 },
              shape: "rectangle",
              text: {
                content: "Retention\n70% Day-30",
                fontSize: 12,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            }
          ]
        }),
        tags: ["launch", "strategy", "marketing", "business", "metrics"],
        isPublic: true,
      },
      {
        title: "User Journey Mapping",
        description: "Complete user experience flow from awareness to retention with touchpoints",
        category: "design",
        data: JSON.stringify({
          elements: [
            // Header
            {
              id: "journey-header",
              type: "node",
              position: { x: 50, y: 30 },
              angle: 0,
              zIndex: 0,
              style: {
                fillStyle: "#EC4899",
                fillOpacity: 1,
                strokeStyle: "#DB2777",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 650, height: 70 },
              shape: "rectangle",
              text: {
                content: "USER JOURNEY MAP: E-COMMERCE MOBILE APP",
                fontSize: 20,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 16,
                lineHeight: 1.2
              }
            },
            // Journey Stages
            {
              id: "awareness-stage",
              type: "node",
              position: { x: 60, y: 130 },
              angle: 0,
              zIndex: 1,
              style: {
                fillStyle: "#FEF3C7",
                fillOpacity: 1,
                strokeStyle: "#F59E0B",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 180 },
              shape: "rectangle",
              text: {
                content: "AWARENESS\n\n📱 Social Media\n🔍 Search Engine\n📺 Advertisement\n👥 Word of Mouth\n\nEmotion: Curious\nGoal: Learn more",
                fontSize: 10,
                fontFamily: "inter",
                color: "#92400E",
                textAlign: "center",
                verticalAlign: "top",
                padding: 12,
                lineHeight: 1.4
              }
            },
            {
              id: "consideration-stage",
              type: "node",
              position: { x: 200, y: 130 },
              angle: 0,
              zIndex: 2,
              style: {
                fillStyle: "#DBEAFE",
                fillOpacity: 1,
                strokeStyle: "#3B82F6",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 180 },
              shape: "rectangle",
              text: {
                content: "CONSIDERATION\n\n🌐 Website Visit\n📖 Read Reviews\n⚖️ Compare Features\n💰 Check Pricing\n\nEmotion: Interested\nGoal: Evaluate options",
                fontSize: 10,
                fontFamily: "inter",
                color: "#1E40AF",
                textAlign: "center",
                verticalAlign: "top",
                padding: 12,
                lineHeight: 1.4
              }
            },
            {
              id: "purchase-stage",
              type: "node",
              position: { x: 340, y: 130 },
              angle: 0,
              zIndex: 3,
              style: {
                fillStyle: "#DCFCE7",
                fillOpacity: 1,
                strokeStyle: "#16A34A",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 180 },
              shape: "rectangle",
              text: {
                content: "PURCHASE\n\n📥 Download App\n👤 Create Account\n💳 Add Payment\n🛒 First Order\n\nEmotion: Excited\nGoal: Complete purchase",
                fontSize: 10,
                fontFamily: "inter",
                color: "#15803D",
                textAlign: "center",
                verticalAlign: "top",
                padding: 12,
                lineHeight: 1.4
              }
            },
            {
              id: "onboarding-stage",
              type: "node",
              position: { x: 480, y: 130 },
              angle: 0,
              zIndex: 4,
              style: {
                fillStyle: "#F3E8FF",
                fillOpacity: 1,
                strokeStyle: "#8B5CF6",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 180 },
              shape: "rectangle",
              text: {
                content: "ONBOARDING\n\n🎯 Tutorial Tour\n📋 Profile Setup\n🎁 Welcome Bonus\n📧 Email Series\n\nEmotion: Learning\nGoal: Get started",
                fontSize: 10,
                fontFamily: "inter",
                color: "#7C3AED",
                textAlign: "center",
                verticalAlign: "top",
                padding: 12,
                lineHeight: 1.4
              }
            },
            {
              id: "retention-stage",
              type: "node",
              position: { x: 620, y: 130 },
              angle: 0,
              zIndex: 5,
              style: {
                fillStyle: "#FDE7F3",
                fillOpacity: 1,
                strokeStyle: "#EC4899",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 120, height: 180 },
              shape: "rectangle",
              text: {
                content: "RETENTION\n\n🔔 Push Notifications\n💌 Email Campaigns\n🎉 Loyalty Program\n🆕 Feature Updates\n\nEmotion: Satisfied\nGoal: Stay engaged",
                fontSize: 10,
                fontFamily: "inter",
                color: "#BE185D",
                textAlign: "center",
                verticalAlign: "top",
                padding: 12,
                lineHeight: 1.4
              }
            },
            // Pain Points Row
            {
              id: "pain-points-header",
              type: "node",
              position: { x: 60, y: 340 },
              angle: 0,
              zIndex: 6,
              style: {
                fillStyle: "#EF4444",
                fillOpacity: 1,
                strokeStyle: "#DC2626",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 680, height: 40 },
              shape: "rectangle",
              text: {
                content: "PAIN POINTS & SOLUTIONS",
                fontSize: 16,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            },
            // Pain Point Details
            {
              id: "pain-awareness",
              type: "node",
              position: { x: 60, y: 400 },
              angle: 0,
              zIndex: 7,
              style: {
                fillStyle: "#FEE2E2",
                fillOpacity: 1,
                strokeStyle: "#EF4444",
                strokeOpacity: 1,
                lineWidth: 1
              },
              size: { width: 120, height: 80 },
              shape: "rectangle",
              text: {
                content: "❌ Low brand awareness\n\n✅ Increase ad spend\n✅ Influencer partnerships",
                fontSize: 9,
                fontFamily: "inter",
                color: "#DC2626",
                textAlign: "left",
                verticalAlign: "top",
                padding: 10,
                lineHeight: 1.3
              }
            },
            {
              id: "pain-consideration",
              type: "node",
              position: { x: 200, y: 400 },
              angle: 0,
              zIndex: 8,
              style: {
                fillStyle: "#FEE2E2",
                fillOpacity: 1,
                strokeStyle: "#EF4444",
                strokeOpacity: 1,
                lineWidth: 1
              },
              size: { width: 120, height: 80 },
              shape: "rectangle",
              text: {
                content: "❌ Complex pricing\n\n✅ Simplify tiers\n✅ Clear comparisons",
                fontSize: 9,
                fontFamily: "inter",
                color: "#DC2626",
                textAlign: "left",
                verticalAlign: "top",
                padding: 10,
                lineHeight: 1.3
              }
            },
            {
              id: "pain-purchase",
              type: "node",
              position: { x: 340, y: 400 },
              angle: 0,
              zIndex: 9,
              style: {
                fillStyle: "#FEE2E2",
                fillOpacity: 1,
                strokeStyle: "#EF4444",
                strokeOpacity: 1,
                lineWidth: 1
              },
              size: { width: 120, height: 80 },
              shape: "rectangle",
              text: {
                content: "❌ Checkout friction\n\n✅ One-click payment\n✅ Guest checkout",
                fontSize: 9,
                fontFamily: "inter",
                color: "#DC2626",
                textAlign: "left",
                verticalAlign: "top",
                padding: 10,
                lineHeight: 1.3
              }
            },
            {
              id: "pain-onboarding",
              type: "node",
              position: { x: 480, y: 400 },
              angle: 0,
              zIndex: 10,
              style: {
                fillStyle: "#FEE2E2",
                fillOpacity: 1,
                strokeStyle: "#EF4444",
                strokeOpacity: 1,
                lineWidth: 1
              },
              size: { width: 120, height: 80 },
              shape: "rectangle",
              text: {
                content: "❌ Overwhelming UI\n\n✅ Progressive disclosure\n✅ Interactive tutorial",
                fontSize: 9,
                fontFamily: "inter",
                color: "#DC2626",
                textAlign: "left",
                verticalAlign: "top",
                padding: 10,
                lineHeight: 1.3
              }
            },
            {
              id: "pain-retention",
              type: "node",
              position: { x: 620, y: 400 },
              angle: 0,
              zIndex: 11,
              style: {
                fillStyle: "#FEE2E2",
                fillOpacity: 1,
                strokeStyle: "#EF4444",
                strokeOpacity: 1,
                lineWidth: 1
              },
              size: { width: 120, height: 80 },
              shape: "rectangle",
              text: {
                content: "❌ User churn\n\n✅ Personalization\n✅ Gamification",
                fontSize: 9,
                fontFamily: "inter",
                color: "#DC2626",
                textAlign: "left",
                verticalAlign: "top",
                padding: 10,
                lineHeight: 1.3
              }
            },
            // Opportunities Section
            {
              id: "opportunities-header",
              type: "node",
              position: { x: 60, y: 510 },
              angle: 0,
              zIndex: 12,
              style: {
                fillStyle: "#059669",
                fillOpacity: 1,
                strokeStyle: "#047857",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 680, height: 40 },
              shape: "rectangle",
              text: {
                content: "KEY OPPORTUNITIES FOR IMPROVEMENT",
                fontSize: 16,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            },
            {
              id: "opportunity-1",
              type: "node",
              position: { x: 80, y: 570 },
              angle: 0,
              zIndex: 13,
              style: {
                fillStyle: "#ECFDF5",
                fillOpacity: 1,
                strokeStyle: "#10B981",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 180, height: 60 },
              shape: "rectangle",
              text: {
                content: "🎯 Personalized Recommendations\nIncrease conversion by 25%",
                fontSize: 12,
                fontFamily: "inter",
                color: "#047857",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "opportunity-2",
              type: "node",
              position: { x: 280, y: 570 },
              angle: 0,
              zIndex: 14,
              style: {
                fillStyle: "#ECFDF5",
                fillOpacity: 1,
                strokeStyle: "#10B981",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 180, height: 60 },
              shape: "rectangle",
              text: {
                content: "📱 Social Commerce Integration\nLeverage social proof",
                fontSize: 12,
                fontFamily: "inter",
                color: "#047857",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "opportunity-3",
              type: "node",
              position: { x: 480, y: 570 },
              angle: 0,
              zIndex: 15,
              style: {
                fillStyle: "#ECFDF5",
                fillOpacity: 1,
                strokeStyle: "#10B981",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 180, height: 60 },
              shape: "rectangle",
              text: {
                content: "🔄 Subscription Model\nReduce churn, increase LTV",
                fontSize: 12,
                fontFamily: "inter",
                color: "#047857",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            }
          ]
        }),
        tags: ["user-journey", "ux", "design", "customer-experience", "touchpoints"],
        isPublic: true,
      },
      {
        title: "Data Analytics Dashboard",
        description: "Comprehensive analytics overview with KPIs, charts, and insights",
        category: "analytics",
        data: JSON.stringify({
          elements: [
            // Header
            {
              id: "dashboard-title",
              type: "node",
              position: { x: 50, y: 30 },
              angle: 0,
              zIndex: 0,
              style: {
                fillStyle: "#0F172A",
                fillOpacity: 1,
                strokeStyle: "#1E293B",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 700, height: 70 },
              shape: "rectangle",
              text: {
                content: "SALES & MARKETING ANALYTICS - Q4 2024",
                fontSize: 22,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 16,
                lineHeight: 1.2
              }
            },
            // Key Metrics Row 1
            {
              id: "revenue-card",
              type: "node",
              position: { x: 70, y: 130 },
              angle: 0,
              zIndex: 1,
              style: {
                fillStyle: "#ECFDF5",
                fillOpacity: 1,
                strokeStyle: "#10B981",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 160, height: 120 },
              shape: "rectangle",
              text: {
                content: "TOTAL REVENUE\n\n$847,392\n\n↗ +23.4% vs Q3\n💰 $42K above target",
                fontSize: 12,
                fontFamily: "inter",
                color: "#047857",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 12,
                lineHeight: 1.4
              }
            },
            {
              id: "customers-card",
              type: "node",
              position: { x: 250, y: 130 },
              angle: 0,
              zIndex: 2,
              style: {
                fillStyle: "#EFF6FF",
                fillOpacity: 1,
                strokeStyle: "#3B82F6",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 160, height: 120 },
              shape: "rectangle",
              text: {
                content: "NEW CUSTOMERS\n\n2,847\n\n↗ +18.7% vs Q3\n👥 598 from referrals",
                fontSize: 12,
                fontFamily: "inter",
                color: "#1E40AF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 12,
                lineHeight: 1.4
              }
            },
            {
              id: "conversion-card",
              type: "node",
              position: { x: 430, y: 130 },
              angle: 0,
              zIndex: 3,
              style: {
                fillStyle: "#FEF3C7",
                fillOpacity: 1,
                strokeStyle: "#F59E0B",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 160, height: 120 },
              shape: "rectangle",
              text: {
                content: "CONVERSION RATE\n\n4.2%\n\n↗ +0.8% vs Q3\n🎯 Above 4% target",
                fontSize: 12,
                fontFamily: "inter",
                color: "#92400E",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 12,
                lineHeight: 1.4
              }
            },
            {
              id: "retention-card",
              type: "node",
              position: { x: 610, y: 130 },
              angle: 0,
              zIndex: 4,
              style: {
                fillStyle: "#FDE7F3",
                fillOpacity: 1,
                strokeStyle: "#EC4899",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 160, height: 120 },
              shape: "rectangle",
              text: {
                content: "RETENTION RATE\n\n87.3%\n\n↗ +2.1% vs Q3\n🔄 85% avg industry",
                fontSize: 12,
                fontFamily: "inter",
                color: "#BE185D",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 12,
                lineHeight: 1.4
              }
            },
            // Charts Section
            {
              id: "charts-header",
              type: "node",
              position: { x: 70, y: 280 },
              angle: 0,
              zIndex: 5,
              style: {
                fillStyle: "#374151",
                fillOpacity: 1,
                strokeStyle: "#4B5563",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 700, height: 40 },
              shape: "rectangle",
              text: {
                content: "PERFORMANCE CHARTS & INSIGHTS",
                fontSize: 16,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            },
            // Revenue Chart
            {
              id: "revenue-chart",
              type: "node",
              position: { x: 70, y: 340 },
              angle: 0,
              zIndex: 6,
              style: {
                fillStyle: "#F8FAFC",
                fillOpacity: 1,
                strokeStyle: "#CBD5E1",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 320, height: 180 },
              shape: "rectangle",
              text: {
                content: "MONTHLY REVENUE TREND\n\n📈 Jul: $240K  Aug: $285K\n📈 Sep: $307K  Oct: $312K\n\n• Peak month: October\n• Lowest: July (summer dip)\n• Growth rate: 29.7%\n• Forecast Nov: $338K",
                fontSize: 11,
                fontFamily: "inter",
                color: "#1E293B",
                textAlign: "left",
                verticalAlign: "top",
                padding: 16,
                lineHeight: 1.5
              }
            },
            // Traffic Sources
            {
              id: "traffic-sources",
              type: "node",
              position: { x: 420, y: 340 },
              angle: 0,
              zIndex: 7,
              style: {
                fillStyle: "#F8FAFC",
                fillOpacity: 1,
                strokeStyle: "#CBD5E1",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 320, height: 180 },
              shape: "rectangle",
              text: {
                content: "TOP TRAFFIC SOURCES\n\n🔍 Organic Search: 42.3%\n📱 Social Media: 28.1%\n🎯 Paid Ads: 18.7%\n📧 Email Marketing: 7.2%\n🔗 Referrals: 3.7%\n\n💡 Focus on social & SEO",
                fontSize: 11,
                fontFamily: "inter",
                color: "#1E293B",
                textAlign: "left",
                verticalAlign: "top",
                padding: 16,
                lineHeight: 1.5
              }
            },
            // Performance Indicators
            {
              id: "performance-section",
              type: "node",
              position: { x: 70, y: 550 },
              angle: 0,
              zIndex: 8,
              style: {
                fillStyle: "#374151",
                fillOpacity: 1,
                strokeStyle: "#4B5563",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 700, height: 40 },
              shape: "rectangle",
              text: {
                content: "KEY PERFORMANCE INDICATORS",
                fontSize: 16,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.4
              }
            },
            // KPI Cards
            {
              id: "cac-metric",
              type: "node",
              position: { x: 70, y: 610 },
              angle: 0,
              zIndex: 9,
              style: {
                fillStyle: "#E0E7FF",
                fillOpacity: 1,
                strokeStyle: "#6366F1",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 140, height: 90 },
              shape: "rectangle",
              text: {
                content: "CUSTOMER\nACQUISITION\nCOST (CAC)\n\n$47.32\n↘ -$3.20 vs Q3",
                fontSize: 11,
                fontFamily: "inter",
                color: "#4338CA",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "ltv-metric",
              type: "node",
              position: { x: 230, y: 610 },
              angle: 0,
              zIndex: 10,
              style: {
                fillStyle: "#F0FDF4",
                fillOpacity: 1,
                strokeStyle: "#22C55E",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 140, height: 90 },
              shape: "rectangle",
              text: {
                content: "LIFETIME\nVALUE\n(LTV)\n\n$423.67\n↗ +$28.40 vs Q3",
                fontSize: 11,
                fontFamily: "inter",
                color: "#16A34A",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "ltv-cac-ratio",
              type: "node",
              position: { x: 390, y: 610 },
              angle: 0,
              zIndex: 11,
              style: {
                fillStyle: "#FEF3C7",
                fillOpacity: 1,
                strokeStyle: "#F59E0B",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 140, height: 90 },
              shape: "rectangle",
              text: {
                content: "LTV/CAC\nRATIO\n\n8.95:1\n\n✅ Healthy ratio\n(Target: >3:1)",
                fontSize: 11,
                fontFamily: "inter",
                color: "#92400E",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            {
              id: "churn-rate",
              type: "node",
              position: { x: 550, y: 610 },
              angle: 0,
              zIndex: 12,
              style: {
                fillStyle: "#FEF2F2",
                fillOpacity: 1,
                strokeStyle: "#EF4444",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 140, height: 90 },
              shape: "rectangle",
              text: {
                content: "MONTHLY\nCHURN RATE\n\n2.3%\n\n↘ -0.4% vs Q3\n🎯 Target: <3%",
                fontSize: 11,
                fontFamily: "inter",
                color: "#DC2626",
                textAlign: "center",
                verticalAlign: "middle",
                padding: 8,
                lineHeight: 1.3
              }
            },
            // Action Items
            {
              id: "action-items",
              type: "node",
              position: { x: 70, y: 730 },
              angle: 0,
              zIndex: 13,
              style: {
                fillStyle: "#7C3AED",
                fillOpacity: 1,
                strokeStyle: "#6D28D9",
                strokeOpacity: 1,
                lineWidth: 2
              },
              size: { width: 700, height: 100 },
              shape: "rectangle",
              text: {
                content: "🎯 ACTION ITEMS FOR Q1 2025\n\n• Increase social media ad spend by 15% (high ROI channel)\n• Implement customer referral program (boost word-of-mouth)\n• A/B test checkout flow (improve 4.2% conversion rate)\n• Launch retention email campaign (maintain 87% retention)",
                fontSize: 12,
                fontFamily: "inter",
                color: "#FFFFFF",
                textAlign: "left",
                verticalAlign: "top",
                padding: 16,
                lineHeight: 1.5
              }
            }
          ]
        }),
        tags: ["analytics", "dashboard", "kpi", "metrics", "data-visualization"],
        isPublic: true,
      }
    ];

    const templateIds = [];
    for (const template of sampleTemplates) {
      const templateId = await ctx.db.insert("templates", {
        ...template,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        usageCount: 0,
      });
      templateIds.push(templateId);
    }

    return { message: "Templates seeded successfully", count: templateIds.length };
  },
});
</file>
<file path="convex/tsconfig.json">
{
  /* This TypeScript project config describes the environment that
   * Convex functions run in and is used to typecheck them.
   * You can modify it, but some settings are required to use Convex.
   */
  "compilerOptions": {
    /* These settings are not required by Convex and can be modified. */
    "allowJs": true,
    "strict": true,
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "skipLibCheck": true,
    "allowSyntheticDefaultImports": true,

    /* These compiler options are required by Convex */
    "target": "ESNext",
    "lib": ["ES2021", "dom"],
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["./**/*"],
  "exclude": ["./_generated"]
}

</file>
<file path="convex/usage.ts">
import { mutation, query, internalMutation } from "./_generated/server";
import { ConvexError, v } from "convex/values";

// Helper to get today's date in YYYY-MM-DD format
function getTodayDateString() {
  const now = new Date();
  return now.toISOString().split('T')[0];
}

// Track AI generation usage
export const trackAiGeneration = mutation({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new ConvexError("Not authenticated");
    }
    
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .first();
      
    if (!user) {
      throw new ConvexError("User not found");
    }
    
    const today = getTodayDateString();
    
    // Get or create today's usage record
    let usage = await ctx.db
      .query("usage")
      .withIndex("by_user_date", (q) => 
        q.eq("userId", user._id).eq("date", today)
      )
      .first();
      
    if (usage) {
      // Increment existing usage
      await ctx.db.patch(usage._id, {
        aiGenerations: usage.aiGenerations + 1,
        updatedAt: Date.now(),
      });
    } else {
      // Create new usage record for today
      await ctx.db.insert("usage", {
        userId: user._id,
        date: today,
        aiGenerations: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    }
  },
});

// Get current usage and limits
export const getUsageAndLimits = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return null;
    }
    
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .first();
      
    if (!user) {
      return null;
    }
    
    // Get subscription
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .first();
      
    const plan = subscription?.status === "active" ? subscription.plan : "free";
    
    // Get plan limits
    const planLimits = await ctx.db
      .query("planLimits")
      .withIndex("by_plan", (q) => q.eq("plan", plan))
      .first();
      
    if (!planLimits) {
      throw new ConvexError("Plan limits not found");
    }
    
    // Get today's usage
    const today = getTodayDateString();
    const usage = await ctx.db
      .query("usage")
      .withIndex("by_user_date", (q) => 
        q.eq("userId", user._id).eq("date", today)
      )
      .first();
      
    return {
      plan,
      dailyLimit: planLimits.dailyAiGenerations,
      usedToday: usage?.aiGenerations ?? 0,
      remainingToday: planLimits.dailyAiGenerations === -1 
        ? -1 // Unlimited
        : Math.max(0, planLimits.dailyAiGenerations - (usage?.aiGenerations ?? 0)),
      isUnlimited: planLimits.dailyAiGenerations === -1,
    };
  },
});

// Check if user can generate (has not exceeded limit)
export const canGenerate = query({
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return false;
    }
    
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .first();
      
    if (!user) {
      return false;
    }
    
    // Get subscription
    const subscription = await ctx.db
      .query("subscriptions")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .first();
      
    const plan = subscription?.status === "active" ? subscription.plan : "free";
    
    // Get plan limits
    const planLimits = await ctx.db
      .query("planLimits")
      .withIndex("by_plan", (q) => q.eq("plan", plan))
      .first();
      
    if (!planLimits) {
      return false;
    }
    
    // Unlimited plan
    if (planLimits.dailyAiGenerations === -1) {
      return true;
    }
    
    // Get today's usage
    const today = getTodayDateString();
    const usage = await ctx.db
      .query("usage")
      .withIndex("by_user_date", (q) => 
        q.eq("userId", user._id).eq("date", today)
      )
      .first();
      
    const usedToday = usage?.aiGenerations ?? 0;
    return usedToday < planLimits.dailyAiGenerations;
  },
});

// Reset usage for all free tier users (for cron job)
export const resetFreeUsersUsage = internalMutation({
  handler: async (ctx) => {
    // Get all active free subscriptions
    const freeSubscriptions = await ctx.db
      .query("subscriptions")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .filter((q) => q.eq(q.field("plan"), "free"))
      .collect();
      
    const today = getTodayDateString();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayString = yesterday.toISOString().split('T')[0];
    
    let resetCount = 0;
    
    // Reset usage for each free user
    for (const subscription of freeSubscriptions) {
      // Delete yesterday's usage record
      const yesterdayUsage = await ctx.db
        .query("usage")
        .withIndex("by_user_date", (q) => 
          q.eq("userId", subscription.userId).eq("date", yesterdayString)
        )
        .first();
        
      if (yesterdayUsage) {
        await ctx.db.delete(yesterdayUsage._id);
        resetCount++;
      }
    }
    
    console.log(`Reset usage for ${resetCount} free tier users`);
    return { resetCount, date: yesterdayString };
  },
});

// Get usage history for a user
export const getUsageHistory = query({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, { days = 30 }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }
    
    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .first();
      
    if (!user) {
      return [];
    }
    
    // Calculate date range
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    
    const usage = await ctx.db
      .query("usage")
      .withIndex("by_user_date", (q) => q.eq("userId", user._id))
      .collect();
      
    // Filter by date range and sort
    return usage
      .filter(u => {
        const usageDate = new Date(u.date);
        return usageDate >= startDate && usageDate <= endDate;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
  },
});
</file>
<file path="convex/users.ts">
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

// Get or create user from Clerk authentication
export const getUserOrCreate = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // Check if user already exists
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();

    if (existingUser) {
      // Update user's last seen and online status
      await ctx.db.patch(existingUser._id, {
        lastSeen: Date.now(),
        isOnline: true,
        // Update profile info in case it changed in Clerk
        email: identity.email,
        name: identity.name,
        pictureUrl: identity.pictureUrl,
        clerkUserId: identity.subject, // Ensure Clerk ID is always set
      });
      
      // Ensure user has a subscription
      const subscription = await ctx.db
        .query("subscriptions")
        .withIndex("by_user", (q) => q.eq("userId", existingUser._id))
        .first();
        
      if (!subscription) {
        // Create default free subscription for existing user
        await ctx.db.insert("subscriptions", {
          userId: existingUser._id,
          clerkUserId: identity.subject,
          plan: "free",
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      }
      
      return existingUser._id;
    }

    // Create new user
    const userId = await ctx.db.insert("users", {
      tokenIdentifier: identity.tokenIdentifier,
      clerkUserId: identity.subject,
      email: identity.email,
      name: identity.name,
      pictureUrl: identity.pictureUrl,
      isOnline: true,
      lastSeen: Date.now(),
    });

    // Create default free subscription for new user
    await ctx.db.insert("subscriptions", {
      userId: userId,
      clerkUserId: identity.subject,
      plan: "free",
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    return userId;
  },
});

// Get current user
export const getCurrentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    
    if (!identity) {
      return null;
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();

    return user;
  },
});

// Update user online status
export const updateOnlineStatus = mutation({
  args: {
    isOnline: v.boolean(),
  },
  handler: async (ctx, { isOnline }) => {
    const identity = await ctx.auth.getUserIdentity();
    
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();

    if (user) {
      await ctx.db.patch(user._id, {
        isOnline,
        lastSeen: Date.now(),
      });
    }
  },
});

// Get user by ID
export const getUserById = query({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, { userId }) => {
    return await ctx.db.get(userId);
  },
});

// Update user profile
export const updateProfile = mutation({
  args: {
    name: v.string(),
  },
  handler: async (ctx, { name }) => {
    const identity = await ctx.auth.getUserIdentity();
    
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_token", (q) => q.eq("tokenIdentifier", identity.tokenIdentifier))
      .unique();

    if (!user) {
      throw new Error("User not found");
    }

    await ctx.db.patch(user._id, {
      name: name.trim(),
    });

    return user._id;
  },
});
</file>