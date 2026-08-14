import { useState } from 'react';
import { AlertTriangle } from 'react-feather';
import { KINDS, type ChunkFormValues } from './types';

interface Props {
  mode: 'create' | 'edit';
  initial: ChunkFormValues;
  /** Set while the parent is submitting; disables the buttons. */
  saving: boolean;
  onSubmit: (values: ChunkFormValues) => void;
  onCancel: () => void;
}

const inputCls = 'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-royal/40';
const labelCls = 'block text-xs font-medium text-gray-600 mb-1';

/** Create / edit form for a knowledge chunk. Validation mirrors the server:
 *  kind, content, and source are required. */
export default function ChunkForm({ mode, initial, saving, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<ChunkFormValues>(initial);
  const [validationError, setValidationError] = useState<string | null>(null);

  const set = (field: keyof ChunkFormValues) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>,
  ) => setValues(v => ({ ...v, [field]: e.target.value }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!values.content.trim()) return setValidationError('Content is required.');
    if (!values.source.trim()) return setValidationError('Source is required.');
    if (values.source_url.trim() && !/^https?:\/\//i.test(values.source_url.trim())) {
      return setValidationError('Source URL must start with http:// or https://');
    }
    setValidationError(null);
    onSubmit(values);
  };

  const contentChanged = mode === 'edit' && values.content !== initial.content;

  return (
    <form onSubmit={submit} className="bg-white rounded-lg shadow p-4 border border-royal/30 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">
          {mode === 'create' ? 'Add content' : 'Edit content'}
        </h3>
        {mode === 'edit' && (
          <span className="inline-flex items-center gap-1 text-xs text-amber-700">
            <AlertTriangle size={12} />
            Editing content sends the chunk back to pending review
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className={labelCls}>Kind</label>
          <select value={values.kind} onChange={set('kind')} className={inputCls}>
            {KINDS.map(k => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Topic</label>
          <input type="text" value={values.topic} onChange={set('topic')} className={inputCls} placeholder="e.g. anxiety" />
        </div>
        <div>
          <label className={labelCls}>Modality</label>
          <input type="text" value={values.modality} onChange={set('modality')} className={inputCls} placeholder="e.g. cbt (techniques only)" />
        </div>
      </div>

      <div>
        <label className={labelCls}>Title</label>
        <input type="text" value={values.title} onChange={set('title')} className={inputCls} placeholder="Short descriptive title" />
      </div>

      <div>
        <label className={labelCls}>Content <span className="text-red-500">*</span></label>
        <textarea
          value={values.content}
          onChange={set('content')}
          rows={8}
          className={`${inputCls} font-mono text-xs`}
          placeholder="The retrievable text. Changing this re-embeds the chunk."
        />
        {contentChanged && (
          <p className="text-xs text-amber-700 mt-1">
            Content changed: saving will re-embed this chunk and set it back to pending review.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div>
          <label className={labelCls}>Source <span className="text-red-500">*</span></label>
          <input type="text" value={values.source} onChange={set('source')} className={inputCls} placeholder="e.g. NIMH, clinician-authored" />
        </div>
        <div>
          <label className={labelCls}>Source URL</label>
          <input type="text" value={values.source_url} onChange={set('source_url')} className={inputCls} placeholder="https://..." />
        </div>
        <div>
          <label className={labelCls}>License</label>
          <input type="text" value={values.license} onChange={set('license')} className={inputCls} placeholder="e.g. public domain, CC-BY" />
        </div>
      </div>

      {validationError && (
        <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-700">{validationError}</div>
      )}

      <div className="flex items-center gap-2 justify-end">
        <button type="button" onClick={onCancel} disabled={saving}
          className="px-4 py-2 text-sm rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-40">
          Cancel
        </button>
        <button type="submit" disabled={saving}
          className="px-4 py-2 text-sm rounded-lg bg-royal text-white font-medium hover:opacity-90 disabled:opacity-40">
          {saving ? 'Saving (embedding)…' : mode === 'create' ? 'Create as pending' : 'Save changes'}
        </button>
      </div>
    </form>
  );
}
