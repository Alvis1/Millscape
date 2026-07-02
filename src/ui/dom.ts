// Tiny DOM helpers — no framework.
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Labeled number input row. Returns the row plus a setter to re-sync it. */
export function numberField(
  label: string,
  value: number | null,
  onChange: (v: number) => void,
  opts: { min?: number; max?: number; step?: number; unit?: string } = {},
): { row: HTMLElement; set: (v: number) => void; input: HTMLInputElement } {
  const input = el('input', {
    type: 'number',
    class: 'field-input',
    value: value == null ? '' : String(value),
  }) as HTMLInputElement;
  if (opts.min != null) input.min = String(opts.min);
  if (opts.max != null) input.max = String(opts.max);
  if (opts.step != null) input.step = String(opts.step);
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (isFinite(v)) onChange(v);
  });
  const row = el('label', { class: 'field' }, [
    el('span', { class: 'field-label' }, [label]),
    el('span', { class: 'field-inputwrap' }, [
      input,
      ...(opts.unit ? [el('span', { class: 'field-unit' }, [opts.unit])] : []),
    ]),
  ]);
  return { row, set: (v: number) => (input.value = String(v)), input };
}

/** A slider bound to a number input (two-way). */
export function sliderField(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  onInput: (v: number) => void,
  fmt: (v: number) => string = (v) => v.toFixed(0),
): { row: HTMLElement; set: (v: number) => void } {
  const slider = el('input', {
    type: 'range',
    class: 'slider',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
  }) as HTMLInputElement;
  const readout = el('span', { class: 'slider-val' }, [fmt(value)]);
  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    readout.textContent = fmt(v);
    onInput(v);
  });
  const row = el('div', { class: 'sliderrow' }, [
    el('div', { class: 'sliderrow-top' }, [
      el('span', { class: 'field-label' }, [label]),
      readout,
    ]),
    slider,
  ]);
  return {
    row,
    set: (v: number) => {
      slider.value = String(v);
      readout.textContent = fmt(v);
    },
  };
}
