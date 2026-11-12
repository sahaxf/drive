import './style.css';
import { Game } from './Game';
import { loadCarIndex, loadCarSpec, loadTrackIndex, loadTrackSpec } from './tracks';
import { HomeScreen } from './ui/HomeScreen';

const viewport = document.getElementById('viewport')!;
const hud = document.getElementById('hud')!;
const loading = document.getElementById('loading')!;

/**
 * `/` shows the home screen; `/?track=<id>&car=<id>` drives that track in that car (the
 * first car when none is given). Switching is a page load, so a running game never has
 * to be torn down.
 */
async function boot(): Promise<void> {
  const [ids, carIds] = await Promise.all([loadTrackIndex(), loadCarIndex()]);
  const params = new URLSearchParams(location.search);
  const requested = params.get('track');
  const car = carIds.find((id) => id === params.get('car')) ?? carIds[0]!;

  if (!requested || !ids.includes(requested)) {
    const [tracks, cars] = await Promise.all([Promise.all(ids.map(loadTrackSpec)), Promise.all(carIds.map(loadCarSpec))]);
    loading.remove();
    new HomeScreen(document.body, tracks, cars, (trackId, carId) => {
      location.search = `?${new URLSearchParams({ track: trackId, car: carId })}`;
    });
    return;
  }

  const name = (await loadTrackSpec(requested)).meta.name;
  loading.textContent = `Loading ${name}`;
  const game = await Game.create(viewport, hud, requested, car, (label) => (loading.textContent = `${name} · ${label}`));
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
