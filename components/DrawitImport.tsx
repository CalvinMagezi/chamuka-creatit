'use client';

import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';

interface DrawitImportProps {
  onImportSuccess?: (result: any) => void;
  onImportError?: (error: string) => void;
}

export function DrawitImport({ onImportSuccess, onImportError }: DrawitImportProps) {
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string | undefined>();
  const [analysis, setAnalysis] = useState<any>(undefined);
  const [error, setError] = useState<string | undefined>();
  const [generating, setGenerating] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [diagram, setDiagram] = useState<any>(undefined);
  
  const drawitInputRef = useRef<HTMLInputElement>(null);

  const triggerDrawitSelect = () => {
    if (loading || generating) return;
    drawitInputRef.current?.click();
  };

  const handleDrawitFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setFileName(file.name);
    setLoading(true);
    setError(undefined);
    setAnalysis(undefined);
    
    try {
      const text = await file.text();
      let parsed: any;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('Invalid JSON in .drawit file');
      }
      
      // Dry-run generation to preview routes & screens
      const dryResp = await fetch('/api/generate-from-drawit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram: parsed, options: { dryRun: true } })
      });
      
      const dryJson = await dryResp.json();
      if (!dryResp.ok || !dryJson.ok) {
        throw new Error(dryJson.errors?.map((e: any) => e.message).join('; ') || 'Analysis failed');
      }
      
      setAnalysis(dryJson);
      setDiagram(parsed);
      setShowPreview(true);
      
      if (onImportSuccess) {
        onImportSuccess(dryJson);
      }
    } catch (err: any) {
      setError(err.message);
      if (onImportError) {
        onImportError(err.message);
      }
    } finally {
      setLoading(false);
      if (drawitInputRef.current) {
        drawitInputRef.current.value = '';
      }
    }
  };

  const generateFromDrawit = async () => {
    if (!analysis || !diagram) return;
    
    try {
      setGenerating(true);
      setError(undefined);
      
      const writeResp = await fetch('/api/generate-from-drawit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diagram, options: { dryRun: false, prune: true } })
      });
      
      const writeJson = await writeResp.json();
      if (!writeResp.ok || !writeJson.ok) {
        throw new Error(writeJson.errors?.map((e: any) => e.message).join('; ') || 'Generation failed');
      }
      
      setShowPreview(false);
      setGenerating(false);
      
      if (onImportSuccess) {
        onImportSuccess(writeJson);
      }
    } catch (err: any) {
      setError(err.message);
      setGenerating(false);
      if (onImportError) {
        onImportError(err.message);
      }
    }
  };

  const cancelDrawitPreview = () => {
    setShowPreview(false);
  };

  return (
    <div className="drawit-import-component">
      {/* Hidden file input */}
      <input
        ref={drawitInputRef}
        type="file"
        accept=".drawit,application/json"
        className="hidden"
        onChange={handleDrawitFileChange}
      />
      
      {/* Trigger button */}
      <Button
        variant="outline"
        size="sm"
        onClick={triggerDrawitSelect}
        disabled={loading || generating}
        title={loading ? 'Analyzing...' : generating ? 'Generating...' : 'Import .drawit design'}
      >
        {loading ? 'Analyzing…' : generating ? 'Building…' : '.drawit'}
      </Button>
      
      {/* Preview modal */}
      {showPreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-xl w-[640px] max-h-[80vh] flex flex-col text-gray-900">
            <div className="px-4 py-3 border-b flex items-center justify-between">
              <h2 className="text-sm font-semibold">.drawit Analysis Preview</h2>
              <button
                onClick={cancelDrawitPreview}
                className="text-gray-500 hover:text-gray-700 transition-colors"
                title="Close"
              >
                <svg className="w-4 h-4" viewBox="0 0 24 24" stroke="currentColor" fill="none">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
                </svg>
              </button>
            </div>
            <div className="p-4 overflow-y-auto text-sm space-y-3">
              <div>
                <div className="font-medium">File:</div>
                <div className="font-mono text-xs">{fileName}</div>
              </div>
              <div>
                <div className="font-medium mb-1">Detected Screens</div>
                <div className="border rounded-md divide-y">
                  {(analysis?.preview?.manifest?.screens || []).map((s: any) => (
                    <div key={s.route} className="px-3 py-2 flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="font-mono text-xs">{s.route}</span>
                        {s.frame && (
                          <span className="text-[10px] text-gray-500">
                            {s.frame.width}x{s.frame.height}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-gray-600">
                        {(s.elements?.length ?? s.elementCount ?? 0)} elements
                      </div>
                    </div>
                  ))}
                  {(!analysis?.preview?.manifest?.screens ||
                    analysis.preview.manifest.screens.length === 0) && (
                    <div className="px-3 py-4 text-xs text-gray-500">No screens detected</div>
                  )}
                </div>
              </div>
              {analysis?.analysis?.warnings && analysis.analysis.warnings.length > 0 && (
                <div>
                  <div className="font-medium mb-1">Warnings</div>
                  <ul className="list-disc ml-5 space-y-1 text-xs">
                    {analysis.analysis.warnings.map((w: any, i: number) => (
                      <li key={i}>{typeof w === 'string' ? w : JSON.stringify(w)}</li>
                    ))}
                  </ul>
                </div>
              )}
              {error && (
                <div className="text-xs text-red-600">
                  {error}
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={cancelDrawitPreview}
                disabled={generating}
              >
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={generateFromDrawit}
                disabled={generating}
                title="Generate Next.js pages from this design"
              >
                {generating ? 'Generating…' : 'Generate Pages'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}