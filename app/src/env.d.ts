declare const __HOSTED__: boolean;
declare module "*.css";
declare module "*.png" {
  const src: string;
  export default src;
}
