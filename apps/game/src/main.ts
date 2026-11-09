import './style.css';
import { unlockAudio } from './audio/audioContext';
import { Game } from './Game';
import { loadTrackIndex, loadTrackSpec } from './tracks';
import { HomeScreen } from './ui/HomeScreen';

const viewport = document.getElementById('viewport')!;
const hud = document.getElementById('hud')!;
const loading = document.getElementById('loading')!;

/**
 * `/` shows the home screen; `/?track=<id>` drives that track. Choosing a track starts it
 * in place rather than with a page load: the click that chose it is what lets the engine
 * sound play straight away (browsers block audio on a fresh page until a click or key).
 * Leaving a track is still a page load, so a running game never has to be torn down.
 */
async function boot(): Promise<void> {
  const ids = await loadTrackIndex();
  const requested = new URLSearchParams(location.search).get('track');

  if (!requested || !ids.includes(requested)) {
    const tracks = await Promise.all(ids.map(loadTrackSpec));
    loading.remove();
    new HomeScreen(document.body, tracks, (id) => {
      unlockAudio();
      history.pushState(null, '', `?track=${encodeURIComponent(id)}`);
      // Back to the home screen from a game started in place.
      window.addEventListener('popstate', () => location.reload());
      document.body.appendChild(loading);
      startTrack(id).catch(fail);
    });
    return;
  }

  await startTrack(requested);
}

async function startTrack(id: string): Promise<void> {
  const name = (await loadTrackSpec(id)).meta.name;
  loading.textContent = `Loading ${name}`;
  const game = await Game.create(viewport, hud, id, (label) => (loading.textContent = `${name} · ${label}`));
  loading.remove();
  game.start();
  // Handle for poking at the game from devtools and automated browser checks.
  if (import.meta.env.DEV) Object.assign(window, { __game: game });
}

function fail(error: unknown): void {
  console.error(error);
  if (!loading.isConnected) document.body.appendChild(loading);
  loading.textContent = `Failed to start: ${error instanceof Error ? error.message : String(error)}`;
  loading.classList.add('error');
}

boot().catch(fail);
