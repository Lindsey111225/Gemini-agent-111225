
export enum AgentStatus {
  Pending = 'Pending',
  Running = 'Running',
  Success = 'Success',
  Error = 'Error',
}

export enum DocumentType {
  EMPTY = 'EMPTY',
  PDF = 'PDF',
  TXT = 'TXT',
  PASTE = 'PASTE'
}

export interface DocumentFile {
  id: string;
  name: string;
  type: DocumentType;
  content: string;
  file?: File;
  pdfDoc?: any;
}

export interface Agent {
  id: string;
  name: string;
  prompt: string;
  status: AgentStatus;
  model: string;
  output: string | null;
  error: string | null;
  outputJson: any | null;
}

export interface Keyword {
  id: string;
  text: string;
  color: string;
}

export interface Theme {
  name: string;
  colors: {
    primary: string;
  };
}

export interface AnalysisResult {
    sentiment: { positive: number, negative: number, neutral: number } | null;
    entities: { name: string, type: string }[] | null;
}

export type Language = 'en' | 'zh-TW';
