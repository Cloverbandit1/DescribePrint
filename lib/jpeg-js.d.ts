declare module "jpeg-js" {
  export function decode(
    jpegData: Buffer | Uint8Array,
    opts?: {
      useTArray?: boolean;
      formatAsRGBA?: boolean;
      maxResolutionInMP?: number;
      maxMemoryUsageInMB?: number;
    },
  ): { width: number; height: number; data: Buffer | Uint8Array };

  export function encode(
    imgData: { data: Buffer | Uint8Array; width: number; height: number },
    quality?: number,
  ): { data: Buffer; width: number; height: number };
}
