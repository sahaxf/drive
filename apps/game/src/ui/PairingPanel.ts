import { renderSVG } from 'uqr';
import type { PhoneStatus } from '../input/PhoneInput';

/**
 * Corner panel for pairing the phone: QR code, room code and address. Shrinks to a small
 * "connected" badge once the phone is driving. Keyboard and gamepad keep working meanwhile.
 */
export class PairingPanel {
  private readonly root: HTMLElement;
  private readonly qr: HTMLElement;
  private readonly code: HTMLElement;
  private readonly url: HTMLAnchorElement;
  private readonly next: HTMLButtonElement;
  private readonly state: HTMLElement;
  private urlIndex = 0;
  private shownUrl = '';
  private lastKey = '';

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'pair';
    this.root.innerHTML = `
      <div class="pair-title">Drive with your phone</div>
      <div class="pair-qr" data-el="qr"></div>
      <div class="pair-code">Room <b data-el="code">····</b></div>
      <a class="pair-url" data-el="url" target="_blank" rel="noreferrer"></a>
      <button class="pair-next" data-el="next" type="button">Wrong address? Try next</button>
      <div class="pair-state" data-el="state"></div>
      <div class="pair-hint">Same Wi-Fi · Android Chrome · accept the certificate warning</div>
    `;
    const el = <T extends HTMLElement>(name: string) => this.root.querySelector<T>(`[data-el="${name}"]`)!;
    this.qr = el('qr');
    this.code = el('code');
    this.url = el<HTMLAnchorElement>('url');
    this.next = el<HTMLButtonElement>('next');
    this.state = el('state');
    this.next.addEventListener('click', () => {
      this.urlIndex++;
      this.lastKey = '';
    });
    parent.appendChild(this.root);
  }

  update(status: PhoneStatus): void {
    const mode = status.driving ? 'driving' : status.paired ? 'paired' : status.online ? 'waiting' : 'offline';
    const rtt = status.rttMs === null ? '' : `${Math.round(status.rttMs)}`;
    const key = `${mode}|${status.room}|${status.urls.join()}|${this.urlIndex}|${rtt}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    this.root.dataset['mode'] = mode;
    this.code.textContent = status.room ?? '····';
    const url = status.urls.length > 0 ? status.urls[this.urlIndex % status.urls.length]! : '';
    if (url !== this.shownUrl) {
      this.shownUrl = url;
      this.qr.innerHTML = url ? renderSVG(url, { border: 2, whiteColor: '#fff', blackColor: '#000' }) : '';
      this.url.textContent = url.replace(/^https?:\/\//, '');
      this.url.href = url;
    }
    this.next.hidden = status.urls.length < 2;
    this.state.textContent = {
      offline: 'Controller server unreachable',
      waiting: 'Scan to pair',
      paired: 'Phone connected: hold it level and tap to calibrate',
      driving: `Controller connected${rtt ? ` · ${rtt} ms` : ''}`,
    }[mode];
  }
}
