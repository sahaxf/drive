import './style.css';
import { Game } from './Game';

const viewport = document.getElementById('viewport')!;
const hud = document.getElementById('hud')!;
const loading = document.getElementById('loading')!;

Game.create(viewport, hud, (label) => (loading.textContent = label))
  .then((game) => {
    loading.remove();
    game.start();
    // Handle for poking at the game from devtools and automated browser checks.
    if (import.meta.env.DEV) Object.assign(window, { __game: game });
  })
  .catch((error: unknown) => {
    console.error(error);
    loading.textContent = `Failed to start: ${error instanceof Error ? error.message : String(error)}`;
    loading.classList.add('error');
  });
