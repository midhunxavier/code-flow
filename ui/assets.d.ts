// Images imported by the UI; build-ui.mjs inlines them as data URLs.
declare module "*.png" {
  const url: string;
  export default url;
}
