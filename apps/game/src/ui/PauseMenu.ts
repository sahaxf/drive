import { MenuModel, type MenuAction, type MenuItem } from './menu';

/**
 * The pause screen: a short list of actions and settings. Works with the mouse, the
 * keyboard (Enter and each row's shortcut here; arrows arrive as driving input) and, through
 * {@link handle}, whatever the car is being driven with.
 */
export class PauseMenu {
  private readonly root: HTMLElement;
  private readonly reason: HTMLElement;
  private readonly rows: { button: HTMLElement; value: HTMLElement; shown: string }[] = [];
  private readonly model: MenuModel;
  private open = false;

  constructor(parent: HTMLElement, items: MenuItem[]) {
    this.model = new MenuModel(items);
    this.root = document.createElement('div');
    this.root.className = 'pause';
    this.root.innerHTML = `
      <div class="pause-title">Paused</div>
      <small class="pause-reason"></small>
      <div class="pause-list" role="menu"></div>
      <div class="hud-label pause-hint">↑ ↓ Select · ← → Change · Enter / Handbrake Choose</div>
    `;
    this.reason = this.root.querySelector<HTMLElement>('.pause-reason')!;
    const list = this.root.querySelector<HTMLElement>('.pause-list')!;
    items.forEach((item, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pause-item';
      button.setAttribute('role', 'menuitem');
      const label = document.createElement('span');
      label.textContent = item.label;
      const value = document.createElement('span');
      value.className = 'pause-value';
      button.append(label, value);
      button.addEventListener('mouseenter', () => {
        this.model.select(index);
        this.refresh();
      });
      button.addEventListener('click', () => {
        this.model.activate(index);
        this.refresh();
      });
      list.appendChild(button);
      this.rows.push({ button, value, shown: '' });
    });
    parent.appendChild(this.root);

    window.addEventListener('keydown', (e) => {
      if (!this.open || e.repeat) return;
      if (e.code === 'Enter' || e.code === 'NumpadEnter') this.model.activate();
      else if (!this.model.shortcut(e.code)) return;
      e.preventDefault();
      this.refresh();
    });
  }

  /** Show or hide the menu. `reason` says why the game paused itself, if it did. */
  setOpen(open: boolean, reason = ''): void {
    if (open && !this.open) this.model.select(0);
    this.open = open;
    this.root.classList.toggle('open', open);
    this.reason.textContent = reason;
    if (open) this.refresh();
  }

  /** A menu action from the driving controls. */
  handle(action: MenuAction): void {
    if (!this.open) return;
    if (action === 'up') this.model.move(-1);
    else if (action === 'down') this.model.move(1);
    else if (action === 'left') this.model.adjust(-1);
    else if (action === 'right') this.model.adjust(1);
    else this.model.activate();
    this.refresh();
  }

  /** Bring the rows up to date (values can also change from outside the menu). */
  refresh(): void {
    this.model.items.forEach((item, index) => {
      const row = this.rows[index]!;
      row.button.classList.toggle('selected', index === this.model.selected);
      const text = item.value?.() ?? '';
      if (text !== row.shown) row.value.textContent = row.shown = text;
    });
  }
}
