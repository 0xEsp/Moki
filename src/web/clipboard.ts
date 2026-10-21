// Copiar texto al portapapeles. `navigator.clipboard` solo existe en contextos seguros (HTTPS o
// localhost); en la red local (http://<host>:7410) no está, así que se recurre al método clásico
// con un <textarea> oculto y execCommand('copy'), que sigue funcionando dentro de un clic.

export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permiso denegado u otro fallo: se intenta el método clásico.
    }
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
