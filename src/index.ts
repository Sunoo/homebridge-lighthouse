import {
  API,
  APIEvent,
  CharacteristicValue,
  CharacteristicGetCallback,
  CharacteristicSetCallback,
  DynamicPlatformPlugin,
  HAP,
  Logging,
  PlatformAccessory,
  PlatformAccessoryEvent,
  PlatformConfig
} from 'homebridge';
import noble from '@abandonware/noble';
import { LighthousePlatformConfig } from './configTypes';

let hap: HAP;
let Accessory: typeof PlatformAccessory;

const PLUGIN_NAME = 'homebridge-lighthouse';
const PLATFORM_NAME = 'lighthouse';

const CONTROL_SVC = '000015231212efde1523785feabcd124';
const POWER_CHAR = '000015251212efde1523785feabcd124';
const IDENTIFY_CHAR = '000084211212efde1523785feabcd124';
const OFF_VAL = Buffer.from('00', 'hex');
const ON_VAL = Buffer.from('01', 'hex');

class LighthousePlatform implements DynamicPlatformPlugin {
  private readonly log: Logging;
  private readonly api: API;
  private readonly config: LighthousePlatformConfig;
  private readonly peripherals: Array<noble.Peripheral> = [];
  private readonly cachedAccessories: Array<PlatformAccessory> = [];
  private readonly accessories: Array<PlatformAccessory> = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly scanTimeout: number;
  private readonly bleTimeout: number;
  private readonly updateFrequency: number;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log = log;
    this.config = config as unknown as LighthousePlatformConfig;
    this.api = api;

    this.scanTimeout = (this.config.scanTimeout || 10) * 1000;
    this.bleTimeout = (this.config.bleTimeout || 1) * 1000;
    this.updateFrequency = (this.config.updateFrequency || 60) * 1000;

