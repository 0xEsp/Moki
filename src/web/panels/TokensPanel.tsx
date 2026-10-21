import { observer } from 'mobx-react-lite';
import { useRef, useState } from 'react';
import { compareKeys } from '../../core/fractional';
import { ColorPicker, hexifyCss, toHexDisplay } from './ColorPicker';
import { externalCssValue, parseTokenValue, renderCssValue } from '../../core/tokens';
import { TOKEN_TYPE_ORDER, TOKEN_TYPES, type Token, type TokenType } from '../../core/types';
import type { EditorState } from '../editor/editor-state';
import { Section, TextInput } from './controls';

const TYPE_LABEL: Record<TokenType, string> = {
  color: 'Colores', fontFamily: 'Familias', fontSize: 'Tamaños de texto', fontWeight: 'Pesos',
  letterSpacing: 'Tracking', lineHeight: 'Interlineado', opacity: 'Opacidad', breakpoint: 'Breakpoints',
  container: 'Contenedores', spacing: 'Espaciado', radius: 'Radios',
};

export const TokensPanel = observer(function TokensPanel({ editor }: { editor: EditorState }) {
  const { doc } = editor;
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState<TokenType>('color');
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const tokens = doc.liveTokens;

  const create = () => {
    const clean = name.trim().replace(/^--/, '');
    if (!/^[a-zA-Z0-9_-]+$/.test(clean)) return setError('Nombre inválido (letras, números, - y _)');
    const parsed = parseTokenValue(doc.data, type, value);
    if (!parsed.ok) return setError(parsed.error);
    doc.breakUndoGroup();
    doc.createToken({ type, name: clean, value: parsed.value });
    setName('');
    setValue('');
    setError(null);
    setAdding(false);
  };

  return (
    <Section
      title="Tokens"
      actions={
        <button className="icon-btn" title="Nuevo token" onClick={() => setAdding((a) => !a)}>
          +
        </button>
      }
    >
      {adding && (
        <div className="token-form">
          <select className="input" value={type} onChange={(e) => setType(e.target.value as TokenType)}>
            {TOKEN_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input className="input mono" placeholder="--color-primary" value={name} onChange={(e) => setName(e.target.value)} />
          <input
            className="input mono"
            placeholder="valor o var(--otro)"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && create()}
          />
          {error && <div className="error-text">{error}</div>}
          <button className="btn btn-primary btn-sm" onClick={create}>
            Crear
          </button>
        </div>
      )}
      {tokens.length === 0 && !adding && <div className="muted">Sin tokens. Los agentes pueden crearlos con create_tokens.</div>}
      {TOKEN_TYPE_ORDER.map((t) => {
        const list = tokens.filter((x) => x.type === t).sort((a, b) => compareKeys(a.sortKey, b.sortKey));
        if (!list.length) return null;
        return (
          <div key={t} className="token-group">
            <div className="prop-sub">{TYPE_LABEL[t]}</div>
            {list.map((tok) => (
              <TokenRow key={tok.id} editor={editor} token={tok} />
            ))}
          </div>
        );
      })}
    </Section>
  );
});

/** Muestra del color del token; clic → selector propio (HEX por defecto). */
const TokenSwatch = observer(function TokenSwatch({ editor, token }: { editor: EditorState; token: Token }) {
  const { doc } = editor;
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const literal = toHexDisplay(externalCssValue(doc.data, token));
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="token-swatch moki-canvas-scope"
        title={literal ? 'Cambiar color' : 'Alias de otro token'}
        style={{ background: renderCssValue(doc.data, token) }}
        onClick={() => literal && setOpen((o) => !o)}
      />
      {open && ref.current && literal && (
        <ColorPicker
          anchor={ref.current}
          value={literal}
          onChange={(hex) => doc.updateToken(token.id, { value: hex })}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
});

const TokenRow = observer(function TokenRow({ editor, token }: { editor: EditorState; token: Token }) {
  const { doc } = editor;
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className="token-row" title={token.description}>
      {token.type === 'color' && <TokenSwatch editor={editor} token={token} />}
      <TextInput
        value={`--${token.name}`}
        mono
        className="token-name"
        onCommit={(v) => {
          const clean = v.trim().replace(/^--/, '');
          if (/^[a-zA-Z0-9_-]+$/.test(clean)) doc.updateToken(token.id, { name: clean });
        }}
      />
      <TextInput
        value={token.type === 'color' ? hexifyCss(toHexDisplay(externalCssValue(doc.data, token)) ?? externalCssValue(doc.data, token)) : externalCssValue(doc.data, token)}
        mono
        className="token-value"
        onCommit={(v) => {
          const p = parseTokenValue(doc.data, token.type, v);
          if (!p.ok) return setErr(p.error);
          setErr(null);
          doc.updateToken(token.id, { value: p.value });
        }}
      />
      <button
        className="icon-btn"
        title="Eliminar"
        onClick={() => {
          doc.breakUndoGroup();
          doc.deleteToken(token.id);
        }}
      >
        ×
      </button>
      {err && <div className="error-text">{err}</div>}
    </div>
  );
});
