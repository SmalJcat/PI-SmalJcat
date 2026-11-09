import { useRef, useState } from 'react';
import { LoaderCircle, X } from './icons';
import { IconButton, Modal } from './components';
import { editableMessage } from './message-edit.mjs';
import type { Wire } from './types';

export function MessageEditor({ message, append, prepared, disabled, onSubmit, onReconnect, onClose }: {
  message: Wire;
  append?: boolean;
  prepared?: boolean;
  disabled: boolean;
  onSubmit: (text: string, images: Wire[]) => Promise<boolean>;
  onReconnect?: () => Promise<void>;
  onClose: () => void;
}) {
  const original = editableMessage(message);
  const [text, setText] = useState(original.text);
  const [images, setImages] = useState<Wire[]>(original.images);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const editor = useRef<HTMLTextAreaElement>(null);
  const save = async () => {
    if (pending || disabled || (!text.trim() && !images.length)) return;
    setPending(true);
    setError('');
    try { await onSubmit(text, images); }
    catch (error) { setError(String(error instanceof Error ? error.message : error)); }
    finally {
      setPending(false);
      requestAnimationFrame(() => editor.current?.focus());
    }
  };
  const reconnect = async () => {
    if (pending || !onReconnect) return;
    setPending(true);
    setError('');
    try { await onReconnect(); }
    catch (error) { setError(String(error instanceof Error ? error.message : error)); }
    finally { setPending(false); }
  };
  return <Modal title={append ? '编辑为新消息' : '编辑消息'} onClose={() => { if (!pending) onClose(); }}>
    <form className="modal-body message-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
      {error && <div className="notice error" role="alert">{error}</div>}
      <textarea ref={editor} data-autofocus aria-label="编辑消息内容" value={text} rows={7} disabled={pending} onChange={event => setText(event.target.value)} />
      {images.length > 0 && <div className="edit-message-images">
        {images.map((image, index) => <div className="edit-message-image" key={index}>
          <img src={`data:${image.mimeType};base64,${image.data}`} alt={`原消息图片 ${index + 1}`} />
          <IconButton label={`移除原消息图片 ${index + 1}`} disabled={pending} onClick={() => setImages(current => current.filter((_, position) => position !== index))}><X size={13} /></IconButton>
        </div>)}
      </div>}
      <div className="modal-actions">
        <button className="secondary-button" type="button" disabled={pending} onClick={onClose}>{prepared ? '关闭' : '取消'}</button>
        {onReconnect && <button className="secondary-button" type="button" disabled={pending} onClick={() => void reconnect()}>重新连接</button>}
        <button className="primary-button" type="submit" disabled={pending || disabled || (!text.trim() && !images.length)}>
          {pending && <LoaderCircle size={14} className="spin" />}{append ? '作为新消息发送' : '保存并重新发送'}
        </button>
      </div>
    </form>
  </Modal>;
}
