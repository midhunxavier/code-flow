// Imported first by `npm start`'s and `npm run dev`'s scripts: an older Node would otherwise
// fail later with an error that doesn't say why.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`code-flow needs Node.js 22.13 or newer, and this is Node ${process.version}. Install a newer Node (https://nodejs.org), then run this again.`);
  process.exit(1);
}
