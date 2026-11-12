import './style.css';
import type { UserView } from '@drivee/shared';
import { Game } from './Game';
import { AccountClient } from './net/AccountClient';
import { heroShots } from './render/heroShots';
import { loadCarIndex, loadCarSpec, loadTrackIndex, loadTrackSpec } from './tracks';
import { HomeScreen, lastChoice } from './ui/HomeScreen';
import { TitleScreen } from './ui/TitleScreen';

const viewport = document.getElementById('viewport')!;
const hud = document.getElementById('hud')!;
const loading = document.getElementById('loading')!;

/** Query string of the track selection screen, where Play leads. */
const SELECT_SEARCH = '?play';

/**
 * `/` is the title screen (login, then Play); `/?play` picks a track and car;
 * `/?track=<id>&car=<id>` drives that track in that car (the first car when none is
 * given). The last two need a logged-in player and send anyone else back to `/`.
 * Switching is a page load, so a running game never has to be torn down.
 */
async function boot(): Promise<void> {
  const account = new AccountClient();
  const [ids, carIds] = await Promise.all([loadTrackIndex(), loadCarIndex()]);
  const params = new URLSearchParams(location.search);
  const requested = params.get('track');
  const wantsGame = requested !== null && ids.includes(requested);

  if (!wantsGame && !params.has('play')) {
    const choice = lastChoice(ids, carIds);
    const [track, car] = await Promise.all([loadTrackSpec(choice.track), loadCarSpec(choice.car)]);
    loading.remove();
    new TitleScreen(document.body, account, track, car, (onShot) => heroShots(track, car, onShot), () => {
      location.search = SELECT_SEARCH;
    });
    return;
  }

  const user = await account.me();
  if (!user) {
    location.replace(location.pathname);
    return;
  }

  if (!wantsGame) {
    const [tracks, cars] = await Promise.all([Promise.all(ids.map(loadTrackSpec)), Promise.all(carIds.map(loadCarSpec))]);
    loading.remove();
    new HomeScreen(document.body, tracks, cars, bestTimes(user), user.username, (trackId, carId) => {
      location.search = `?${new URLSearchParams({ track: trackId, car: carId })}`;
    });
    return;
  }

  const car = carIds.find((id) => id === params.get('car')) ?? carIds[0]!;
  const name = (await loadTrackSpec(requested)).meta.name;
  loading.textContent = `Loading ${name}`;
  const game = await Game.create(viewport, hud, requested, car, {
    best: user.best[requested]?.time ?? null,
    onLap: (time) => {
      account.recordLap({ track: requested, car, time }).catch((error: unknown) => console.warn('[drivee] lap not saved', error));
    },
    onProgress: (label) => (loading.textContent = `${name} · ${label}`),
  });
  loading.remove();
  game.start();
  // Handle for poking at the game from devtools and automated browser checks.
  if (import.meta.env.DEV) Object.assign(window, { __game: game });
}

function bestTimes(user: UserView): Record<string, number> {
  return Object.fromEntries(Object.entries(user.best).map(([track, lap]) => [track, lap.time]));
}

boot().catch((error: unknown) => {
  console.error(error);
  loading.textContent = `Failed to start: ${error instanceof Error ? error.message : String(error)}`;
  loading.classList.add('error');
});
