/** Shared preview frame sizes — aspect-ratio driven (no fixed square lg boxes). */
export function previewFrameClass(aspectRatio) {
  const base =
    'relative bg-black rounded-xl overflow-hidden mx-auto shrink-0 ring-1 w-full max-w-full';

  switch (aspectRatio) {
    case '1:1':
      return `${base} ring-white/10 aspect-square max-w-[min(100%,520px)] max-h-[min(72dvh,520px)]`;
    case '16:9':
      return `${base} ring-violet-500/20 aspect-video max-w-[min(100%,920px)] max-h-[min(56dvh,520px)]`;
    default:
      return `${base} ring-white/10 aspect-[9/16] max-w-[min(100%,calc(72dvh*9/16),360px)] sm:max-w-[min(100%,400px)] lg:max-w-[min(100%,440px)] max-h-[min(78dvh,780px)]`;
  }
}

export function previewVideoClass(aspectRatio) {
  return aspectRatio === '9:16' ? 'w-full h-full object-cover' : 'w-full h-full object-contain bg-black';
}