    api.on(APIEvent.DID_FINISH_LAUNCHING, this.didFinishLaunching.bind(this));
  }

  powerLighthouse(peripheral: noble.Peripheral, on: boolean): Promise<void> {
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject('Write attempt timed out.');
      }, this.bleTimeout);
    });
    const realPromise = peripheral.connectAsync()
      .then(() => {
        return peripheral.discoverSomeServicesAndCharacteristicsAsync([CONTROL_SVC], [POWER_CHAR]);
      })
      .then(({characteristics}) => {
        return characteristics[0].writeAsync(on ? ON_VAL : OFF_VAL, false);
      });
    return Promise.race([timeoutPromise, realPromise])
      .finally(() => {
        peripheral.disconnectAsync();
      });
  }

  statusLighthouse(peripheral: noble.Peripheral): Promise<boolean> {
    const timeoutPromise = new Promise<boolean>((_, reject) => {
      setTimeout(() => {
        reject('Read attempt timed out.');
      }, this.bleTimeout);
    });
    const realPromise = peripheral.connectAsync()
      .then(() => {
        return peripheral.discoverSomeServicesAndCharacteristicsAsync([CONTROL_SVC], [POWER_CHAR]);
      })
      .then(({characteristics}) => {
        return characteristics[0].readAsync();
      })
      .then((power) => {
        return !power.equals(OFF_VAL);
      });
    return Promise.race([timeoutPromise, realPromise])
      .finally(() => {
        peripheral.disconnectAsync();
      });
  }

  identifyLighthouse(peripheral: noble.Peripheral): Promise<void> {
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => {
        reject('Identify attempt timed out.');
      }, this.bleTimeout);
    });
    const realPromise = peripheral.connectAsync()
      .then(() => {
        return peripheral.discoverSomeServicesAndCharacteristicsAsync([CONTROL_SVC], [IDENTIFY_CHAR]);
      })
      .then(({characteristics}) => {
        return characteristics[0].writeAsync(ON_VAL, false);
      });
    return Promise.race([timeoutPromise, realPromise])
      .finally(() => {
        peripheral.disconnectAsync();
      });
  }

  didFinishLaunching(): void {
    noble.on('warning', (message: string) => this.log.warn(message));
    noble.on('scanStart', () => this.log('Scanning for Lighthouses...'));
    noble.on('scanStop',  () => this.log('Scanning complete'));

    noble.startScanning();

    setTimeout(() => {
      noble.stopScanning();

      this.peripherals.forEach(async(curPer) => {
        await this.getUpdate(curPer);
      });

      const badAccessories = this.accessories.filter((curAcc) => {
        return !this.peripherals.find((curPer) => {
          return curPer.advertisement.localName == curAcc.displayName;
        });
      });
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, badAccessories);
    }, this.scanTimeout);

    noble.on('discover', async(peripheral) => {
      if (peripheral.advertisement.localName?.startsWith('LHB-')) {
        this.log('Found ' + peripheral.advertisement.localName);
        this.peripherals.push(peripheral);
        this.setupAccessory(peripheral);
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cachedAccessories.push(accessory);
  }

  setupAccessory(peripheral: noble.Peripheral): void {
    let accessory = this.cachedAccessories.find(cachedAccessory => {
      return cachedAccessory.displayName == peripheral.advertisement.localName;
    });

    if (!accessory) {
      const uuid = hap.uuid.generate(peripheral.advertisement.localName);
      accessory = new Accessory(peripheral.advertisement.localName, uuid);

      accessory.addService(hap.Service.Switch);

      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    }

    this.accessories.push(accessory);

    accessory.on(PlatformAccessoryEvent.IDENTIFY, () => {
      if (peripheral && accessory) {
        this.log('Identifying ' + accessory.displayName + '...');
        this.identifyLighthouse(peripheral)
          .then(() => {
            accessory?.getService(hap.Service.Switch)?.updateCharacteristic(hap.Characteristic.On, true);
          })
          .catch((error) => {
            this.log.error(peripheral.advertisement.localName + ': ' + error);
          });
      }
    });

    accessory.getService(hap.Service.Switch)?.getCharacteristic(hap.Characteristic.On)
      .on('set', (state: CharacteristicValue, callback: CharacteristicSetCallback) => {
        this.log('Turning ' + peripheral.advertisement.localName + (state ? ' on...' : ' off...'));
        this.powerLighthouse(peripheral, state as boolean)
          .then(() => {
            callback();
          })
          .catch((error) => {
            callback(error);
            this.log.error(peripheral.advertisement.localName + ': ' + error);
          });
      })
      .on('get', (callback: CharacteristicGetCallback) => {
        this.getUpdate(peripheral, callback);
      });

    const accInfo = accessory.getService(hap.Service.AccessoryInformation);
    if (accInfo) {
      accInfo
        .setCharacteristic(hap.Characteristic.Manufacturer, 'Valve Corporation')
        .setCharacteristic(hap.Characteristic.Model, 'Lighthouse 2.0')
        .setCharacteristic(hap.Characteristic.SerialNumber, peripheral.advertisement.localName);
    }
  }

  getUpdate(peripheral: noble.Peripheral, callback?: CharacteristicGetCallback): Promise<void> {
    const timer = this.timers.get(peripheral.advertisement.localName);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(peripheral.advertisement.localName);
    }
    return this.statusLighthouse(peripheral)
      .then((isOn) => {
        if (callback) {
          callback(undefined, isOn);
        } else {
          const accessory = this.accessories.find((curAcc) => {
            return curAcc.displayName == peripheral.advertisement.localName;
          });
          accessory?.getService(hap.Service.Switch)?.updateCharacteristic(hap.Characteristic.On, isOn);
        }
      })
      .catch((error) => {
        if (callback) {
          callback(error);
          this.log.error(peripheral.advertisement.localName + ': ' + error);
        } else {
          this.log.debug(peripheral.advertisement.localName + ': ' + error);
        }
      })
      .finally(() => {
        const timer = setTimeout(() => {
          this.getUpdate(peripheral);
        }, this.updateFrequency);
        this.timers.set(peripheral.advertisement.localName, timer);
      });
  }
}

export = (api: API): void => {
  hap = api.hap;
  Accessory = api.platformAccessory;

  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, LighthousePlatform);
};