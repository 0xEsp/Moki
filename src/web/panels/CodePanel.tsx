import { observer } from 'mobx-react-lite';
import { useEffect, useState } from 'react';
import type { DocStore } from '../state/doc-store';
import type { EditorState } from '../editor/editor-state';
import { Seg } from './controls';

type GenerateJsx = (
  doc: DocStore,
  nodeId: string,
  opts: { format?: 'inline-styles' | 'tailwind'; includeNodeIds?: boolean; includeRootPositioning?: boolean },
) => string;

// El generador JSX lo aporta el módulo MCP (src/web/mcp/jsx.ts); se carga perezosamente.
const jsxModules = import.meta.glob('../mcp/jsx.ts');
let generator: Promise<GenerateJsx | null> | null = null;
function loadGenerator(): Promise<GenerateJsx | null> {
  const loader = jsxModules['../mcp/jsx.ts'];
  generator ??= loader ? loader().then((m) => (m as { generateJsx: GenerateJsx }).generateJsx) : Promise.resolve(null);
  return generator;
}

export const CodePanel = observer(function CodePanel({ editor }: { editor: EditorState }) {
  const [format, setFormat] = useState<'inline-styles' | 'tailwind'>('inline-styles');
  const [gen, setGen] = useState<GenerateJsx | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    loadGenerator().then((g) => setGen(() => g));
  }, []);
  const id = editor.selection[0]!;
  let code = '';
  if (gen) {
    try {
      // Lectura dentro del render: el observer re-genera al cambiar el documento.
      code = gen(editor.doc, id, { format, includeNodeIds: false });
    } catch (e) {
      code = `// Error generando JSX: ${(e as Error).message}`;
    }
  } else if (gen === null) {
    code = '// Generador JSX no disponible todavía.';
  }
  return (
    <div className="panel-scroll">
      <div className="panel-section">
        <div className="section-title">
          <Seg
            value={format}
            onChange={setFormat}
            options={[
              { value: 'inline-styles', label: 'Estilos inline' },
              { value: 'tailwind', label: 'Tailwind' },
            ]}
          />
          <button
            className="btn btn-sm"
            onClick={() =>
              navigator.clipboard.writeText(code).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              })
            }
          >
            {copied ? 'Copiado ✓' : 'Copiar'}
          </button>
        </div>
        <pre className="code-block">{code}</pre>
      </div>
    </div>
  );
});
