/**
 * Minimal `vscode` stub for headless unit tests. The real `vscode` module only
 * exists inside the Extension Host, so vitest aliases imports of it to this file
 * (see vitest.config.ts). Only the runtime members the host file actually calls
 * are provided; full API surface is exercised by the integration harness.
 */

export interface Disposable {
  dispose(): void;
}

function makeDisposable(): Disposable {
  return { dispose: () => undefined };
}

export const commands = {
  registerCommand(_id: string, _handler: (...args: unknown[]) => unknown): Disposable {
    return makeDisposable();
  },
};

export interface InputBox {
  show(): Thenable<string | undefined>;
}

export const window = {
  registerTreeDataProvider(_viewId: string, _provider: unknown): Disposable {
    return makeDisposable();
  },
  get activeTextEditor(): TextEditor | undefined {
    return _activeTextEditor;
  },
  showInformationMessage(_message: string, ..._items: string[]): Thenable<string | undefined> {
    return Promise.resolve(undefined);
  },
  showWarningMessage(_message: string, ..._items: string[]): Thenable<string | undefined> {
    return Promise.resolve(undefined);
  },
  showErrorMessage(_message: string, ..._items: string[]): Thenable<string | undefined> {
    return Promise.resolve(undefined);
  },
  showInputBox(_options?: {
    title?: string;
    prompt?: string;
    placeholder?: string;
    value?: string;
  }): Thenable<string | undefined> {
    return Promise.resolve(undefined);
  },
  showQuickPick<T extends string>(
    _items: T[] | Thenable<T[]>,
    _options?: { title?: string; placeHolder?: string },
  ): Thenable<T | undefined> {
    return Promise.resolve(undefined);
  },
  showTextDocument(
    _doc: TextDocument | Uri,
    _columnOrOptions?: unknown,
    _preserveFocus?: boolean,
  ): Thenable<TextEditor> {
    throw new Error('showTextDocument not implemented in stub');
  },
  createOutputChannel(_name: string): { appendLine(_value: string): void; dispose(): void } {
    return { appendLine: () => undefined, dispose: () => undefined };
  },
  withProgress<R>(
    _options: unknown,
    _task: (progress: unknown, token: unknown) => Thenable<R>,
  ): Thenable<R> {
    return _task({}, {});
  },
};

/** Minimal `WorkspaceConfiguration`: always returns the caller's default, which
 * models an unset configuration (the live API is exercised by integration). */
export interface WorkspaceConfiguration {
  get<T>(section: string, defaultValue: T): T;
}

export const workspace = {
  getConfiguration(_section?: string): WorkspaceConfiguration {
    return {
      get<T>(_key: string, defaultValue: T): T {
        return defaultValue;
      },
    };
  },
  openTextDocument(
    _contentOrOptions?: string | { content?: string; language?: string },
  ): Thenable<TextDocument> {
    const content =
      typeof _contentOrOptions === 'string'
        ? _contentOrOptions
        : (_contentOrOptions?.content ?? '');
    return Promise.resolve(new TextDocument(content));
  },
  workspaceFolders: [] as { uri: Uri; name: string; index: number }[] | undefined,
};

// ---------------------------------------------------------------------------
// TreeView / TreeDataProvider types (Task 17)
// ---------------------------------------------------------------------------

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class ThemeIcon {
  static readonly File = new ThemeIcon('file');
  static readonly Folder = new ThemeIcon('folder');
  static readonly Check = new ThemeIcon('check');
  static readonly Warning = new ThemeIcon('warning');
  static readonly Eye = new ThemeIcon('eye');
  static readonly EyeClosed = new ThemeIcon('eye-closed');
  readonly id: string;
  private constructor(id: string) {
    this.id = id;
  }
}

export class TreeItem {
  label?: string;
  description?: string;
  tooltip?: string | MarkdownString;
  collapsibleState: TreeItemCollapsibleState;
  contextValue?: string;
  command?: { command: string; title: string; arguments?: unknown[] };
  iconPath?: ThemeIcon;
  accessibilityInformation?: { label: string; role?: string };
  constructor(label: string, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState ?? TreeItemCollapsibleState.None;
  }
}

/** Minimal Event<T> for TreeDataProvider onDidChangeTreeData. */
export interface Event<T> {
  (listener: (e: T | undefined) => void): Disposable;
}

/** Minimal EventEmitter<T> stub for testing. */
export class EventEmitter<T = void> {
  private _listeners: Array<(e: T | undefined) => void> = [];
  get event(): Event<T> {
    return (listener: (e: T | undefined) => void) => {
      this._listeners.push(listener);
      return {
        dispose: () => {
          this._listeners = this._listeners.filter((l) => l !== listener);
        },
      };
    };
  }
  fire(data?: T): void {
    for (const l of this._listeners) {
      l(data);
    }
  }
  dispose(): void {
    this._listeners = [];
  }
}

