// One-off: regenerate assets/notification-icon.png as a transparent-background
// white silhouette (phone + signal waves) so Android renders a clean monochrome
// status-bar icon instead of a solid blob from the old opaque blue bitmap.
//
// Strategy: the source art is a white glyph on a blue gradient. We keep every
// pixel white and derive its alpha from how "white" it already is (the red
// channel is ~255 on the glyph and much lower on the blue background), then
// hard-threshold to drop the background entirely.
const path = require('path');
const Jimp = require('jimp-compact');

const SRC = path.resolve(__dirname, '../assets/notification-icon.png');

(async () => {
  const img = await Jimp.read(SRC);
  img.scan(0, 0, img.bitmap.width, img.bitmap.height, function (x, y, idx) {
    const r = this.bitmap.data[idx + 0];
    const g = this.bitmap.data[idx + 1];
    const b = this.bitmap.data[idx + 2];
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    const sat = maxC - minC; // 0 for grey/white, large for the blue/cyan bg
    // Keep ONLY near-white pixels (the glyph). Any coloured pixel — including
    // the bright cyan gradient streak — is dropped so the alpha mask is a clean
    // monochrome silhouette. Alpha is driven by brightness for smooth edges.
    // The flat royal-blue background and the bright cyan gradient streak are
    // both highly saturated (max-min large) and get dropped. The glyph is pure
    // white (sat 0) and the signal waves are light blue (low saturation, very
    // bright), so both survive. Alpha ramps with brightness for clean edges.
    let alpha = 0;
    if (sat <= 95 && minC >= 110) {
      alpha = Math.min(255, Math.round((minC - 110) * (255 / (255 - 110))));
    }
    this.bitmap.data[idx + 0] = 255;
    this.bitmap.data[idx + 1] = 255;
    this.bitmap.data[idx + 2] = 255;
    this.bitmap.data[idx + 3] = alpha;
  });
  await img.writeAsync(SRC);
  console.log('wrote transparent silhouette ->', SRC);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
