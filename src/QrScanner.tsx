import type { IScannerControls } from '@zxing/browser';
import { Camera, ImagePlus, X } from 'lucide-react';
import { ChangeEvent, useEffect, useRef, useState } from 'react';

type QrScannerProps = {
  title: string;
  onResult: (value: string) => void;
  onCancel: () => void;
};

export function QrScanner({ title, onResult, onCancel }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const controlsRef = useRef<IScannerControls | null>(null);
  const completedRef = useRef(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let disposed = false;
    void import('@zxing/browser').then(({ BrowserQRCodeReader }) => {
      const reader = new BrowserQRCodeReader();
      return reader.decodeFromConstraints(
        { video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        videoRef.current || undefined,
        (result, _scanError, controls) => {
          if (!result || completedRef.current) return;
          completedRef.current = true;
          controls.stop();
          onResult(result.getText());
        },
      );
    }).then((controls) => {
      if (disposed) controls.stop();
      else controlsRef.current = controls;
    }).catch(() => setError('Камера недоступна. Можно выбрать сохранённую QR-картинку ниже.'));

    return () => {
      disposed = true;
      controlsRef.current?.stop();
    };
  }, [onResult]);

  const scanImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const url = URL.createObjectURL(file);
    try {
      const { BrowserQRCodeReader } = await import('@zxing/browser');
      const result = await new BrowserQRCodeReader().decodeFromImageUrl(url);
      onResult(result.getText());
    } catch {
      setError('На этой картинке не найден QR-код RIFT.');
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  return (
    <div className="qr-scanner">
      <button className="modal-close" onClick={onCancel}><X size={20} /></button>
      <div className="scanner-title"><Camera size={18} /><strong>{title}</strong></div>
      <div className="scanner-frame"><video ref={videoRef} autoPlay muted playsInline /><span /><span /><span /><span /></div>
      <p>Наведи камеру на QR-код на экране друга.</p>
      <label className="image-scan-button"><ImagePlus size={17} /> Выбрать QR-картинку<input type="file" accept="image/*" onChange={scanImage} /></label>
      {error && <div className="error-banner">{error}</div>}
    </div>
  );
}
