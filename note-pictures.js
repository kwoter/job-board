// Pictures travel with the private note, including offline copies and exports.
const decoded = new Map();
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_PICTURE_DATA = 3 * 1024 * 1024;

export function loadPicture(picture) {
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(picture.src || '')) return Promise.reject(new Error('Invalid picture'));
  if (!decoded.has(picture.src)) {
    const image = new Image();
    const ready = new Promise((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Could not read this picture'));
    });
    decoded.set(picture.src, { image, ready });
    image.src = picture.src;
  }
  return decoded.get(picture.src).ready;
}

export async function preparePicture(file) {
  if (!file.type.startsWith('image/')) throw new Error('Choose a picture file');
  if (file.size > MAX_SOURCE_BYTES) throw new Error('Choose a picture smaller than 20 MB');
  const url = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Could not read this picture. Try a JPG, PNG or WebP.'));
      image.src = url;
    });
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const surface = document.createElement('canvas');
    surface.width = Math.max(1, Math.round(image.naturalWidth * scale));
    surface.height = Math.max(1, Math.round(image.naturalHeight * scale));
    surface.getContext('2d').drawImage(image, 0, 0, surface.width, surface.height);
    let src = surface.toDataURL('image/webp', .84);
    if (src.length > 650_000) src = surface.toDataURL('image/webp', .65);
    if (src.length > 1_000_000) throw new Error('This picture is too detailed. Try a smaller copy.');
    const picture = { id: crypto.randomUUID(), name: file.name || 'Pasted picture', src, width: surface.width, height: surface.height };
    await loadPicture(picture);
    return picture;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function paintPictures(target, pictures, map, scale) {
  target.save();
  target.globalAlpha = 1;
  const ordered = target.globalCompositeOperation === 'destination-over' ? [...pictures].reverse() : pictures;
  for (const picture of ordered) {
    const image = decoded.get(picture.src)?.image;
    if (!image?.complete || !image.naturalWidth) continue;
    const point = map(picture);
    target.drawImage(image, point.x, point.y, picture.width * scale, picture.height * scale);
  }
  target.restore();
}
