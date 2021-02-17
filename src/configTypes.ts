import { PlatformIdentifier, PlatformName } from 'homebridge';

export type LighthousePlatformConfig = {
  platform: PlatformName | PlatformIdentifier;
  name?: string;
  lighthouses?: Array<string>;
  retries?: number;
  scanTimeout?: number;
  bleTimeout?: number;
  updateFrequency?: number;
};