// ---------------------------------------------------------------------------
// Hover provider types (Task 06)
// ---------------------------------------------------------------------------

/** Minimal MarkdownString for hover/code-action rendering. */
export class MarkdownString {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

// ---------------------------------------------------------------------------
// Position & Range (Task 06 — needed by Hover, CodeAction, providers)
// ---------------------------------------------------------------------------

export class Position {
  readonly line: number;
  readonly character: number;
  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(start: Position, end: Position);
  constructor(startLine: number, startChar: number, endLine: number, endChar: number);
  constructor(
    startOrLine: Position | number,
    startOrChar: Position | number,
    endOrLine?: Position | number,
    endOrChar?: number,
  ) {
    if (startOrLine instanceof Position) {
      this.start = startOrLine;
      this.end = startOrChar as Position;
    } else {
      this.start = new Position(startOrLine, startOrChar as number);
      this.end = new Position(endOrLine as number, endOrChar as number);
    }
  }

  /** Returns the intersection of this range with another, or undefined if none. */
  intersection(other: Range): Range | undefined {
    const start = new Position(
      Math.max(this.start.line, other.start.line),
      this.start.line === other.start.line
        ? Math.max(this.start.character, other.start.character)
        : this.start.line > other.start.line
          ? this.start.character
          : other.start.character,
    );
    const end = new Position(
      Math.min(this.end.line, other.end.line),
      this.end.line === other.end.line
        ? Math.min(this.end.character, other.end.character)
        : this.end.line < other.end.line
          ? this.end.character
          : other.end.character,
    );
    // If start is after end, no intersection.
    if (start.line > end.line || (start.line === end.line && start.character > end.character)) {
      return undefined;
    }
    return new Range(start, end);
  }

