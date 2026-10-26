import './controller.css';
// Subpath imports keep the shared package's zod schemas out of the phone bundle.
import {
  angleDiffDeg,
  DEFAULT_STEERING,
  isRoomCode,
  OneEuroFilter,
  shapeSteering,
  type SteeringConfig,
} from '@drivee/shared/controller';
import { Button } from '@drivee/shared/input';
import { PadLink, type LinkState } from './PadLink';
import { pedalValue } from './pedal';
import { TiltSensor } from './tilt';

/**
 * Phone controller: tilt to steer, right half of the screen is the throttle, left half
 * the brake, buttons along the top. No Three.js here; it has to load fast on a phone.
 */

const SEND_INTERVAL_MS = 1000 / 60;
const ROOM_KEY = 'drivee.room';
// Versioned so improved defaults reach phones that saved the old ones.
const SETTINGS_KEY = 'drivee.steering.v4';

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const $$ = <T extends HTMLElement = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)];

type ScreenName = 'connect' | 'calibrate' | 'drive';
let screenName: ScreenName = 'connect';
function show(name: ScreenName): void {
  screenName = name;
  for (const s of ['connect', 'calibrate', 'drive'] as const) $(`#${s}`).hidden = s !== name;
}

// --- Steering --------------------------------------------------------------------------

let steering = loadSettings();
let rawAngle: number | null = null;
let centre = 0;
let tilt = 0;
let steer = 0;
const filter = new OneEuroFilter();
const tiltSensor = new TiltSensor((angle, dt) => {
  rawAngle = angle;
  tilt = filter.filter(angleDiffDeg(angle, centre), dt);
  steer = shapeSteering(tilt, steering);
});

function recentre(): void {
  if (rawAngle === null) return;
  centre = rawAngle;
  filter.reset();
  tilt = 0;
  steer = 0;
}

// --- Pedals ----------------------------------------------------------------------------

type Pedal = 'brake' | 'throttle';
const pedals: Record<Pedal, number> = { brake: 0, throttle: 0 };
/** Each finger on a pedal zone and how hard it is pressing. */
const fingers = new Map<number, { pedal: Pedal; value: number }>();

for (const zone of $$('[data-zone]')) {
  const pedal = zone.dataset['zone'] as Pedal;
  const press = (e: PointerEvent) => {
    const rect = zone.getBoundingClientRect();
    fingers.set(e.pointerId, { pedal, value: pedalValue((e.clientY - rect.top) / rect.height) });
    updatePedals();
  };
  zone.addEventListener('pointerdown', (e) => {
    zone.setPointerCapture(e.pointerId);
    press(e);
  });
  zone.addEventListener('pointermove', (e) => {
    if (fingers.has(e.pointerId)) press(e);
  });
  const release = (e: PointerEvent) => {
    fingers.delete(e.pointerId);
    updatePedals();
  };
  zone.addEventListener('pointerup', release);
  zone.addEventListener('pointercancel', release);
}

function updatePedals(): void {
  pedals.brake = 0;
  pedals.throttle = 0;
  for (const f of fingers.values()) pedals[f.pedal] = Math.max(pedals[f.pedal], f.value);
}

// --- Buttons ---------------------------------------------------------------------------

const BUTTON_BITS: Record<string, number> = { camera: Button.Camera, reset: Button.Reset, pause: Button.Pause };
let heldButtons = 0;
/** Pressed since the last packet: a tap shorter than one send interval still gets through. */
let tappedButtons = 0;
let handbrake = false;

for (const el of $$('[data-button]')) {
  const name = el.dataset['button']!;
  const set = (down: boolean) => {
    el.classList.toggle('down', down);
    if (name === 'handbrake') {
      handbrake = down;
      return;
    }
    const bit = BUTTON_BITS[name] ?? 0;
    if (down) {
      heldButtons |= bit;
      tappedButtons |= bit;
    } else {
      heldButtons &= ~bit;
    }
  };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    set(true);
    vibrate([8]);
  });
  el.addEventListener('pointerup', () => set(false));
  el.addEventListener('pointercancel', () => set(false));
}

$('[data-action="centre"]').addEventListener('click', () => {
  recentre();
  vibrate([15]);
});

// --- Settings --------------------------------------------------------------------------

/** Settings pause the game while open (and resume it after, if it was us). */
let gamePaused = false;
let pausedForSettings = false;

const sliders = {
  lock: { input: $<HTMLInputElement>('#lock'), out: $('#lock-out'), key: 'maxLockDeg' },
  dead: { input: $<HTMLInputElement>('#dead'), out: $('#dead-out'), key: 'deadzoneDeg' },
  curve: { input: $<HTMLInputElement>('#curve'), out: $('#curve-out'), key: 'curve' },
} as const;
for (const { input, out, key } of Object.values(sliders)) {
  input.value = String(steering[key]);
  out.textContent = input.value;
  input.addEventListener('input', () => {
    steering = { ...steering, [key]: Number(input.value) };
    out.textContent = input.value;
    saveSettings(steering);
  });
}

