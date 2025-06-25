export interface SearchNotesParams {
  pattern: string;
  case_sensitive?: boolean;
  whole_word?: boolean;
  multiline?: boolean;
  context_lines?: number;
}

export interface NoteMetadata {
  [key: string]: any;
}

export interface Note {
  name: string;
  contents: string;
  metadata: NoteMetadata;
  tags: string[];
}

export interface SearchResult {
  path: string;
  matches: Array<{
    line_number: number;
    content: string;
    context_before: string[];
    context_after: string[];
  }>;
}