  /** Whether this range contains the given position. */
  contains(position: Position): boolean {
    if (position.line < this.start.line || position.line > this.end.line) {
      return false;
    }
    if (position.line === this.start.line && position.character < this.start.character) {
      return false;
    }
    if (position.line === this.end.line && position.character > this.end.character) {
      return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Hover (Task 06 — needed by providers)
// ---------------------------------------------------------------------------

/** Minimal Hover for hover provider return type. */
export class Hover {
  readonly contents: MarkdownString[];
  readonly range: Range | undefined;
  constructor(contents: MarkdownString[], range?: Range) {
    this.contents = contents;
    this.range = range;
  }
}

// ---------------------------------------------------------------------------
// Selection & TextEditor (Task 17 — needed by command handlers)
// ---------------------------------------------------------------------------

/** Selection stub — a Range subclass for editor selections. */
export class Selection extends Range {
  readonly anchor: Position;
  readonly active: Position;
  constructor(anchor: Position, active: Position);
  constructor(anchorLine: number, anchorChar: number, activeLine: number, activeChar: number);
  constructor(
    anchorOrLine: Position | number,
    anchorOrChar: Position | number,
    activeOrLine?: Position | number,
    activeOrChar?: number,
  ) {
    if (anchorOrLine instanceof Position) {
      super(anchorOrLine, anchorOrChar as Position);
      this.anchor = anchorOrLine;
      this.active = anchorOrChar as Position;
    } else {
      super(anchorOrLine, anchorOrChar as number, activeOrLine as number, activeOrChar as number);
      this.anchor = new Position(anchorOrLine, anchorOrChar as number);
      this.active = new Position(activeOrLine as number, activeOrChar as number);
    }
  }
}

/** Minimal TextEditor for testing command handlers. */
export interface TextEditor {
  readonly document: TextDocument;
  selection: Selection;
  selections: Selection[];
  revealRange(range: Range, _revealType?: unknown): void;
}

/** Minimal TextEditorRevealType for revealRange. */
export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3,
}

/** Active text editor — tests can set this via setActiveEditor(). */
let _activeTextEditor: TextEditor | undefined;

export function setActiveEditor(editor: TextEditor | undefined): void {
  _activeTextEditor = editor;
}

// ---------------------------------------------------------------------------
// Code Action types (Task 06)
// ---------------------------------------------------------------------------

export class CodeActionKind {
  static readonly QuickFix = new CodeActionKind('quickfix');
  readonly value: string;
  private constructor(value: string) {
    this.value = value;
  }
}

export class CodeAction {
  title: string;
  kind?: CodeActionKind;
  command?: { title: string; command: string; arguments?: unknown[] };
  edit?: unknown;
  constructor(title: string, kind?: CodeActionKind) {
    this.title = title;
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Diagnostic (Task 06 — for provider context)
// ---------------------------------------------------------------------------

export enum DiagnosticSeverity {
  Error = 0,
  Warning = 1,
  Information = 2,
  Hint = 3,
}

export class Diagnostic {
  range: Range;
  message: string;
  severity: DiagnosticSeverity;
  source?: string;
  code?: string | number;
  constructor(range: Range, message: string, severity?: DiagnosticSeverity) {
    this.range = range;
    this.message = message;
    this.severity = severity ?? DiagnosticSeverity.Error;
  }
}

// ---------------------------------------------------------------------------
// TextDocument (Task 06 — for provider context)
// ---------------------------------------------------------------------------

export class Uri {
  readonly fsPath: string;
  readonly scheme: string;
  constructor(scheme: string, fsPath: string) {
    this.scheme = scheme;
    this.fsPath = fsPath;
  }
  /** Create a file URI (matches the real vscode.Uri.file factory). */
  static file(path: string): Uri {
    return new Uri('file', path);
  }
}

export class TextDocument {
  readonly uri: Uri;
  readonly fileName: string;
  private readonly _text: string;
  constructor(text: string, fileName = '/test/document.md') {
    this.uri = new Uri('file', fileName);
    this.fileName = fileName;
    this._text = text;
  }
  getText(range?: Range): string {
    if (!range) return this._text;
    // Simplified range-based text extraction for testing.
    const lines = this._text.split('\n');
    if (range.start.line === range.end.line) {
      return lines[range.start.line]?.slice(range.start.character, range.end.character) ?? '';
    }
    const parts = [lines[range.start.line]?.slice(range.start.character) ?? ''];
    for (let i = range.start.line + 1; i < range.end.line; i++) {
      parts.push(lines[i] ?? '');
    }
    parts.push(lines[range.end.line]?.slice(0, range.end.character) ?? '');
    return parts.join('\n');
  }
  get lineCount(): number {
    return this._text.split('\n').length;
  }
  lineAt(line: number): { text: string; range: Range } {
    const lines = this._text.split('\n');
    const text = lines[line] ?? '';
    return { text, range: new Range(line, 0, line, text.length) };
  }
  offsetAt(position: Position): number {
    const lines = this._text.split('\n');
    let offset = 0;
    for (let i = 0; i < position.line && i < lines.length; i++) {
      offset += lines[i].length + 1; // +1 for \n
    }
    return offset + position.character;
  }
  positionAt(offset: number): Position {
    let remaining = offset;
    const lines = this._text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (remaining <= lines[i].length) {
        return new Position(i, remaining);
      }
      remaining -= lines[i].length + 1;
    }
    return new Position(lines.length - 1, (lines[lines.length - 1] ?? '').length);
  }
}

// ---------------------------------------------------------------------------
// CancellationToken (Task 06 — for provider signatures)
// ---------------------------------------------------------------------------

export class CancellationToken {
  isCancellationRequested = false;
}

// ---------------------------------------------------------------------------
// CodeActionContext (Task 06 — for code action provider)
// ---------------------------------------------------------------------------

export interface CodeActionContext {
  readonly diagnostics: Diagnostic[];
  readonly triggerKind?: number;
  readonly only?: CodeActionKind;
}

// ---------------------------------------------------------------------------
// DiagnosticCollection (Task 06 — for diagnostic management)
// ---------------------------------------------------------------------------

export interface DiagnosticCollection {
  readonly name: string;
  set(uri: Uri, diagnostics: Diagnostic[]): void;
  get(uri: Uri): Diagnostic[] | undefined;
  delete(uri: Uri): void;
  clear(): void;
  dispose(): void;
}

/** Per-URI diagnostic store used by the stub's getDiagnostics(). */
const diagnosticStore = new Map<string, Diagnostic[]>();

export const languages = {
  registerHoverProvider(_selector: unknown, _provider: unknown): Disposable {
    return makeDisposable();
  },
  registerCodeActionProvider(
    _selector: unknown,
    _provider: unknown,
    _metadata?: unknown,
  ): Disposable {
    return makeDisposable();
  },
  /**
   * Stub for `vscode.languages.getDiagnostics()`.
   * Returns diagnostics previously set via `setDiagnosticsForUri()`.
   * If a URI is given, returns diagnostics for that URI. If no URI,
   * returns empty (the real API returns [Uri, Diagnostic[]][] for all URIs).
   */
  getDiagnostics(uri?: Uri): Diagnostic[] {
    if (uri) {
      return diagnosticStore.get(uri.fsPath) ?? [];
    }
    return [];
  },
};

/** Test helper: set diagnostics for a URI (simulates what DiagnosticCollection does). */
export function setDiagnosticsForUri(uri: Uri, diagnostics: Diagnostic[]): void {
  diagnosticStore.set(uri.fsPath, diagnostics);
}

/** Test helper: clear all stored diagnostics. */
export function clearAllDiagnostics(): void {
  diagnosticStore.clear();
}
