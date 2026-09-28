/**
 * Ticket Pulse 4 pictograms (public/brand/v4, gpt-image-2.5-sunburst) as
 * drop-in icon components: same { className } contract as a lucide icon, so
 * LightTabBar and friends can take them unchanged.
 */
export function knowledgePictogram(name) {
  function Pictogram({ className = 'h-4 w-4' }) {
    return (
      <img
        src={`/brand/v4/${name}.png`}
        srcSet={`/brand/v4/${name}.png 1x, /brand/v4/${name}@2x.png 2x`}
        alt=""
        aria-hidden="true"
        className={`${className} object-contain`}
      />
    );
  }
  Pictogram.displayName = `KnowledgePictogram(${name})`;
  return Pictogram;
}
