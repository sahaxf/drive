import { CanvasTexture, ClampToEdgeWrapping, RepeatWrapping, SRGBColorSpace } from 'three';

/**
 * Procedural canvas textures for the track. Cheap to make, nothing to download, and
 * good enough until real material sets land in the visual pass (M6).
 */

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return [c, c.getContext('2d')!];
}

function speckle(ctx: CanvasRenderingContext2D, width: number, height: number, amount: number): void {
  const image = ctx.getImageData(0, 0, width, height);
  for (let i = 0; i < image.data.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    image.data[i] = image.data[i]! + n;
    image.data[i + 1] = image.data[i + 1]! + n;
    image.data[i + 2] = image.data[i + 2]! + n;
  }
  ctx.putImageData(image, 0, 0);
}

function finish(texture: CanvasTexture, anisotropy: number, colour = true): CanvasTexture {
  texture.wrapS = texture.wrapT = RepeatWrapping;
  if (colour) texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

/** u = across the road (0 left edge, 1 right edge), v = along it. */
export function asphaltTexture(anisotropy: number): CanvasTexture {
  const [w, h] = [256, 512];
  const [c, ctx] = canvas(w, h);
  ctx.fillStyle = '#3c3f42';
  ctx.fillRect(0, 0, w, h);
  // Darker, polished bands where the tyres run.
  for (const centre of [0.3, 0.7]) {
    const g = ctx.createLinearGradient((centre - 0.12) * w, 0, (centre + 0.12) * w, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, 'rgba(0,0,0,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect((centre - 0.12) * w, 0, 0.24 * w, h);
  }
  speckle(ctx, w, h, 30);
  ctx.fillStyle = '#e8e6df';
  ctx.fillRect(0.012 * w, 0, 0.022 * w, h);
  ctx.fillRect(0.966 * w, 0, 0.022 * w, h);
  const texture = finish(new CanvasTexture(c), anisotropy);
  texture.wrapS = ClampToEdgeWrapping;
  return texture;
}

export function grassTexture(anisotropy: number): CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#5f7d34';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2500; i++) {
    const light = Math.random() < 0.5;
    ctx.fillStyle = light ? 'rgba(160,190,90,0.25)' : 'rgba(30,50,15,0.25)';
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 1 + Math.random() * 2, 2 + Math.random() * 5);
  }
  speckle(ctx, 256, 256, 18);
  return finish(new CanvasTexture(c), anisotropy);
}

/** Red/white blocks: one block per metre with a 2 m tile. */
export function kerbTexture(anisotropy: number): CanvasTexture {
  const [c, ctx] = canvas(64, 128);
  ctx.fillStyle = '#d8231d';
  ctx.fillRect(0, 0, 64, 64);
  ctx.fillStyle = '#f1f1ee';
  ctx.fillRect(0, 64, 64, 64);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(56, 0, 8, 128);
  speckle(ctx, 64, 128, 14);
  return finish(new CanvasTexture(c), anisotropy);
}

export function checkerTexture(anisotropy: number): CanvasTexture {
  const [c, ctx] = canvas(64, 64);
  for (let y = 0; y < 2; y++) {
    for (let x = 0; x < 2; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? '#f2f2f2' : '#151515';
      ctx.fillRect(x * 32, y * 32, 32, 32);
    }
  }
  const texture = finish(new CanvasTexture(c), anisotropy);
  texture.repeat.set(6, 1);
  return texture;
}

/** Grey noise multiplied over terrain vertex colours for close-up detail. */
export function groundDetailTexture(anisotropy: number): CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#d6d6d6';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 1800; i++) {
    const v = 150 + Math.random() * 105;
    ctx.fillStyle = `rgba(${v},${v},${v},0.5)`;
    const s = 1 + Math.random() * 4;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, s, s);
  }
  speckle(ctx, 256, 256, 40);
  return finish(new CanvasTexture(c), anisotropy);
}

/**
 * Grey canopy blobs multiplied over the far slopes: from a distance, dark forest reads
 * as tree crowns rather than flat paint.
 */
export function canopyTexture(anisotropy: number): CanvasTexture {
  const [c, ctx] = canvas(256, 256);
  ctx.fillStyle = '#9a9a9a';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 420; i++) {
    const x = Math.random() * 256;
    const y = Math.random() * 256;
    const r = 5 + Math.random() * 9;
    const v = 170 + Math.random() * 85;
    // Draw wrapped copies so the tile repeats seamlessly.
    for (const [dx, dy] of [[0, 0], [256, 0], [-256, 0], [0, 256], [0, -256]] as const) {
      const g = ctx.createRadialGradient(x + dx - r * 0.3, y + dy - r * 0.3, 0, x + dx, y + dy, r);
      g.addColorStop(0, `rgb(${v},${v},${v})`);
      g.addColorStop(1, `rgba(${v},${v},${v},0)`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return finish(new CanvasTexture(c), anisotropy, false);
}

export function bannerTexture(text: string, anisotropy: number): CanvasTexture {
  const [c, ctx] = canvas(1024, 128);
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, '#1b2433');
  g.addColorStop(1, '#0b0f17');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 1024, 128);
  ctx.fillStyle = '#ffb400';
  ctx.fillRect(0, 0, 1024, 8);
  ctx.fillRect(0, 120, 1024, 8);
  ctx.font = 'italic 76px "Russo One", "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, 512, 68);
  const texture = finish(new CanvasTexture(c), anisotropy);
  texture.wrapS = texture.wrapT = ClampToEdgeWrapping;
  return texture;
}
