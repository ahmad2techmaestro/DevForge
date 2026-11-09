import { AnimatePresence, motion } from 'framer-motion';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import { useUi } from '../../store/ui';

const icons = {
  success: <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden />,
  error: <AlertCircle className="h-4 w-4 text-bad" aria-hidden />,
  info: <Info className="h-4 w-4 text-info" aria-hidden />,
};

export function Toaster() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 24 }}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className="glass pointer-events-auto flex items-start gap-3 rounded-xl border border-line-strong p-3 shadow-pop"
          >
            <span className="mt-0.5">{icons[t.tone]}</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{t.title}</p>
              {t.detail && <p className="mt-0.5 break-words text-xs text-muted">{t.detail}</p>}
            </div>
            <button aria-label="Dismiss notification" onClick={() => dismiss(t.id)} className="text-faint hover:text-fg">
              <X className="h-3.5 w-3.5" />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