$('[data-action="settings"]').addEventListener('click', () => {
  $('#settings').hidden = false;
  if (!gamePaused) {
    tappedButtons |= Button.Pause;
    pausedForSettings = true;
  }
});
$('[data-action="close-settings"]').addEventListener('click', () => {
  $('#settings').hidden = true;
  if (pausedForSettings && gamePaused) tappedButtons |= Button.Pause;
  pausedForSettings = false;
});

function loadSettings(): SteeringConfig {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null') as Partial<SteeringConfig> | null;
    return { ...DEFAULT_STEERING, ...saved };
  } catch {
    return { ...DEFAULT_STEERING };
  }
}

function saveSettings(config: SteeringConfig): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(config));
  } catch {
    // Private mode: settings just don't persist.
  }
}

// --- Connection ------------------------------------------------------------------------

let link: PadLink | null = null;
let sensorSource = '';
let room = '';
let rttMs: number | null = null;

function linkText(state: LinkState): string {
  switch (state) {
    case 'connecting':
      return 'Connecting…';
    case 'waiting-for-game':
      return `Waiting for the game (room ${room})`;
    case 'connected':
      return rttMs === null ? 'Connected' : `Connected · ${rttMs} ms`;
    case 'replaced':
      return 'Another phone took over this game';
  }
}

function renderLink(): void {
  if (!link) return;
  const text = linkText(link.state);
  const bad = link.state !== 'connected';
  for (const el of [$('#link'), $('#sensor-note')]) {
    el.textContent = text;
    el.classList.toggle('bad', bad);
  }
  $('#sensor-note').textContent = `${text} · tilt: ${sensorSource}`;
}

// --- Start -----------------------------------------------------------------------------

const roomInput = $<HTMLInputElement>('#room');
roomInput.value = (new URLSearchParams(location.search).get('room') ?? safeGet(ROOM_KEY) ?? '').toUpperCase();
roomInput.addEventListener('input', () => {
  roomInput.value = roomInput.value.toUpperCase();
});

if (!window.isSecureContext) {
  note('This page needs HTTPS for the motion sensors. Open the https:// address shown on the game screen.', true);
}

$('#start').addEventListener('click', async () => {
  room = roomInput.value.trim().toUpperCase();
  if (!isRoomCode(room)) {
    note('Enter the 4-character room code shown on the game screen.', true);
    return;
  }
  safeSet(ROOM_KEY, room);
  document.body.classList.add('started');

  // These all need the tap we're handling, and all are optional.
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    await (screen.orientation as ScreenOrientation & { lock?(o: string): Promise<void> }).lock?.('landscape');
  } catch {
    // Desktop browsers, or fullscreen refused: still playable.
  }
  void requestWakeLock();
  vibrate([1]);

  const source = await tiltSensor.start();
  sensorSource =
    source === 'gravity' ? 'gravity sensor' : 'motion fallback (noisier: Chrome may be blocking the gravity sensor)';

  link = new PadLink(room, {
    onState: renderLink,
    onStatus: (rtt, paused) => {
      rttMs = rtt;
      gamePaused = paused;
      $('#paused-badge').hidden = !paused;
      renderLink();
    },
    onBuzz: vibrate,
  });
  link.connect();
  renderLink();
  show('calibrate');
});

$('#calibrate').addEventListener('click', () => {
  if (rawAngle === null) {
    $('#sensor-note').textContent = 'No tilt readings yet. Is motion sensor access blocked for this site?';
    $('#sensor-note').classList.add('bad');
    return;
  }
  recentre();
  vibrate([15]);
  show('drive');
});

let wakeLock: WakeLockSentinel | null = null;
async function requestWakeLock(): Promise<void> {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch {
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', () => {
  // The browser drops the wake lock whenever the page is hidden.
  if (document.visibilityState === 'visible' && document.body.classList.contains('started') && (!wakeLock || wakeLock.released)) {
    void requestWakeLock();
  }
});

// --- Loops -----------------------------------------------------------------------------

setInterval(() => {
  if (screenName !== 'drive' || !link) return;
  const settingsOpen = !$('#settings').hidden;
  link.sendInput({
    // While settings are open the phone isn't being held as a wheel.
    steer: settingsOpen ? 0 : steer,
    throttle: settingsOpen ? 0 : pedals.throttle,
    brake: settingsOpen ? 0 : pedals.brake,
    handbrake,
    buttons: heldButtons | tappedButtons,
  });
  tappedButtons = 0;
}, SEND_INTERVAL_MS);

const wheels = $$('[data-wheel]');
const steerFill = $('#steer-fill');
const fills = { brake: $('.brake .zone-fill'), throttle: $('.throttle .zone-fill') };
function frame(): void {
  const angle = Math.max(-90, Math.min(90, tilt));
  for (const w of wheels) w.style.transform = `rotate(${angle}deg)`;
  steerFill.style.left = `${50 + Math.min(steer, 0) * 50}%`;
  steerFill.style.width = `${Math.abs(steer) * 50}%`;
  steerFill.style.transform = 'none';
  fills.brake.style.transform = `scaleY(${pedals.brake})`;
  fills.throttle.style.transform = `scaleY(${pedals.throttle})`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// --- Helpers ---------------------------------------------------------------------------

function vibrate(pattern: number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Not allowed before the first tap: ignore.
  }
}

function note(text: string, bad = false): void {
  const el = $('#connect-note');
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignore.
  }
}
