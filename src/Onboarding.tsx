import { ArrowRight, Download, KeyRound, Laptop, Link2, Radio, X } from 'lucide-react';

type OnboardingProps = {
  onClose: () => void;
  onConnect: () => void;
};

export function Onboarding({ onClose, onConnect }: OnboardingProps) {
  const desktop = Boolean(window.riftDesktop) || '__TAURI_INTERNALS__' in window;

  return (
    <div className="modal-backdrop onboarding-backdrop">
      <section className="onboarding-card">
        <button className="modal-close" onClick={onClose} aria-label="Закрыть"><X size={20} /></button>
        <div className="onboarding-brand"><Radio size={16} /> RIFT / QUICKSTART</div>
        <h2>Не localhost.<br /><span>Два отдельных устройства.</span></h2>
        <p className="onboarding-lead">
          {desktop
            ? 'Ты уже в приложении. Другу нужна такая же копия RIFT на его компьютере.'
            : 'Сейчас открыта версия для разработки. Для связи через интернет оба пользователя запускают отдельное приложение RIFT.'}
        </p>

        <div className="onboarding-steps">
          <div><span>01</span><Laptop /><strong>Запустите RIFT</strong><p>Каждый на своём компьютере. Общий сайт или один localhost не нужен.</p></div>
          <div><span>02</span><KeyRound /><strong>Создай приглашение</strong><p>RIFT подготовит одноразовый код прямого соединения.</p></div>
          <div><span>03</span><Link2 /><strong>Обменяйтесь кодами</strong><p>Пока отправьте коды через любой существующий чат. После связки всё идёт напрямую.</p></div>
        </div>

        <div className="onboarding-note"><Download size={16} /><span>Windows-установщик собирается локально и не требует аренды сервера.</span></div>
        <div className="onboarding-actions">
          <button className="secondary-action" onClick={onClose}>Понятно</button>
          <button className="primary-action" onClick={onConnect}>Связать устройства <ArrowRight size={15} /></button>
        </div>
      </section>
    </div>
  );
}
