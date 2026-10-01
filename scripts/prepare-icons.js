const fs = require("fs");
const path = require("path");
const pngToIco = require("png-to-ico");

async function main() {
  const png = path.join(__dirname, "..", "assets", "icon.png");
  const ico = path.join(__dirname, "..", "assets", "icon.ico");

  if (!fs.existsSync(png)) {
    throw new Error(`Missing icon source: ${png}`);
  }

  const buf = await pngToIco(png);
  fs.writeFileSync(ico, buf);
  console.log(`Created ${ico}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
