import { Download, FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { loadAttachment } from './files';
import { Attachment } from './storage';

function formatSize(size: number) {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} КБ`;
  return `${(size / 1024 / 1024).toFixed(1)} МБ`;
}

export function AttachmentView({ attachment }: { attachment: Attachment }) {
  const [url, setUrl] = useState('');

  useEffect(() => {
    let objectUrl = '';
    void loadAttachment(attachment.id).then((blob) => {
      if (!blob) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    });
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id]);

  if (!url) {
    return <div className="attachment-loading">загружаем локальный файл…</div>;
  }

  return (
    <div className="attachment">
      {attachment.type.startsWith('image/') && <img src={url} alt={attachment.name} />}
      {attachment.type.startsWith('video/') && <video src={url} controls preload="metadata" />}
      {attachment.type.startsWith('audio/') && <audio src={url} controls preload="metadata" />}
      <div className="attachment-info">
        <div className="attachment-icon"><FileText size={18} /></div>
        <div><strong>{attachment.name}</strong><span>{formatSize(attachment.size)} · хранится локально</span></div>
        <a href={url} download={attachment.name} title="Скачать"><Download size={17} /></a>
      </div>
    </div>
  );
}
