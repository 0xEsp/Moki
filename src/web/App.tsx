import { Dashboard } from './dashboard/Dashboard';
import { EditorRoute } from './editor/EditorRoute';
import { parseFileRoute, usePathname } from './router';

export function App() {
  const path = usePathname();
  const file = parseFileRoute(path);
  if (file) return <EditorRoute key={file.fileId} fileId={file.fileId} initialPageId={file.pageId} />;
  return <Dashboard />;
}
