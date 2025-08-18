// Global types for sandbox file management

export interface SandboxFile {
  content: string;
  lastModified: number;
}

export interface SandboxFileCache {
  files: Record<string, SandboxFile>;
  lastSync: number;
  sandboxId: string;
  manifest?: any; // FileManifest type from file-manifest.ts
}

export interface SandboxState {
  fileCache: SandboxFileCache | null;
  sandbox: any; // E2B sandbox instance
  sandboxData: {
    sandboxId: string;
    url: string;
  } | null;
}

// Streaming apply code response message types
export interface ApplyCodeStreamStart { type: 'start'; }
export interface ApplyCodeStreamStep { type: 'step'; message: string; packages?: string[]; }
export interface ApplyCodeStreamPackageProgress { type: 'package-progress'; installedPackages?: string[]; }
export interface ApplyCodeStreamCommand { type: 'command'; command: string; }
export interface ApplyCodeStreamSuccess { 
  type: 'success'; 
  installedPackages?: string[]; 
  filesCreated?: string[]; 
  filesUpdated?: string[]; 
  commandsExecuted?: string[]; 
  errors?: string[]; 
  structure?: any; 
  explanation?: string; 
  autoCompleted?: boolean; 
  autoCompletedComponents?: string[]; 
  warning?: string; 
  missingImports?: string[]; 
  debug?: any; 
}
export type ApplyCodeStreamMessage = ApplyCodeStreamStart | ApplyCodeStreamStep | ApplyCodeStreamPackageProgress | ApplyCodeStreamCommand | ApplyCodeStreamSuccess;

export interface GeneratedFile {
  path: string;
  content: string;
  type: string;
  completed: boolean;
  edited?: boolean;
}

// Declare global types
declare global {
  var activeSandbox: any;
  var sandboxState: SandboxState;
  var existingFiles: Set<string>;
}

export {};