// Minimal accessible modal overlay.
import { el } from './dom';

export interface Modal {
  overlay: HTMLElement;
  body: HTMLElement;
  close: () => void;
}

export function openModal(title: string, wide = false): Modal {
  const body = el('div', { class: 'modal-body' });
  const closeBtn = el('button', {
    class: 'modal-close',
    'aria-label': 'Close',
    title: 'Close',
  }, ['×']);
  const card = el('div', { class: `modal-card${wide ? ' modal-wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, [
    el('div', { class: 'modal-head' }, [
      el('h2', { class: 'modal-title' }, [title]),
      closeBtn,
    ]),
    body,
  ]);
  const overlay = el('div', { class: 'modal-overlay' }, [card]);

  const close = (): void => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  closeBtn.addEventListener('click', close);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  return { overlay, body, close };
}
