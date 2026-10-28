import './style.css';
import { Game } from './Game';
import { loadTrackIndex, loadTrackSpec } from './tracks';
import { HomeScreen } from './ui/HomeScreen';

const viewport = document.getElementById('viewport')!;
const hud = document.getElementById('hud')!;
const loading = document.getElementById('loading')!;

/**
 * `/` shows the home screen; `/?track=<id>` drives that track. Switching is a page load,
 * so a running game never has to be torn down.
 */
async function boot(): Promise<void> {
  const ids = await loadTrackIndex();
  const requested = new URLSearchParams(location.search).get('track');

  if (!requested || !ids.includes(requested)) {
    const tracks = await Promise.all(ids.map(loadTrackSpec));
    loading.remove();
    new HomeScreen(document.body, tracks, (id) => {
      location.search = `?track=${encodeURIComponent(id)}`;
    });
    return;
  }

  const name = (await loadTrackSpec(requested)).meta.name;
  loading.textContent = `Loading ${name}`;
  const game = await Game.create(viewport, hud, requested, (label) => (loading.textContent = `${name} · ${label}`));
  loading.remove();
  game.start();
  // Handle for poking at the game from devtools and automated browser checks.
  if (import.meta.env.DEV) Object.assign(window, { __game: game });
}

boot().catch((error: unknown) => {
  console.error(error);
  loading.textContent = `Failed to start: ${error instanceof Error ? error.message : String(error)}`;
  loading.classList.add('error');
});
