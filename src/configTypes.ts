export type LighthousePlatformConfig = {
  name: string;
  lighthouses: Array<string>;
  scanTimeout: number;
  bleTimeout: number;
  updateFrequency: number;
};