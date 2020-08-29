export type LighthousePlatformConfig = {
  name: string;
  lighthouses: Array<string>;
  retries: number;
  scanTimeout: number;
  bleTimeout: number;
  updateFrequency: number;
};