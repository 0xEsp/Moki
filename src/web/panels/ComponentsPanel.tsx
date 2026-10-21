import { observer } from 'mobx-react-lite';
import type { EditorState } from '../editor/editor-state';
import { goToMainComponent, insertInstance } from '../editor/component-actions';

// Lista de componentes principales del fichero (agrupados por página). Clic → instancia en el
// Frame seleccionado o en el centro de la vista; arrastrar al canvas → instancia donde se suelta.

export const COMPONENT_DRAG_TYPE = 'application/x-moki-component';

export const ComponentsPanel = observer(function ComponentsPanel({ editor }: { editor: EditorState }) {
  const { doc } = editor;
  const mains = doc.mainComponents;
  if (mains.length === 0) {
    return (
      <div className="components-panel">
        <div className="empty">
          Aún no hay componentes. Selecciona un frame y pulsa <b>⌘⌥K</b> (o «Crear componente» en el panel de diseño) para
          convertirlo en componente reutilizable.
        </div>
      </div>
    );
  }
  const byPage = new Map<string, typeof mains>();
  for (const m of mains) {
    const pid = doc.pageIdOf(m.id) ?? '';
    const l = byPage.get(pid) ?? [];
    l.push(m);
    byPage.set(pid, l);
  }
  const pageOrder = doc.canvasPages.map((p) => p.id).filter((p) => byPage.has(p));
  return (
    <div className="components-panel">
      {pageOrder.map((pid) => (
        <div key={pid}>
          <div className="comp-group">{doc.page(pid)?.label ?? 'Página'}</div>
          {byPage
            .get(pid)!
            .slice()
            .sort((a, b) => a.label.localeCompare(b.label))
            .map((m) => {
              const count = doc.instancesByMain.get(m.id)?.length ?? 0;
              return (
                <div
                  key={m.id}
                  className="comp-item"
                  draggable
                  title="Clic: insertar instancia · Arrastrar al canvas · Doble clic: ir al componente"
                  onDragStart={(e) => {
                    e.dataTransfer.setData(COMPONENT_DRAG_TYPE, m.id);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onClick={() => insertInstance(editor, m.id)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    goToMainComponent(editor, m.id);
                  }}
                >
                  <span className="component-glyph">◇</span>
                  <span>{m.label}</span>
                  <span className="comp-meta">{count}</span>
                </div>
              );
            })}
        </div>
      ))}
    </div>
  );
});
